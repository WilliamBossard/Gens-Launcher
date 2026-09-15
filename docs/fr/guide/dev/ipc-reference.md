# Référence des Canaux IPC

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Protocole-IPC%20Asynchrone-blue.svg" alt="Protocole" />
  <img src="https://img.shields.io/badge/Contr%C3%B4le-Whitelist%20Statique-green.svg" alt="Contrôle" />
  <img src="https://img.shields.io/badge/Preload-contextBridge-orange.svg" alt="Preload" />
</div>

Toutes les communications entre le Renderer Process (DOM) et le Main Process (Node.js) transitent par une **liste blanche statique** de canaux IPC validée dans `preload.js`. Tout appel ciblant un canal non répertorié est rejeté avec une exception de sécurité.

---

## 1. Canaux d'Authentification (`src/main/ipc-auth.js`)

| Canal IPC | Type | Paramètres | Description |
|---|---|---|---|
| `auth:start-device-flow` | `invoke` | Aucun | Déclenche le flux OAuth2 Device Code et retourne le code court ainsi que l'URL de connexion. |
| `auth:poll-device-flow` | `invoke` | `deviceCode` | Sonde l'API Microsoft jusqu'à validation par le joueur ou expiration du délai. |
| `auth:save-account` | `invoke` | `accountData` | Chiffre et persiste le profil joueur dans le trousseau local. |
| `auth:get-accounts` | `invoke` | Aucun | Retourne la liste des comptes enregistrés (jetons sensibles masqués). |
| `auth:remove-account` | `invoke` | `uuid` | Supprime un compte et purge ses identifiants chiffrés du disque. |
| `auth:proxy-skin` | `invoke` | `skinUrl` | Agit comme proxy HTTPS pour télécharger la texture du skin sans blocage CORS. |

---

## 2. Canaux de Lancement et de Jeu (`src/main/ipc-game.js`)

| Canal IPC | Type | Paramètres | Description |
|---|---|---|---|
| `game:launch-instance` | `invoke` | `instanceConfig` | Prépare les fichiers, vérifie les SHA-1 des bibliothèques et lance le processus Java. |
| `game:kill-process` | `invoke` | `instanceId` | Envoie un signal `SIGTERM` (puis `SIGKILL`) au processus Java en cours d'exécution. |
| `game:detect-java` | `invoke` | Aucun | Analyse les chemins standards du système d'exploitation et retourne la liste des JDK / JRE disponibles. |
| `game:download-java` | `invoke` | `majorVersion` | Télécharge et extrait un runtime Java officiel vérifié (Adoptium / Eclipse Temurin). |
| `game:stream-logs` | `send / on` | Événement flux | Transmet les flux standard `stdout` et `stderr` de Minecraft vers la console du Renderer. |

---

## 3. Canaux Système et Fichiers (`src/main/ipc-system.js`)

| Canal IPC | Type | Paramètres | Description |
|---|---|---|---|
| `system:show-in-folder` | `invoke` | `targetPath` | Ouvre l'explorateur de fichiers natif (Explorer, Finder, Nautilus) sur l'élément ciblé. |
| `system:open-dialog-file` | `invoke` | `options` | Ouvre une boîte de dialogue native pour sélectionner un fichier (.zip, .jar). |
| `system:open-dialog-folder` | `invoke` | `options` | Ouvre une boîte de dialogue native pour sélectionner un dossier de destination. |
| `system:copy-image-to-sandbox` | `invoke` | `srcPath, destName, subDir` | Valide l'extension et les **Magic Bytes** de l'image avant de la copier dans la sandbox. |
| `system:discord-set-activity` | `invoke` | `activityPayload` | Met à jour le statut Rich Presence sur le client Discord local via Named Pipe. |
| `system:discord-clear` | `invoke` | Aucun | Réinitialise et efface l'activité affichée sur Discord. |

---

## 4. Canaux du Moteur Horizon (`src/main/ipc-horizon.js`)

| Canal IPC | Type | Paramètres | Description |
|---|---|---|---|
| `horizon:check` | `invoke` | Aucun | Interroge l'état de synchronisation globale et les versions distantes. |
| `horizon:login` | `invoke` | `providerName` | Démarre la procédure d'authentification OAuth2 pour Google Drive, Dropbox ou OneDrive. |
| `horizon:sync` | `invoke` | `instanceName` | Lance la synchronisation différentielle (téléchargement et application des deltas). |
| `horizon:upload` | `invoke` | `instanceName` | Analyse les modifications locales, crée une archive delta et l'envoie sur le cloud. |
| `horizon:quota` | `invoke` | Aucun | Récupère l'espace total, utilisé et disponible sur le stockage cloud connecté. |
| `horizon:rollback` | `invoke` | `instanceName, deltaId` | Restaure l'instance à un point de sauvegarde antérieur spécifique. |
| `horizon:purge-lock` | `invoke` | Aucun | Supprime manuellement un fichier `horizon.lock` orphelin après vérification. |

---

## 5. Canaux de Mise à Jour Automatique (`src/main/updater.js`)

| Canal IPC | Type | Paramètres | Description |
|---|---|---|---|
| `updater:check-for-updates` | `invoke` | Aucun | Vérifie sur GitHub Releases si une nouvelle version du lanceur est disponible. |
| `updater:download-update` | `invoke` | Aucun | Télécharge la mise à jour en arrière-plan avec rapport de progression. |
| `updater:quit-and-install` | `invoke` | Aucun | Redémarre l'application et applique la nouvelle version. |
