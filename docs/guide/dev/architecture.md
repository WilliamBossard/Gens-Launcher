# Global System Architecture

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Runtime-Electron-blue.svg" alt="Electron" />
  <img src="https://img.shields.io/badge/Node.js-24+-green.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/Model-Isolated%20Processes-orange.svg" alt="Processes" />
</div>

Gens-Launcher is the official Graphical User Interface (GUI) of the Gens ecosystem. Built on **Electron**, its primary role is to orchestrate:
1. Secure player authentication via Microsoft and Xbox Live APIs.
2. Asset verification, dependency downloading, and launching Minecraft via the in-house `gens-core` engine.
3. Asynchronous execution and communication with **Gens-Horizon**, the companion differential cloud sync engine.

---

## Isolated Process Model

The architecture strictly follows Electron's process separation model by splitting responsibilities across three isolated realms:

```
+-------------------------------------------------------------------+
|                        MAIN PROCESS (Node.js)                     |
|  - main.js: App lifecycle, windows, global CSP                   |
|  - src/main/ipc-auth.js: Mojang proxy, Microsoft tokens           |
|  - src/main/ipc-game.js: JVM preparation, child_process execFile  |
|  - src/main/ipc-horizon.js: Horizon.exe binary bridge             |
|  - src/main/crypto-utils.js: PBKDF2 / AES-256-GCM primitives      |
+---------------------------------+---------------------------------+
                                  |
               Async IPC          | (ipcMain.handle / invoke)
               Strict Whitelist   |
                                  v
+-------------------------------------------------------------------+
|                    SECURITY BRIDGE (preload.js)                   |
|  - contextIsolation: true                                         |
|  - enforceSandbox() / enforceReadSandbox(): Blocks Zip Slip       |
|  - window.api: Exclusive surface exposed to the DOM               |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|                   RENDERER PROCESS (Vanilla JS)                   |
|  - renderer.js, HTML5, Vanilla CSS                                |
|  - Zero direct Node.js access (require() forbidden)               |
|  - UI Managers: AccountUI, InstancesUI, ModsUI, CloudUI           |
+-------------------------------------------------------------------+
```

---

## Component Breakdown

### 1. Main Process
Runs in a full Node.js environment with native file system and low-level network access:
- **`main.js`**: Application entry point. Instantiates `BrowserWindow`, enforces global `Content-Security-Policy` (CSP) headers, and registers IPC handlers.
- **`src/main/ipc-auth.js`**: Manages OAuth2 flows and acts as a secure reverse proxy for Mojang APIs (skins and capes), bypassing CORS without exposing the renderer.
- **`src/main/ipc-game.js`**: Launch engine. Builds JVM startup arguments, downloads dependencies, and spawns the game via `child_process.execFile` (guaranteeing shell-injection immunity).
- **`src/main/ipc-horizon.js`**: Exclusive communication bridge for `Horizon.exe`. Validates local binary SHA-256 hash against official GitHub releases (cached for 2 hours) and whitelists executable flags.
- **`src/main/crypto-utils.js`**: Cryptographic routines. Encryption keys are derived using **PBKDF2** (600,000 iterations with a dedicated 16-byte salt in `.key_salt`) and authenticated via **AES-256-GCM**.

### 2. The Security Bridge (Preload)
- **`preload.js`**: Executes in renderer context but configures boundaries before locking down internal APIs:
  - Exposes a hardened `window.api` object to the DOM via `contextBridge.exposeInMainWorld`.
  - Implements the **Software Security Shield**: `enforceSandbox()` and `enforceReadSandbox()` mathematically inspect all path operations to prevent `Zip Slip` and `Path Traversal`.
  - Disk write operations are strictly restricted to `%AppData%\GensLauncher`.
  - File reading outside the sandbox is limited to verified paths (`.minecraft/`, detected Java runtimes, and temporary directories).

### 3. Renderer Process (User Interface)
- **`renderer.js` / HTML / CSS**: Built with lightweight **Vanilla JS** for instant startup and low memory footprint.
- No direct access to `require()` or `process`.
- All interactions with the underlying operating system go through asynchronous calls on `window.api.invoke()`.

---

## Lifecycle and Asynchronous Performance

- **Zero `sendSync` Policy:** All blocking operations run asynchronously (`ipcRenderer.invoke` in renderer and `ipcMain.handle` in main). The user interface remains reactive even during multi-gigabyte modpack installations.
- **Early Environment Injection:** Fundamental system metadata (platform, architecture, version, appData path) is injected into `BrowserWindow.additionalArguments` during window creation, eliminating synchronous IPC bootstrap calls.
