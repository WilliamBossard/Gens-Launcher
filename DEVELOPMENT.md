# Gens-Launcher — Guide de Développement Complet

Ce document décrit l'architecture, le modèle de sécurité, les flux de données et les bonnes pratiques de développement du projet **Gens-Launcher**. Il sert de référence technique (Single Source of Truth) pour tout contributeur ou auditeur de sécurité.

---

## 1. Vue d'Ensemble & Architecture Globale
Gens-Launcher est l'interface utilisateur (GUI) officielle de l'écosystème Gens. Basé sur Electron, il a pour rôle de :
1. Gérer l'authentification sécurisée des joueurs via l'API Microsoft/Xbox.
2. Télécharger, vérifier et lancer le jeu Minecraft (via `gens-core`).
3. Interagir de manière asynchrone avec **Gens-Horizon**, le moteur de synchronisation cloud "headless" de l'écosystème.

L'architecture suit scrupuleusement le modèle natif d'Electron en séparant l'application en deux univers distincts et isolés : le **Processus Principal (Main)** et le **Processus de Rendu (Renderer)**.

---

## 2. Topologie des Composants

### 2.1 Processus Principal (Main)
Il s'exécute dans un contexte Node.js complet. Il a accès au système de fichiers, au réseau bas-niveau et contrôle le cycle de vie de l'application.
- **`main.js`** : Point d'entrée de l'application. Initialise les fenêtres (`BrowserWindow`), met en place la `Content-Security-Policy` (CSP) globale et centralise l'import des modules IPC.
- **`src/main/ipc-auth.js`** : Gère les flux OAuth2 Microsoft (Device Code ou web flow) en s'appuyant sur `prismarine-auth`. Expose les tokens sécurisés pour le Renderer. Il fait également office de proxy sécurisé pour interroger l'API Mojang (Skins/Capes), contournant les restrictions CORS.
- **`src/main/ipc-game.js`** : Moteur de lancement. Prépare les paramètres JVM, télécharge les assets via `gens-core` et utilise `child_process.execFile` pour garantir une exécution exempte d'injections shell.
- **`src/main/ipc-horizon.js`** : Pont de communication exclusif avec `Horizon.exe`.
  - *Intégrité* : Télécharge la signature SHA-256 de la release GitHub officielle et valide l'exécutable Horizon local avant tout lancement. Le hash est mis en cache 2h pour éviter les requêtes réseau répétées.
  - *Sécurité* : Valide les arguments via une **Whitelist** stricte (`--sync`, `--check`, etc.) couplée à un filtre Regex limitant les caractères autorisés.
- **`src/main/ipc-system.js`** : Centralise les interactions OS natives (Rich Presence Discord, archivage, barre des tâches Windows).
- **`src/main/crypto-utils.js`** : Primitives cryptographiques du Main Process. La clé AES-256-GCM est dérivée via **PBKDF2** (100 000 itérations, salt aléatoire 16 bytes stocké dans `.key_salt`). Gère la migration transparente des données chiffrées avec l'ancienne clé SHA-256 simple vers le nouveau format PBKDF2.

### 2.1.1 Écosystème Interne (Gens-Core Components)
Afin de limiter la surface d'attaque et de réduire drastiquement le poids de l'application, l'usage de dépendances tierces est banni au profit d'implémentations maisons 100% natives (in-house) :
- **`discord.js`** : Implémentation native des Named Pipes pour le Discord Rich Presence. Inclut un parseur IPC natif, un système de Timeout, et un limiteur de requêtes (Rate Limiter) robuste. Remplace intégralement `@xhayper/discord-rpc`.
- **`nbt.js`** : Parseur et constructeur binaire natif NBT (utilisant `zlib`). Assure une lecture et écriture sans perte du fichier `servers.dat` de Minecraft. Remplace intégralement `prismarine-nbt`.
- **`auth.js`** : Module natif d'authentification Microsoft (OAuth2 Device Code Flow). Gère les requêtes `login.live.com`, l'échange Xbox Live, le jeton XSTS et l'acquisition du Token Minecraft. Remplace intégralement `prismarine-auth`.

### 2.2 Le Pont de Sécurité (Preload)
- **`preload.js`** : S'exécute dans le Renderer mais conserve un accès à certaines APIs Node.js avant de "fermer" la porte.
  - Expose un objet sécurisé `window.api` au DOM.
  - Implémente le **Bouclier de Sécurité Logiciel** : Ses fonctions `enforceSandbox()` et `enforceReadSandbox()` vérifient mathématiquement tous les chemins pour éviter les attaques `Zip Slip` ou `Path Traversal`. L'écriture est strictement bloquée en dehors de `%AppData%\GensLauncher`.
  - La lecture est restreinte aux répertoires légitimes : `GensLauncher/`, `.minecraft/`, dossiers Java détectés, et `tmp/GensLauncher`. Toute lecture hors-périmètre est bloquée silencieusement (sans log d'erreur pour éviter le bruit).
  - Expose `window.api.copyImageToSandbox(srcPath, destName, subDir?)` : permet à l'UI de demander la copie sécurisée d'une image (fond d'écran, icône d'instance) depuis n'importe quel chemin vers le sandbox. La validation (extension + **signature magique binaire** PNG/JPEG/GIF/WEBP/BMP/ICO) et la copie sont effectuées exclusivement dans le Main Process.

### 2.3 Processus de Rendu (Renderer)
- **`renderer.js` / HTML / CSS** : L'interface Vanilla JS. Ne possède aucun accès à `require()`. Toute interaction système se fait en appelant les canaux asynchrones de `window.api.invoke()`.

---

## 3. Modèle de Sécurité (Security Design)

L'application a été auditée et respecte le principe de la **Défense en Profondeur** :

1. **Context Isolation** : Toujours activé (`contextIsolation: true`). Le prototype Javascript du Renderer est isolé de celui du Main.
2. **IPC Sandboxing** : `sandbox: false` natif est utilisé (nécessaire pour l'accès Node.js du preload), mais compensé par un sandboxing applicatif hyper-strict dans `preload.js`. Seules les lectures dans `.minecraft/` ou les répertoires Java sont tolérées en dehors de `GensLauncher/`.
3. **Architecture CSP à "Double Couche" (Dual-Layer CSP)** :
   - *Couche 1 (main.js)* : L'en-tête HTTP positionne `script-src 'self' 'unsafe-inline'`. `'unsafe-inline'` est conservé car `index.html` utilise des handlers inline (`onclick="..."`). Le gain clé est la suppression de `http://*` : toutes les images et connexions sont limitées à **HTTPS uniquement**.
   - *Couche 2 (index.html)* : La balise `<meta>` du DOM applique la même politique. Les deux couches sont alignées.
   - *Note pour les contributeurs* : La suppression future de `'unsafe-inline'` nécessitera de refactoriser tous les `onclick=""` de `index.html` vers des `addEventListener()`. C'est un chantier planifié.
4. **Chiffrement** : Les tokens d'authentification Microsoft locaux sont chiffrés. Le système privilégie `safeStorage` (Keychain OS natif). S'il n'est pas disponible, un fallback **AES-256-GCM** est utilisé avec une clé dérivée via **PBKDF2** (100 000 itérations, salt dédié de 16 bytes aléatoires stocké dans `.key_salt`). Les données chiffrées avec l'ancien algorithme (SHA-256 simple) sont migrées automatiquement et silencieusement au premier déchiffrement.
5. **Whitelist IPC** : Tous les canaux de communication (send, invoke, receive) sont statiquement listés dans `preload.js`. Toute tentative d'appel hors-liste est rejetée, prévenant l'exploitation de canaux obscurs d'Electron.
6. **HTTPS Uniquement** : Le module `http` n'est pas importé dans `main.js`. La fonction `downloadFile()` rejette tout URL non-HTTPS et applique une liste blanche de domaines autorisés (`github.com`, `mojang.com`, `modrinth.com`, etc.).
7. **Intégrité des images** : Le handler `copy-image-to-sandbox` valide l'extension du fichier ET ses octets magiques (signature binaire). Un fichier `.jpg` avec un contenu malveillant serait rejeté.

---

## 4. Communication IPC (Best Practices)

- **Asynchronisme** : Utilisez toujours `ipcRenderer.invoke` (côté Renderer) et `ipcMain.handle` (côté Main) pour les tâches bloquantes. L'UI ne doit jamais geler.
- **Éviter `sendSync`** : Son usage est strictement réservé aux appels cryptographiques critiques ne pouvant être asynchronisés sans refonte majeure du DOM (ex: le fallback `legacy-decrypt-sync`), bien qu'il faille tendre à sa disparition.

---

## 5. Déploiement et CI/CD

Le Launcher est packagé à l'aide d'`electron-builder` au travers des GitHub Actions.
- **Plateformes cibles** : Windows (`.exe` NSIS) et MacOS (`.dmg`).
- **Signature Code (Code Signing)** : *Non applicable — Gens Launcher est un projet open-source gratuit et ne possède pas de certificat de signature commerciale (EV Code Signing, ~300€/an). Sur Windows, SmartScreen peut afficher un avertissement lors de la première installation. Les utilisateurs peuvent cliquer sur "Plus d'infos" → "Exécuter quand même" pour procéder. Le code source étant entièrement public sur GitHub, tout utilisateur peut auditer et compiler lui-même l'application.*
- **Tests** : L'intégration continue déclenche automatiquement `npm test` pour s'assurer que les primitives cryptographiques et les APIs restent stables avant chaque nouvelle publication sur la branche `main`.
