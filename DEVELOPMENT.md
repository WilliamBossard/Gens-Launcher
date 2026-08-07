# Gens-Launcher — Comprehensive Development Guide

This document describes the architecture, security model, data flows, and development best practices for the **Gens-Launcher** project. It serves as a technical reference (Single Source of Truth) for any contributor or security auditor.

---

## 1. Overview & Global Architecture
Gens-Launcher is the official Graphical User Interface (GUI) of the Gens ecosystem. Built on Electron, its role is to:
1. Manage secure player authentication via the Microsoft/Xbox API.
2. Download, verify, and launch the Minecraft game (via `gens-core`).
3. Asynchronously interact with **Gens-Horizon**, the headless cloud synchronization engine of the ecosystem.

The architecture strictly follows Electron's native model by separating the application into two distinct and isolated realms: the **Main Process** and the **Renderer Process**.

---

## 2. Component Topology

### 2.1 Main Process
It runs in a full Node.js context. It has access to the file system, low-level network, and controls the application's lifecycle.
- **`main.js`**: Application entry point. Initializes windows (`BrowserWindow`), sets up the global `Content-Security-Policy` (CSP), and centralizes IPC module imports.
- **`src/main/ipc-auth.js`**: Manages Microsoft OAuth2 flows (Device Code or web flow) relying on `prismarine-auth`. Exposes secure tokens for the Renderer. It also acts as a secure proxy to query the Mojang API (Skins/Capes), bypassing CORS restrictions.
- **`src/main/ipc-game.js`**: Launch engine. Prepares JVM parameters, downloads assets via `gens-core`, and uses `child_process.execFile` to guarantee execution free of shell injections.
- **`src/main/ipc-horizon.js`**: Exclusive communication bridge with `Horizon.exe`.
  - *Integrity*: Downloads the SHA-256 signature from the official GitHub release and validates the local Horizon executable before any launch. The hash is cached for 2h to avoid repeated network requests. *(Note: In a local development environment `!app.isPackaged`, hash errors are ignored to allow free testing of locally compiled versions).*
  - *Security*: Validates arguments via a strict **Whitelist** (`--sync`, `--check`, etc.) coupled with a Regex filter limiting allowed characters.
- **`src/main/ipc-system.js`**: Centralizes native OS interactions (Discord Rich Presence, archiving, Windows taskbar).
- **`src/main/crypto-utils.js`**: Cryptographic primitives of the Main Process. The AES-256-GCM key is derived via **PBKDF2** (100,000 iterations, random 16 bytes salt stored in `.key_salt`). Manages seamless migration of encrypted data from the old simple SHA-256 key to the new PBKDF2 format.

### 2.1.1 Internal Ecosystem (Gens-Core Components)
To limit the attack surface and drastically reduce application weight, the use of third-party dependencies is banned in favor of 100% native in-house implementations:
- **`discord.js`**: Native Named Pipes implementation for Discord Rich Presence. Includes a native IPC parser, a Timeout system, and a robust Rate Limiter. Fully replaces `@xhayper/discord-rpc`. It also strictly blocks auto-connection at launch by reading `settings.json` locally when in Offline Mode to prevent zombie requests.
- **`nbt.js`**: Native binary NBT parser and builder (using `zlib`). Ensures lossless reading and writing of the Minecraft `servers.dat` file. Fully replaces `prismarine-nbt`.
- **`auth.js`**: Native Microsoft authentication module (OAuth2 Device Code Flow). Manages `login.live.com` requests, Xbox Live exchange, XSTS token, and Minecraft Token acquisition. Fully replaces `prismarine-auth`.

### 2.2 The Security Bridge (Preload)
- **`preload.js`**: Runs in the Renderer but retains access to certain Node.js APIs before "closing" the door.
  - Exposes a secure `window.api` object to the DOM.
  - Implements the **Software Security Shield**: Its `enforceSandbox()` and `enforceReadSandbox()` functions mathematically verify all paths to prevent `Zip Slip` or `Path Traversal` attacks. Writing is strictly blocked outside of `%AppData%\GensLauncher`.
  - Reading is restricted to legitimate directories: `GensLauncher/`, `.minecraft/`, detected Java folders, and `tmp/GensLauncher`. Any out-of-scope read is silently blocked (without error logs to avoid noise).
  - Exposes `window.api.copyImageToSandbox(srcPath, destName, subDir?)`: allows the UI to request a secure copy of an image (wallpaper, instance icon) from any path to the sandbox. Validation (extension + **binary magic signature** PNG/JPEG/GIF/WEBP/BMP/ICO) and copying are performed exclusively in the Main Process.

### 2.3 Renderer Process
- **`renderer.js` / HTML / CSS**: The Vanilla JS interface. Has no access to `require()`. All system interactions are done by calling the asynchronous `window.api.invoke()` channels.

---

## 3. Security Design

The application has been audited and follows the **Defense in Depth** principle:

1. **Context Isolation**: Always enabled (`contextIsolation: true`). The Javascript prototype of the Renderer is isolated from that of the Main.
2. **IPC Sandboxing**: Native `sandbox: false` is used (required for preload's Node.js access), but compensated by hyper-strict application sandboxing in `preload.js`. Only reads in `.minecraft/` or Java directories are tolerated outside of `GensLauncher/`.
3. **Dual-Layer CSP Architecture**:
    - *Layer 1 (main.js)*: The HTTP header applies `script-src 'self'` (without `unsafe-inline` or `unsafe-eval`). All images and connections are limited to **HTTPS only**.
   - *Layer 2 (index.html)*: The DOM `<meta>` tag applies the same policy. Both layers are aligned.
4. **Encryption**: Local Microsoft authentication tokens are encrypted. The system favors `safeStorage` (native OS Keychain). If unavailable, an **AES-256-GCM** fallback is used with a key derived via **PBKDF2** (100,000 iterations, dedicated random 16 bytes salt stored in `.key_salt`). Data encrypted with the old algorithm (simple SHA-256) is automatically and silently migrated upon the first successful decryption.
5. **IPC Whitelist**: All communication channels (send, invoke, receive) are statically listed in `preload.js`. Any out-of-list call attempt is rejected, preventing the exploitation of obscure Electron channels.
6. **HTTPS Only**: The `http` module is not imported in `main.js`. The `downloadFile()` function rejects any non-HTTPS URL and applies a whitelist of authorized domains (`github.com`, `mojang.com`, `modrinth.com`, etc.).
7. **Image Integrity**: The `copy-image-to-sandbox` handler validates the file extension AND its magic bytes (binary signature). A `.jpg` file with malicious content would be rejected.
8. **Smart Offline Mode**: A centralized system (`uiCore.js`) dynamically reacts to `online/offline` events. When no connection is detected, the application physically locks the GUI (Java downloads, Horizon updates, Mods catalogs) and defuses asynchronous background pings to prevent silent Timeout errors and block unnecessary communications.

---

## 4. IPC Communication (Best Practices)

- **Asynchronicity**: Always use `ipcRenderer.invoke` (Renderer side) and `ipcMain.handle` (Main side) for blocking tasks. The UI should never freeze.
- **No `sendSync`**: The only `sendSync` that existed (`get-paths-sync` in `preload.js`) was removed and replaced by `BrowserWindow.additionalArguments`. System data injection (appData, platform, arch, version) is now done without blocking the thread. The `ipcMain.on('get-paths-sync')` handler is kept as a legacy fallback.

---

## 5. Deployment and CI/CD

The Launcher is packaged using `electron-builder` through GitHub Actions.
- **Target platforms**: Windows (`.exe` NSIS) and MacOS (`.dmg`).
- **Code Signing**: *Not applicable — Gens Launcher is a free open-source project and does not possess a commercial signing certificate (EV Code Signing, ~$300/year). On Windows, SmartScreen may display a warning upon first installation. Users can click on "More info" → "Run anyway" to proceed. As the source code is entirely public on GitHub, any user can audit and compile the application themselves.*
- **Testing**: Continuous Integration automatically triggers `npm test` to ensure cryptographic primitives and APIs remain stable before each new release on the `main` branch. Note: `crypto-utils.js` exposes certain internal test functions only when the `NODE_ENV` environment variable is set to `'test'`.
