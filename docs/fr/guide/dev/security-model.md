# Modèle de Sécurité et Sandbox

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Principe-D%C3%A9fense%20en%20Profondeur-blue.svg" alt="Défense en Profondeur" />
  <img src="https://img.shields.io/badge/Chiffrement-PBKDF2%20%2B%20AES--256--GCM-red.svg" alt="Chiffrement" />
  <img src="https://img.shields.io/badge/CSP-Double%20Couche-green.svg" alt="CSP" />
</div>

La conception de Gens-Launcher repose sur le principe fondamental de **Défense en Profondeur** (*Defense in Depth*). Plusieurs barrières indépendantes empêchent toute compromission de la machine hôte, même en cas d'injection malveillante dans un mod ou une ressource externe.

---

## 1. Isolation de Contexte et Exposition Scellée

- **`contextIsolation: true`** : Les prototypes Javascript du Main Process et du Renderer Process sont totalement disjoints.
- **`nodeIntegration: false`** : L'environnement Node.js natif est inaccessible depuis le DOM.
- **Surface d'Exposition `window.api`** : Seules les fonctions strictement répertoriées dans `preload.js` sont accessibles par l'interface utilisateur.

---

## 2. Le Bouclier Sandbox Preload (Anti-Traversal)

Le fichier `preload.js` implémente un bouclier mathématique rigoureux :

```javascript
// Validation stricte des chemins d'écriture
function enforceSandbox(targetPath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedSandbox = path.resolve(APP_DATA_DIR);
    if (!resolvedTarget.startsWith(resolvedSandbox + path.sep) && resolvedTarget !== resolvedSandbox) {
        throw new Error("Violation de sécurité Sandbox : Tentative d'écriture hors du répertoire autorisé.");
    }
    return resolvedTarget;
}
```

- **Protection anti-Zip Slip :** Lors de l'extraction de modpacks ou de téléchargements zip, chaque chemin de destination est vérifié avant écriture sur disque.
- **Contrôle d'accès en lecture (`enforceReadSandbox`) :** La lecture de fichiers en dehors du dossier de l'application est restreinte aux répertoires légitimes (`.minecraft/`, runtimes Java et dossiers temporaires autorisés). Toute tentative hors périmètre est neutralisée silencieusement.

---

## 3. Architecture CSP à Double Couche

La politique de sécurité du contenu (**Content Security Policy**) est appliquée à deux niveaux distincts pour garantir une étanchéité absolue :

1. **Couche Réseau (Header HTTP dans `main.js`) :**
   Appliquée sur toutes les réponses des protocoles internes et fenêtres BrowserWindow via `session.defaultSession.webRequest.onHeadersReceived`.
2. **Couche DOM (Balise Meta dans `index.html`) :**
   Inscrite directement dans le balisage statique de l'application.

```http
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https:;
connect-src 'self' https:;
```
- **Zéro `unsafe-eval` :** L'évaluation dynamique de chaînes (`eval()`, `new Function()`) est physiquement impossible.
- **Connexions HTTPS exclusives :** Toute requête non sécurisée en HTTP clair est automatiquement rejetée.

---

## 4. Primitives Cryptographiques et Stockage Sécurisé

Le stockage des jetons Microsoft et des clés cloud suit les recommandations du NIST et de l'OWASP :

```
[ Mot de passe / Clé Maître ]
             |
             v
   +--------------------+
   |  PBKDF2 (SHA-512)  | <--- Sel aléatoire 16 octets (.key_salt)
   | 600 000 itérations |
   +--------------------+
             |
             v
     [ Clé 256 bits ]
             |
             v
   +--------------------+
   |    AES-256-GCM     | <--- Vecteur d'initialisation aléatoire 12 octets (IV)
   +--------------------+
             |
             v
 [ Ciphertext + Tag d'authentification (16 octets) ]
```

- **Dérivation PBKDF2 :** 600 000 itérations avec sel cryptographique de 16 octets généré aléatoirement au premier démarrage dans `.key_salt`.
- **Mode Authentifié GCM :** Protège contre les attaques par altération ou rejeu de données chiffrées grâce à un tag d'authentification de 16 octets.
- **Migration Transparente :** Si un fichier chiffré avec l'ancien algorithme (simple clé SHA-256) est détecté, il est automatiquement et silencieusement rechiffré au nouveau standard PBKDF2 lors de la première lecture réussie.

---

## 5. Validation Binaire des Images (Magic Bytes)

Lorsqu'un utilisateur importe une image pour un fond d'écran ou l'icône d'une instance, Gens-Launcher ne se fie pas à l'extension du fichier :
1. Le fichier est lu dans le Main Process (`src/main/fs-utils.js`).
2. Les premiers octets (**Magic Bytes**) sont inspectés :
   - **PNG :** `89 50 4E 47 0D 0A 1A 0A`
   - **JPEG :** `FF D8 FF`
   - **GIF :** `47 49 46 38`
   - **WEBP :** `52 49 46 46 ... 57 45 42 50`
   - **BMP :** `42 4D`
   - **ICO :** `00 00 01 00`
3. Si la signature ne correspond pas à une image valide, le fichier est immédiatement rejeté pour empêcher l'exécution d'exécutables masqués.
