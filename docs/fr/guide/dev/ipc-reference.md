# Référence des Canaux IPC

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Protocole-IPC%20Asynchrone-blue.svg" alt="Protocole" />
  <img src="https://img.shields.io/badge/Contr%C3%B4le-Whitelist%20Statique-green.svg" alt="Contrôle" />
  <img src="https://img.shields.io/badge/Types-src%2Ftypes%2Fipc.ts-orange.svg" alt="Types" />
</div>

Toutes les communications entre le Renderer Process (DOM) et le Main Process (Node.js) transitent par une **liste blanche statique** de canaux IPC validée dans `preload.js` et typée dans `src/types/ipc.ts` (vérifiée par `tests/ipc-channels.test.js`). Tout appel ciblant un canal non répertorié est immédiatement rejeté.

---

## 1. Canaux d'Authentification & Profil Mojang (`src/main/ipc-auth.js`)

| Canal IPC | Direction | Paramètres | Description |
| --- | --- | --- | --- |
| `login-microsoft` | `invoke` | Aucun | Démarre le flux OAuth2 Device Code, émet `microsoft-device-code` et retourne le profil ainsi que le jeton chiffré. |
| `refresh-microsoft` | `invoke` | `refreshToken` | Déchiffre et renouvelle un jeton de session Microsoft enregistré. |
| `cancel-login-microsoft` | `send` | Aucun | Annule une session de polling Device Code en cours. |
| `microsoft-device-code` | `receive` | `DeviceCodeInfo` | Transmet le `user_code` et la `verification_uri` à la modale de connexion. |
| `delete-msa-cache` | `invoke` | Aucun | Purge les fichiers locaux de cache d'authentification Microsoft. |
| `fetch-mojang-profile` | `invoke` | `uuid` | Interroge les serveurs de session Mojang via proxy HTTPS sans blocage CORS. |
| `fetch-mojang-raw-skin` | `invoke` | `url` | Télécharge une texture de skin et retourne une URI `data:image/png;base64`. |
| `upload-mojang-skin` | `invoke` | `{ token, variant, filePath }` | Téléverse un nouveau skin ou modèle (`classic` / `slim`) vers Minecraft Services. |

---

## 2. Canaux de Lancement, Java & Ping Serveur (`src/main/ipc-game.js`)

| Canal IPC | Direction | Paramètres | Description |
| --- | --- | --- | --- |
| `launch-game` | `send` | `LaunchGamePayload` | Vérifie les bibliothèques, construit les arguments JVM et lance le processus Java de Minecraft. |
| `force-stop-game` | `invoke` | `instanceId` | Arrête de force une instance Minecraft en cours d'exécution. |
| `get-still-running` | `invoke` | Aucun | Retourne la liste des identifiants d'instances actuellement actives. |
| `check-java` | `invoke` | `javaPath` | Exécute `java -version` et retourne `{ valid, majorVersion, versionString }`. |
| `scan-java-versions` | `invoke` | Aucun | Analyse les dossiers système et runtimes gérés pour lister les JRE/JDK installés. |
| `run-forge-installer` | `invoke` | `{ installerPath, javaExec, mcRoot }` | Exécute un installateur headless Forge ou NeoForge dans la sandbox. |
| `ping-server` | `invoke` | `address` | Effectue un ping TCP Server List Ping (SLP) avec résolution DNS SRV. |
| `mc-progress` / `mc-data` / `mc-started` / `mc-close` | `receive` | Événement flux | Transmet la progression des téléchargements, les logs (`stdout`/`stderr`), le démarrage et le code de sortie à l'interface. |

---

## 3. Système de Fichiers Confiné & Opérations OS (`src/main/ipc-fs.js` & `src/main/ipc-system.js`)

| Canal IPC | Direction | Paramètres | Description |
| --- | --- | --- | --- |
| `fs:readFile` / `fs:writeFile` / `fs:readdir` / `fs:stat` / `fs:mkdir` / `fs:rm` / `fs:unlink` / `fs:rename` / `fs:cp` / `fs:copyFile` / `fs:exists` | `invoke` | Chemin & options | Opérations fichiers confinées et validées par `assertPathUnderSandbox`. |
| `copy-image-to-sandbox` | `invoke` | `{ srcPath, destName, subDir }` | Valide l'extension et les **Magic Bytes** binaires avant de copier une image dans la sandbox. |
| `copy-file-to-sandbox` | `invoke` | `{ srcPath, destName }` | Vérifie l'extension d'import autorisée et copie un fichier archive/mod dans la sandbox. |
| `extract-zip` / `compress-folder` / `read-zip-text` / `extract-tar` | `invoke` | Chemins d'archives | Extrait ou compresse des archives dans des Worker Threads dédiés avec protection anti-Zip-Slip. |
| `nbt:parse` / `nbt:write` | `invoke` | Buffer / Objet NBT | Lit ou sérialise des fichiers binaires NBT (`servers.dat`, `level.dat`). |
| `system:open-external` / `system:open-path` / `system:show-item-in-folder` | `invoke` | URL ou chemin | Ouvre un lien HTTPS dans le navigateur ou révèle un fichier sandboxé dans l'explorateur de l'OS. |
| `update-discord` / `reconnect-discord` | `send` / `invoke` | Activité RPC | Met à jour ou reconnecte le statut Discord Rich Presence via le pipe IPC local. |

---

## 4. Canaux du Moteur Cloud Horizon (`src/main/ipc-horizon.js`)

| Canal IPC | Direction | Paramètres | Description |
| --- | --- | --- | --- |
| `get-horizon-settings` | `invoke` | Aucun | Lit et déchiffre la configuration locale Horizon. |
| `save-horizon-settings` | `invoke` | `settings` | Chiffre et sauvegarde la configuration Horizon sur le disque. |
| `check-horizon-status` | `invoke` | Aucun | Vérifie la présence du binaire `Horizon` et valide son empreinte SHA-256. |
| `install-horizon` | `invoke` | Aucun | Télécharge et vérifie le binaire officiel `Horizon` depuis GitHub Releases. |
| `call-horizon` | `invoke` | `string[]` | Exécute `Horizon` avec des drapeaux autorisés (`--check`, `--sync`, `--upload`, `--rollback`, `--quota`, `--unlock`) et diffuse les événements JSON sur `horizon-status`. |
| `horizon-status` / `horizon-install-progress` | `receive` | `HorizonEvent` | Transmet en temps réel les événements JSON du protocole Horizon et la progression d'installation. |

---

## 5. Canaux de Mise à Jour Automatique (`src/main/updater.js`)

| Canal IPC | Direction | Paramètres | Description |
| --- | --- | --- | --- |
| `check-for-updates` | `invoke` | Aucun | Interroge GitHub Releases pour détecter une nouvelle version du lanceur. |
| `download-update` / `confirm-update` | `send` | Aucun | Déclenche le téléchargement de la mise à jour en arrière-plan. |
| `do-deb-update` | `invoke` | Aucun | Lance la procédure de mise à jour pour les installations Linux `.deb`. |
| `restart_app` | `send` | Aucun | Ferme l'application et installe la mise à jour téléchargée. |
| `update-available-prompt` / `update-progress` / `update-downloaded` | `receive` | Événement | Informe l'interface de la disponibilité, de la progression et de la fin du téléchargement d'une mise à jour. |
