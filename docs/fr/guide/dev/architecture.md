# Architecture Globale du Système

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Runtime-Electron-blue.svg" alt="Electron" />
  <img src="https://img.shields.io/badge/Node.js-24+-green.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/Modèle-Processus%20Isolés-orange.svg" alt="Processus" />
</div>

Gens-Launcher est l'interface graphique officielle (GUI) de l'écosystème Gens. Conçu sur **Electron**, son rôle principal est d'orchestrer :
1. L'authentification sécurisée des joueurs via l'API Microsoft / Xbox.
2. Le téléchargement, la vérification d'intégrité et le lancement du jeu Minecraft via le moteur interne `gens-core`.
3. La communication asynchrone avec **Gens-Horizon**, le moteur déporté de synchronisation cloud différentielle.

---

## Modèle de Processus Isolés

L'architecture respecte scrupuleusement le paradigme natif d'Electron en scindant l'application en trois royaumes étanches :

```
+-------------------------------------------------------------------+
|                        MAIN PROCESS (Node.js)                     |
|  - main.js : Cycle de vie, fenêtres, CSP globale                  |
|  - src/main/ipc-auth.js : Proxy Mojang, tokens Microsoft          |
|  - src/main/ipc-game.js : Préparation JVM, child_process execFile |
|  - src/main/ipc-horizon.js : Bridge binaire Horizon.exe           |
|  - src/main/crypto-utils.js : Primitives PBKDF2 / AES-256-GCM     |
+---------------------------------+---------------------------------+
                                  |
               IPC Asynchrone     | (ipcMain.handle / invoke)
               Whitelist Stricte  |
                                  v
+-------------------------------------------------------------------+
|                    SECURITY BRIDGE (preload.js)                   |
|  - contextIsolation: true                                         |
|  - enforceSandbox() / enforceReadSandbox() : Bloque Zip Slip      |
|  - window.api : Seul point d'entrée exposé au DOM                 |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|                   RENDERER PROCESS (Vanilla JS)                   |
|  - renderer.js, HTML5, Vanilla CSS                                |
|  - Aucune dépendance Node.js directe (require() interdit)         |
|  - Gestionnaires UI : AccountUI, InstancesUI, ModsUI, CloudUI     |
+-------------------------------------------------------------------+
```

---

## Description des Composants

### 1. Main Process (Processus Principal)
Il s'exécute dans un contexte Node.js complet avec accès au système de fichiers et au réseau bas niveau :
- **`main.js`** : Point d'entrée de l'application. Initialise les fenêtres `BrowserWindow`, installe la politique globale `Content-Security-Policy` (CSP) et charge les modules IPC.
- **`src/main/ipc-auth.js`** : Gère les flux OAuth2 Device Code et agit comme proxy sécurisé pour interroger les API Mojang (skins et capes) en contournant les restrictions CORS sans exposer le Renderer.
- **`src/main/ipc-game.js`** : Moteur de lancement. Assemble les arguments JVM, télécharge les bibliothèques et déclenche l'exécution via `child_process.execFile` (garantissant l'absence d'injection de shell).
- **`src/main/ipc-horizon.js`** : Passerelle exclusive avec le binaire autonome `Horizon.exe`. Valide le hash SHA-256 du binaire local par rapport aux releases GitHub officielles (avec cache mémoire de 2 heures) et filtre les arguments via une whitelist stricte.
- **`src/main/crypto-utils.js`** : Primitives cryptographiques. Clé de chiffrement dérivée par **PBKDF2** (600 000 itérations avec sel aléatoire de 16 octets dans `.key_salt`) et chiffrement en **AES-256-GCM**.

### 2. Le Pont de Sécurité (Preload)
- **`preload.js`** : S'exécute dans le Renderer mais configure la passerelle avant de fermer l'accès aux API internes :
  - Expose un objet scellé `window.api` au DOM via `contextBridge.exposeInMainWorld`.
  - Implémente le bouclier **Software Security Shield** : les fonctions `enforceSandbox()` et `enforceReadSandbox()` valident mathématiquement tous les chemins pour prévenir les attaques de type `Zip Slip` et `Path Traversal`.
  - L'écriture est strictement limitée à `%AppData%\GensLauncher`.
  - La lecture hors sandbox est restreinte aux répertoires légitimes (`.minecraft/`, runtimes Java identifiés et dossiers temporaires autorisés).

### 3. Renderer Process (Interface Utilisateur)
- **`renderer.js` / HTML / CSS** : Développé en **Vanilla JS** pour des performances optimales sans framework lourd.
- L'interface n'a aucun accès direct à `require()` ou à `process`.
- Toutes les actions système (lancer le jeu, explorer un fichier, synchroniser le cloud) s'effectuent par appels asynchrones sur `window.api.invoke()`.

---

## Cycle de Vie et Performance Asynchrone

- **Interdiction de `sendSync` :** Toutes les opérations bloquantes sont asynchrones (`ipcRenderer.invoke` côté Renderer et `ipcMain.handle` côté Main). L'interface utilisateur ne se fige jamais, même lors du téléchargement d'un modpack de plusieurs gigaoctets.
- **Injection Précoce d'Environnement :** Les métadonnées système (plateforme, architecture, version, appData) sont injectées via `BrowserWindow.additionalArguments` dès la création de la fenêtre, éliminant tout appel synchrone à l'initialisation.
