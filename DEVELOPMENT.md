# Gens-Launcher — Comprehensive Development Guide

This document describes the architecture, security model, data flows, and development best practices for the **Gens-Launcher** project. It serves as a technical reference (Single Source of Truth) for any contributor or security auditor.

Detailed developer documentation is also available in `docs/guide/dev/` (English) and `docs/fr/guide/dev/` (French).

---

## 1. Overview & Global Architecture

Gens-Launcher is the official Graphical User Interface (GUI) of the Gens ecosystem. Built on Electron, its role is to:

1. Manage secure player authentication via the Microsoft/Xbox API.
2. Download, verify, and launch the Minecraft game (via `gens-core`).
3. Asynchronously interact with **Gens-Horizon**, the headless cloud synchronization engine of the ecosystem.

The architecture strictly follows Electron's native model by separating the application into isolated realms: the **Main Process**, the **Preload Security Bridge**, and the **Renderer Process**.

---

## 2. Component Topology

### 2.1 Main Process

It runs in a full Node.js context. It has access to the file system, low-level network, and controls the application's lifecycle.

- **`main.js`**: Application entry point. Initializes windows (`BrowserWindow`), sets up the global `Content-Security-Policy` (CSP), and centralizes IPC module imports via a typed `MainContext`.
- **`src/main/ipc-auth.js`**: Manages Microsoft OAuth2 flows (Device Code flow) relying on the native in-house `auth.js` module. Encrypts and stores refresh tokens on disk, and acts as a secure HTTPS proxy to query the Mojang API (Skins/Capes), bypassing CORS restrictions.
- **`src/main/ipc-game.js`**: Launch engine. Prepares JVM parameters, downloads assets via `gens-core`, and spawns the game process via `child_process` without shell evaluation to guarantee immunity against command injection.
- **`src/main/ipc-fs.js` & `src/main/fs-utils.js`**: Confined filesystem service. Every file operation requested by the Renderer is validated in the Main Process via `assertPathUnderSandbox()` (enforcing both lexical path bounds and `fs.realpathSync` symlink/junction checks).
- **`src/main/ipc-horizon.js`**: Exclusive communication bridge with `Horizon.exe` / `Horizon`.
  - *Integrity*: Downloads the SHA-256 signature from the official GitHub release and validates the local Horizon executable before any launch. The hash is cached for 2h to avoid repeated network requests. *(Note: In a local development environment `!app.isPackaged`, hash errors are ignored to allow free testing of locally compiled versions).*
  - *Security*: Validates arguments via a strict **Whitelist** (`--sync`, `--check`, `--upload`, etc.) coupled with a Regex filter limiting allowed characters.
- **`src/main/ipc-system.js`**: Centralizes native OS interactions (Discord Rich Presence, worker-based ZIP extraction/compression, image Magic Bytes validation, Windows Jump List).
- **`src/main/crypto-utils.js`**: Cryptographic primitives of the Main Process. Prioritizes OS-native `safeStorage` (DPAPI / Keychain / Libsecret) and falls back to **AES-256-GCM** with a key derived via **PBKDF2** (600,000 iterations, random 16-byte salt stored in `.key_salt`). Manages seamless migration of legacy SHA-256 encrypted tokens.

### 2.1.1 Internal Ecosystem (`src/gens-core/components/`)

To limit the attack surface and drastically reduce application weight, heavy third-party dependencies are replaced by 100% native in-house implementations:

- **`discord.js`**: Native Named Pipes / Unix domain socket implementation for Discord Rich Presence. Includes a binary frame encoder, timeout handling, and a 15s rate limiter. Replaces `@xhayper/discord-rpc`.
- **`nbt.js`**: Native binary NBT parser and builder (using `zlib`). Ensures lossless reading and writing of the Minecraft `servers.dat` file. Replaces `prismarine-nbt`.
- **`auth.js`**: Native Microsoft authentication module (OAuth2 Device Code Flow). Manages `login.live.com` requests, Xbox Live exchange, XSTS token, and Minecraft Token acquisition. Replaces `prismarine-auth`.
- **`ping.js`**: Native TCP Server List Ping (SLP) client with VarInt framing and DNS SRV (`_minecraft._tcp`) resolution.
- **`launcher.js` & `handler.js`**: Core Minecraft asset downloader, SHA-1 verifier, ForgeWrapper integrator, and JVM argument builder.

### 2.2 The Security Bridge (Preload)

- **`preload.js`**: Runs in an isolated preload context (`contextIsolation: true`, `sandbox: true`).
  - Exposes a hardened `window.api` object to the DOM via `contextBridge.exposeInMainWorld`.
  - Enforces a **Static IPC Whitelist** (`SEND_CHANNELS`, `INVOKE_CHANNELS`, `RECEIVE_CHANNELS`). Any unlisted channel is blocked immediately.
  - Implements lexical path sandboxing (`enforceSandbox` / `enforceReadSandbox`) before forwarding filesystem operations to `src/main/ipc-fs.js`.
  - Exposes `window.api.copyImageToSandbox(srcPath, destName, subDir?)` and `window.api.copyFileToSandbox(srcPath, destName)` so the Main Process can validate extensions and binary **Magic Bytes** before copying external files into `%AppData%\GensLauncher`.

### 2.3 Renderer Process

- **`renderer.js` & `src/ui/*`, `src/launch/*`, `src/archives/*`, `src/local/*`**: Modular ES/CommonJS interface with no direct access to Node.js `require()` or `fs`. All system interactions pass through asynchronous `window.api.invoke()` calls.

---

## 3. Security Design

The application follows the **Defense in Depth** principle:

1. **Context Isolation & Preload Sandbox**: `contextIsolation: true` and `sandbox: true` isolate the Renderer from Node.js internals.
2. **Dual-Layer Sandbox Validation**: Paths are validated lexically in `preload.js` and re-validated in the Main Process (`ipc-fs.js`) with `fs.realpathSync` to block symlink/junction escapes and `Zip Slip` attacks. Writing is strictly confined to `%AppData%\GensLauncher`.
3. **Dual-Layer CSP Architecture**:
   - *Layer 1 (`main.js`)*: HTTP response headers enforce `script-src 'self'` (no `unsafe-inline` or `unsafe-eval`).
   - *Layer 2 (`index.html`)*: The `<meta http-equiv="Content-Security-Policy">` tag enforces the same restrictions in the DOM.
4. **Encryption**: Local Microsoft authentication tokens are encrypted via `safeStorage` (OS Keychain) or **AES-256-GCM** with **PBKDF2** (600,000 iterations, random 16-byte salt in `.key_salt`).
5. **Static IPC Whitelist**: All communication channels (`send`, `invoke`, `receive`) are statically listed in `preload.js` and verified against `src/types/ipc.ts` by automated unit tests (`tests/ipc-channels.test.js`).
6. **HTTPS Only**: All remote downloads enforce `https:` and validate domains.
7. **Binary Magic Bytes Verification**: `copy-image-to-sandbox` verifies both the file extension and its binary header signature (PNG, JPEG, GIF, WEBP, BMP, ICO).
8. **Smart Offline Mode**: `src/uiCore.js` dynamically reacts to connectivity changes, locking network-dependent actions and suppressing background pings when offline.

---

## 4. IPC Communication (Best Practices)

- **Asynchronicity**: Always use `ipcRenderer.invoke` (Renderer side) and `ipcMain.handle` (Main side) for I/O tasks so the UI thread never freezes.
- **No `sendSync`**: System bootstrap paths (`appData`, `platform`, `arch`, `version`) are injected via `BrowserWindow.additionalArguments` at window creation, avoiding synchronous IPC calls.

---

## 5. TypeScript & Static Type Safety Architecture

Gens-Launcher uses a **zero-build-step TypeScript architecture** (`allowJs: true`, `checkJs: true`, `strict: true`, `noEmit: true` in `tsconfig.json`):

- **Shared Type Contracts**:
  - `src/types/ipc.ts`: Exhaustive definitions of all IPC channels (`SendChannel`, `InvokeChannel`, `ReceiveChannel`), Horizon JSON protocol events, and `WindowApi`.
  - `src/types/models.ts`: Domain models (`MinecraftInstance`, `MinecraftAccount`, `GlobalSettings`, `ThemeSettings`, `MainContext`).
  - `src/types/global.d.ts`: Strict typing for `Window` globals and UI controllers.
- **100% Coverage**: Every `.js` file across `main.js`, `preload.js`, `renderer.js`, `src/main/*`, `src/gens-core/*`, and `src/ui/*` is type-checked via `// @ts-check` and JSDoc annotations.
- **Required Checks**:

  ```bash
  npm run typecheck
  npm test
  ```

---

## 6. Deployment and Multi-Distribution Pipelines

The Launcher is packaged and distributed across multiple ecosystems through automated GitHub Actions:

### 6.1 Artifacts & Target Platforms

- **Windows**: NSIS Installer (`.exe`) distributed via GitHub Releases.
- **Linux**:
  - **APT Repository (Debian/Ubuntu)**: Official GPG-signed repository deployed to GitHub Pages (`apt.yml`).
  - **AppImage**: Standalone portable executable with built-in `electron-updater`.
- **macOS**: DMG disk image (`.dmg`).

### 6.2 GitHub Actions Workflows

1. **`ci.yml`**: Runs automatically on every push and pull request across Ubuntu and Windows (Node.js 22 & 24), executing `npm run typecheck` and `npm test`.
2. **`release.yml`**: Runs `npm run typecheck` and `npm test`, then compiles cross-platform binaries using `electron-builder` and publishes releases to GitHub.
3. **`apt.yml`**: Triggered on published release, compiles the VitePress documentation (`docs/`), pulls the `.deb` package, signs the APT repository with GPG (`Release.gpg`, `InRelease`), and deploys to GitHub Pages.

### 6.3 Code Signing

*Not applicable — Gens Launcher is a free open-source project without a commercial corporate EV certificate. On Windows, SmartScreen may display an initial warning on unverified installers ("More info" → "Run anyway"). All source code and build workflows are 100% public and auditable.*
