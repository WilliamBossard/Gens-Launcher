# IPC Channel Reference

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Protocol-Async%20IPC-blue.svg" alt="Protocol" />
  <img src="https://img.shields.io/badge/Access-Static%20Whitelist-green.svg" alt="Access" />
  <img src="https://img.shields.io/badge/Types-src%2Ftypes%2Fipc.ts-orange.svg" alt="Types" />
</div>

All communication between the Renderer Process (DOM) and the Main Process (Node.js) is gated behind a **static whitelist** enforced in `preload.js` and strictly typed in `src/types/ipc.ts` (verified by `tests/ipc-channels.test.js`). Invocations targeting unlisted channels are rejected immediately.

---

## 1. Authentication & Mojang Profile Channels (`src/main/ipc-auth.js`)

| IPC Channel | Direction | Arguments | Description |
| --- | --- | --- | --- |
| `login-microsoft` | `invoke` | None | Starts the OAuth2 Device Code flow, emits `microsoft-device-code`, and returns the encrypted token & profile. |
| `refresh-microsoft` | `invoke` | `refreshToken` | Decrypts and refreshes a saved Microsoft session token. |
| `cancel-login-microsoft` | `send` | None | Aborts an active Device Code polling session. |
| `microsoft-device-code` | `receive` | `DeviceCodeInfo` | Delivers the `user_code` and `verification_uri` to the UI modal. |
| `delete-msa-cache` | `invoke` | None | Purges local Microsoft authentication cache files. |
| `fetch-mojang-profile` | `invoke` | `uuid` | Queries Mojang session servers via HTTPS proxy without CORS restrictions. |
| `fetch-mojang-raw-skin` | `invoke` | `url` | Downloads a skin texture and returns a `data:image/png;base64` URI. |
| `upload-mojang-skin` | `invoke` | `{ token, variant, filePath }` | Uploads a new skin texture or variant (`classic` / `slim`) to Minecraft Services. |

---

## 2. Launch, Java Runtime & Server Ping Channels (`src/main/ipc-game.js`)

| IPC Channel | Direction | Arguments | Description |
| --- | --- | --- | --- |
| `launch-game` | `send` | `LaunchGamePayload` | Verifies game libraries, builds JVM arguments, and spawns the Minecraft Java process. |
| `force-stop-game` | `invoke` | `instanceId` | Terminates a running Minecraft instance process. |
| `get-still-running` | `invoke` | None | Returns the list of currently active Minecraft instance IDs. |
| `check-java` | `invoke` | `javaPath` | Runs `java -version` and returns `{ valid, majorVersion, versionString }`. |
| `scan-java-versions` | `invoke` | None | Scans system directories and managed runtimes for installed JRE/JDKs. |
| `run-forge-installer` | `invoke` | `{ installerPath, javaExec, mcRoot }` | Runs a headless Forge or NeoForge installer JAR inside the sandbox. |
| `ping-server` | `invoke` | `address` | Pings a Minecraft server via TCP Server List Ping (SLP) and SRV DNS resolution. |
| `mc-progress` / `mc-data` / `mc-started` / `mc-close` | `receive` | Event payload | Streams download progress, game logs (`stdout`/`stderr`), start, and exit codes to the UI. |

---

## 3. Sandboxed Filesystem & System Operations (`src/main/ipc-fs.js` & `src/main/ipc-system.js`)

| IPC Channel | Direction | Arguments | Description |
| --- | --- | --- | --- |
| `fs:readFile` / `fs:writeFile` / `fs:readdir` / `fs:stat` / `fs:mkdir` / `fs:rm` / `fs:unlink` / `fs:rename` / `fs:cp` / `fs:copyFile` / `fs:exists` | `invoke` | Path & options | Confined filesystem operations verified by `assertPathUnderSandbox`. |
| `copy-image-to-sandbox` | `invoke` | `{ srcPath, destName, subDir }` | Validates extension and binary **Magic Bytes** before copying an image into the sandbox. |
| `copy-file-to-sandbox` | `invoke` | `{ srcPath, destName }` | Validates allowed import extensions and copies an archive/mod into the sandbox. |
| `extract-zip` / `compress-folder` / `read-zip-text` / `extract-tar` | `invoke` | Archive paths | Extracts or compresses archives in background worker threads with anti-Zip-Slip checks. |
| `nbt:parse` / `nbt:write` | `invoke` | Buffer / NBT root | Parses or serializes binary NBT files (`servers.dat`, `level.dat`). |
| `system:open-external` / `system:open-path` / `system:show-item-in-folder` | `invoke` | URL or path | Opens an HTTPS link in browser or reveals a sandboxed file in the OS file manager. |
| `update-discord` / `reconnect-discord` | `send` / `invoke` | Presence payload | Updates or reconnects Discord Rich Presence over the local IPC pipe. |

---

## 4. Horizon Cloud Engine Channels (`src/main/ipc-horizon.js`)

| IPC Channel | Direction | Arguments | Description |
| --- | --- | --- | --- |
| `get-horizon-settings` | `invoke` | None | Reads and decrypts local Horizon cloud configuration. |
| `save-horizon-settings` | `invoke` | `settings` | Encrypts and saves Horizon cloud configuration on disk. |
| `check-horizon-status` | `invoke` | None | Verifies whether `Horizon` is installed and validates its SHA-256 integrity. |
| `install-horizon` | `invoke` | None | Downloads and verifies the official `Horizon` binary from GitHub Releases. |
| `call-horizon` | `invoke` | `string[]` | Invokes `Horizon` with whitelisted flags (`--check`, `--sync`, `--upload`, `--rollback`, `--quota`, `--unlock`) and streams JSON events via `horizon-status`. |
| `horizon-status` / `horizon-install-progress` | `receive` | `HorizonEvent` | Delivers real-time JSON protocol events and binary download progress to the UI. |

---

## 5. Auto-Updater Channels (`src/main/updater.js`)

| IPC Channel | Direction | Arguments | Description |
| --- | --- | --- | --- |
| `check-for-updates` | `invoke` | None | Queries GitHub Releases to check if a new launcher version is available. |
| `download-update` / `confirm-update` | `send` | None | Starts downloading the update in background. |
| `do-deb-update` | `invoke` | None | Triggers an update for Debian/Ubuntu `.deb` installations. |
| `restart_app` | `send` | None | Quits the launcher and installs the downloaded update. |
| `update-available-prompt` / `update-progress` / `update-downloaded` | `receive` | Event payload | Notifies the UI of available updates, download progress, and readiness to install. |
