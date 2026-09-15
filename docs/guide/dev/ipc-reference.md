# IPC Channel Reference

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Protocol-Async%20IPC-blue.svg" alt="Protocol" />
  <img src="https://img.shields.io/badge/Access-Static%20Whitelist-green.svg" alt="Access" />
  <img src="https://img.shields.io/badge/Preload-contextBridge-orange.svg" alt="Preload" />
</div>

All communication between the Renderer Process (DOM) and the Main Process (Node.js) is gated behind a **static whitelist** enforced in `preload.js`. Invocations targeting unlisted channels are rejected with a security exception.

---

## 1. Authentication Channels (`src/main/ipc-auth.js`)

| IPC Channel | Type | Arguments | Description |
|---|---|---|---|
| `auth:start-device-flow` | `invoke` | None | Starts Microsoft Device Code Flow, returning the user code and login URI. |
| `auth:poll-device-flow` | `invoke` | `deviceCode` | Polls the token endpoint until the user confirms authorization in browser. |
| `auth:save-account` | `invoke` | `accountData` | Encrypts and persists credentials in local secure storage. |
| `auth:get-accounts` | `invoke` | None | Lists saved accounts with sensitive secrets redacted. |
| `auth:remove-account` | `invoke` | `uuid` | Deletes saved credentials and revokes cached tokens on disk. |
| `auth:proxy-skin` | `invoke` | `skinUrl` | Acts as an HTTPS proxy to load remote skin textures without CORS errors. |

---

## 2. Launch and Runtime Channels (`src/main/ipc-game.js`)

| IPC Channel | Type | Arguments | Description |
|---|---|---|---|
| `game:launch-instance` | `invoke` | `instanceConfig` | Resolves game libraries, checks hashes, builds JVM flags, and executes Java. |
| `game:kill-process` | `invoke` | `instanceId` | Dispatches `SIGTERM` followed by `SIGKILL` to running Minecraft instances. |
| `game:detect-java` | `invoke` | None | Scans common system directories and returns installed JDK / JRE runtimes. |
| `game:download-java` | `invoke` | `majorVersion` | Downloads and unpacks an official Adoptium Temurin Java archive. |
| `game:stream-logs` | `send / on` | Stream payload | Forwards Minecraft standard out and error streams to the UI console. |

---

## 3. System and File Operations (`src/main/ipc-system.js`)

| IPC Channel | Type | Arguments | Description |
|---|---|---|---|
| `system:show-in-folder` | `invoke` | `targetPath` | Reveals the file or folder in native Explorer, Finder, or Nautilus. |
| `system:open-dialog-file` | `invoke` | `options` | Opens a native dialog to choose a file (.zip, .jar). |
| `system:open-dialog-folder` | `invoke` | `options` | Opens a native dialog to pick a destination folder. |
| `system:copy-image-to-sandbox` | `invoke` | `srcPath, destName, subDir` | Validates file extension and **Magic Bytes** before writing into the sandbox. |
| `system:discord-set-activity` | `invoke` | `activityPayload` | Emits Rich Presence status updates to the local Discord client over Named Pipe. |
| `system:discord-clear` | `invoke` | None | Clears the current active game status on Discord. |

---

## 4. Horizon Engine Channels (`src/main/ipc-horizon.js`)

| IPC Channel | Type | Arguments | Description |
|---|---|---|---|
| `horizon:check` | `invoke` | None | Queries remote cloud index and reports synchronization differences. |
| `horizon:login` | `invoke` | `providerName` | Triggers OAuth2 authorization for Google Drive, Dropbox, or OneDrive. |
| `horizon:sync` | `invoke` | `instanceName` | Pulls and chronologically applies missing delta packages to the local instance. |
| `horizon:upload` | `invoke` | `instanceName` | Scans local changes, builds a differential delta archive, and uploads to cloud. |
| `horizon:quota` | `invoke` | None | Queries total, used, and free storage from the connected cloud provider. |
| `horizon:rollback` | `invoke` | `instanceName, deltaId` | Restores an instance to a selected historical snapshot. |
| `horizon:purge-lock` | `invoke` | None | Removes an orphaned `horizon.lock` file following process verification. |

---

## 5. Auto-Updater Channels (`src/main/updater.js`)

| IPC Channel | Type | Arguments | Description |
|---|---|---|---|
| `updater:check-for-updates` | `invoke` | None | Queries GitHub Releases to determine whether an update is available. |
| `updater:download-update` | `invoke` | None | Downloads the installer in the background with progress feedback. |
| `updater:quit-and-install` | `invoke` | None | Quits the launcher and applies the new update bundle. |
