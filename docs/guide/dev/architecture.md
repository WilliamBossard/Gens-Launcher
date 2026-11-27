# Global System Architecture

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Runtime-Rust%20%2B%20Tauri%20v2-orange.svg" alt="Rust + Tauri v2" />
  <img src="https://img.shields.io/badge/Async-Tokio-blue.svg" alt="Tokio" />
  <img src="https://img.shields.io/badge/Model-Isolated%20WebView-green.svg" alt="Isolated WebView" />
</div>

Gens-Launcher is the official Graphical User Interface (GUI) of the Gens ecosystem. Built on **Rust + Tauri v2**, its primary role is to orchestrate:

1. Secure player authentication via Microsoft and Xbox Live APIs.
2. Asset verification, dependency downloading, and launching Minecraft natively in Rust (`src-tauri/src/game.rs`).
3. Asynchronous execution and communication with **Gens-Horizon**, the companion differential cloud sync engine.

---

## Isolated Process Model

The architecture strictly separates privileged native operations from the UI across three isolated layers:

```text
+-------------------------------------------------------------------+
|                   RUST BACKEND (src-tauri/src/)                   |
|  - main.rs: Tauri v2 lifecycle, tray, single-instance, IPC router |
|  - game.rs & game_validation.rs: MC launch engine, JVM/URL guards |
|  - sandbox.rs & fs_ops.rs: Lexical + anti-symlink sandboxed FS    |
|  - network.rs: Microsoft OAuth2, Mojang/Modrinth/CurseForge proxy |
|  - crypto.rs: Windows DPAPI, Electron migration, PBKDF2/AES-GCM   |
|  - archive.rs, horizon.rs, updater.rs, system.rs, discord.rs,     |
|    ping.rs, nbt.rs                                                |
+---------------------------------+---------------------------------+
                                  |
               Async IPC          | (__TAURI__.core.invoke / events)
               Strict Whitelist   |
                                  v
+-------------------------------------------------------------------+
|            SECURITY BRIDGE (frontend/src/tauri-bridge.js)         |
|  - Static channel whitelists (SEND / INVOKE / RECEIVE)            |
|  - asset:// protocol mapping scoped to $APPDATA/GensLauncher/**   |
|  - window.api: Exclusive surface exposed to the DOM               |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               WEBVIEW FRONTEND (Strict TypeScript)                |
|  - frontend/renderer.js (checkJs + strict), HTML5, Vanilla CSS    |
|  - Zero direct OS/Node.js access                                  |
|  - UI Managers: AccountUI, InstancesUI, ModsUI, CloudUI           |
+-------------------------------------------------------------------+
```

---

## Component Breakdown

### 1. Rust Core Backend (`src-tauri/src/`)

Compiled natively (Rust edition 2024, LTO + strip, ~11 MB binary) with Tokio async I/O:

- **`main.rs`**: Application entry point. Initializes Tauri v2, system tray, single-instance plugin, `--auto-launch=` handling, `AppState`, and async IPC dispatch (`ipc_invoke` / `ipc_send`).
- **`game.rs` & `game_validation.rs`**: Native Minecraft launch engine (Vanilla / Fabric / Quilt / Forge / NeoForge), ForgeWrapper, Mojang OS/arch rules, concurrent SHA-1 verified downloads, Java scanner, SHA-256 verified Adoptium JRE installer, and strict JVM/URL/override validators.
- **`sandbox.rs` & `fs_ops.rs`**: Sandboxed filesystem service enforcing both lexical boundaries and canonical `realpath` symlink/junction checks, UNC path blocking, renderer denylist, and atomic file writes.
- **`network.rs`**: Streaming HTTPS downloads (`reqwest` + `rustls`), Microsoft Device Code OAuth2, Mojang profile/skin proxy, Modrinth/CurseForge APIs, and Magic Bytes upload validation.
- **`horizon.rs`**: Exclusive communication bridge for `Horizon.exe` / `Horizon` with GitHub SHA-256 verification and strict CLI flag whitelisting.
- **`crypto.rs`**: Windows DPAPI (direct FFI to `crypt32.dll`), transparent decryption of legacy Electron `safeStorage:` (`Local State`), and **PBKDF2 (600,000 iterations) + AES-256-GCM** encryption.
- **`updater.rs`**: Native auto-updater compatible with `electron-updater` manifests (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) with mandatory SHA-512 verification and Linux APT `.deb` support.

### 2. The Security Bridge (`frontend/src/tauri-bridge.js`)

- Exposes a hardened `window.api` object over Tauri v2 (`__TAURI__.core.invoke` / `__TAURI__.event.listen`).
- Enforces static IPC whitelists (`VALID_SEND_CHANNELS`, `VALID_INVOKE_CHANNELS`, `VALID_RECEIVE_CHANNELS`).
- Scopes encrypted JSON writes (`window.api.security.writeJSON`) exclusively to `accounts.json` and `cf_api_key.enc`.
- Rewrites local asset paths via `convertFileSrc` (`asset://`) scoped to `$APPDATA/GensLauncher/**`.

### 3. WebView Frontend (`frontend/`)

- **`frontend/renderer.js` / HTML / CSS**: Lightweight modular ES interface strictly type-checked with **TypeScript** (`checkJs: true`, `strict: true`), preserving zero-build-step startup performance.
- Runs in the native OS WebView (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS) with zero Node.js exposure.

---

## Lifecycle and Asynchronous Performance

- **Non-Blocking Tokio Runtime:** Blocking disk/archive/crypto operations run on `tokio::task::spawn_blocking`, keeping the WebView UI thread responsive even during multi-gigabyte modpack extractions.
- **Early Bootstrap Injection:** System metadata (`appData`, `platform`, `arch`, `version`, memory, `isAutoLaunch`, `isAppImage`) is injected via `window.__GENS_BOOT__` at window creation, eliminating synchronous startup IPC calls.
