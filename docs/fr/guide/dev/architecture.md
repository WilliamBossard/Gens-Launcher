# Architecture Système Globale

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Runtime-Rust%20%2B%20Tauri%20v2-orange.svg" alt="Rust + Tauri v2" />
  <img src="https://img.shields.io/badge/Async-Tokio-blue.svg" alt="Tokio" />
  <img src="https://img.shields.io/badge/Mod%C3%A8le-WebView%20Isol%C3%A9e-green.svg" alt="WebView Isolée" />
</div>

Gens-Launcher est l'interface graphique officielle (GUI) de l'écosystème Gens. Construit sur **Rust + Tauri v2**, son rôle principal est d'orchestrer :

1. L'authentification sécurisée des joueurs via les APIs Microsoft et Xbox Live.
2. La vérification des assets, le téléchargement des dépendances et le lancement de Minecraft nativement en Rust (`src-tauri/src/game.rs`).
3. L'exécution asynchrone et la communication avec **Gens-Horizon**, le moteur de synchronisation cloud différentielle.

---

## Modèle de Séparation Stricte

L'architecture sépare strictement les opérations système privilégiées de l'interface utilisateur en trois couches isolées :

```text
+-------------------------------------------------------------------+
|                   BACKEND RUST (src-tauri/src/)                   |
|  - main.rs : Cycle de vie Tauri v2, tray, single-instance, IPC    |
|  - game.rs & game_validation.rs : Moteur MC, gardes JVM/URL       |
|  - sandbox.rs & fs_ops.rs : FS confiné (lexical + anti-symlink)   |
|  - network.rs : OAuth2 Microsoft, proxy Mojang/Modrinth/CF        |
|  - crypto.rs : DPAPI Windows, migration Electron, PBKDF2/AES-GCM  |
|  - archive.rs, horizon.rs, updater.rs, system.rs, discord.rs,     |
|    ping.rs, nbt.rs                                                |
+---------------------------------+---------------------------------+
                                  |
               IPC Asynchrone     | (__TAURI__.core.invoke / events)
               Liste blanche      |
                                  v
+-------------------------------------------------------------------+
|          PONT DE SÉCURITÉ (frontend/src/tauri-bridge.js)          |
|  - Listes blanches statiques (SEND / INVOKE / RECEIVE)            |
|  - Protocole asset:// confiné à $APPDATA/GensLauncher/**          |
|  - window.api : Surface exclusive exposée au DOM                  |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               FRONTEND WEBVIEW (TypeScript Strict)                |
|  - frontend/renderer.js (checkJs + strict), HTML5, CSS natif      |
|  - Zéro accès direct à l'OS ou Node.js                            |
|  - Gestionnaires UI : AccountUI, InstancesUI, ModsUI, CloudUI     |
+-------------------------------------------------------------------+
```

---

## Découpage des Composants

### 1. Backend Natif Rust (`src-tauri/src/`)

Compilé nativement (Rust édition 2024, LTO + strip, binaire ~11 Mo) avec le runtime asynchrone Tokio :

- **`main.rs`** : Point d'entrée Tauri v2. Initialise la barre d'état système, le verrou single-instance, le parsing `--auto-launch=`, `AppState` et le routeur IPC (`ipc_invoke` / `ipc_send`).
- **`game.rs` & `game_validation.rs`** : Moteur de lancement Minecraft natif (Vanilla / Fabric / Quilt / Forge / NeoForge), ForgeWrapper, règles OS/arch Mojang, téléchargements parallèles vérifiés par SHA-1, scanner Java, installeur Adoptium vérifié par SHA-256 et validateurs JVM/URL/overrides.
- **`sandbox.rs` & `fs_ops.rs`** : Service de fichiers confiné appliquant les bornes lexicales et la résolution canonique `realpath` (anti-symlink/junction), le blocage UNC, la denylist renderer et les écritures atomiques.
- **`network.rs`** : Téléchargements streamés HTTPS (`reqwest` + `rustls`), OAuth2 Device Code Microsoft, proxy Mojang skins/profils, APIs Modrinth/CurseForge et validation Magic Bytes des fichiers importés.
- **`horizon.rs`** : Pont exclusif vers `Horizon.exe` / `Horizon` avec vérification SHA-256 contre GitHub Releases et liste blanche stricte des arguments CLI.
- **`crypto.rs`** : DPAPI Windows (FFI direct `crypt32.dll`), déchiffrement transparent de l'ancien format Electron `safeStorage:` (`Local State`), et chiffrement **PBKDF2 (600 000 itérations) + AES-256-GCM**.
- **`updater.rs`** : Auto-updater natif compatible avec les manifestes `electron-updater` (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) avec vérification SHA-512 obligatoire et support APT `.deb` sur Linux.

### 2. Pont de Sécurité (`frontend/src/tauri-bridge.js`)

- Expose un objet `window.api` durci au-dessus de Tauri v2 (`__TAURI__.core.invoke` / `__TAURI__.event.listen`).
- Applique des listes blanches statiques (`VALID_SEND_CHANNELS`, `VALID_INVOKE_CHANNELS`, `VALID_RECEIVE_CHANNELS`).
- Restreint les écritures chiffrées (`window.api.security.writeJSON`) exclusivement à `accounts.json` et `cf_api_key.enc`.
- Convertit les chemins locaux via `convertFileSrc` (`asset://`) dans le périmètre `$APPDATA/GensLauncher/**`.

### 3. Frontend WebView (`frontend/`)

- **`frontend/renderer.js` / HTML / CSS** : Interface modulaire légère vérifiée statiquement par **TypeScript** (`checkJs: true`, `strict: true`), sans étape de transpilation.
- S'exécute dans la WebView native du système (WebView2 sous Windows, WebKitGTK sous Linux, WKWebView sous macOS) sans aucun runtime Node.js exposé.

---

## Cycle de Vie et Performance Asynchrone

- **Runtime Tokio non bloquant :** Les opérations lourdes (disque, archives, chiffrement) tournent dans `tokio::task::spawn_blocking`, gardant l'interface fluide même lors d'extractions de gros modpacks.
- **Injection initiale (`window.__GENS_BOOT__`) :** Les métadonnées système (`appData`, `platform`, `arch`, `version`, mémoire, `isAutoLaunch`, `isAppImage`) sont injectées dès la création de la fenêtre, éliminant tout appel IPC synchrone au démarrage.
