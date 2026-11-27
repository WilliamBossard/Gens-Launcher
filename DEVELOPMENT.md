# Gens-Launcher — Comprehensive Development Guide (Rust + Tauri v2)

This document describes the architecture, security model, data flows, and development best practices for the **Gens-Launcher** project (**Rust + Tauri v2**). It serves as a technical reference (Single Source of Truth) for any contributor or security auditor.

Detailed developer documentation is also available in `docs/guide/dev/` (English) and `docs/fr/guide/dev/` (French).

---

## 1. Overview & Global Architecture

Gens-Launcher is the official Graphical User Interface (GUI) of the Gens ecosystem. Built on **Rust + Tauri v2** with a zero-build-step strict TypeScript-checked frontend, its role is to:

1. Manage secure player authentication via the Microsoft/Xbox Live OAuth2 API.
2. Download, verify, and launch Minecraft (Vanilla, Fabric, Quilt, Forge, NeoForge) natively in Rust.
3. Asynchronously interact with **Gens-Horizon**, the headless cloud synchronization engine of the ecosystem.

The architecture separates responsibilities across three strict layers: the **Rust Core Backend (`src-tauri/src/`)**, the **Tauri IPC Security Bridge (`frontend/src/tauri-bridge.js`)**, and the **WebView Frontend (`frontend/`)**.

---

## 2. Component Topology

### 2.1 Rust Backend (`src-tauri/src/`)

Compiled natively with Rust (edition 2024) and Tokio async runtime. It owns all filesystem, network, cryptographic, and child-process operations:

- **`main.rs`**: Tauri v2 application entry point. Configures the system tray, single-instance lock, `--auto-launch=` deep-link parsing, `AppState`, and IPC command dispatchers (`ipc_invoke`, `ipc_send`).
- **`game.rs`**: Full native Rust Minecraft launch engine (Vanilla / Fabric / Quilt / Forge / NeoForge), ForgeWrapper support, Mojang rule/arch evaluation, concurrent asset/library downloads with SHA-1 verification, Java scanner, SHA-256 verified Adoptium JRE installer, and Forge installer runner.
- **`game_validation.rs`**: Security validators for launch overrides, Java executables, dangerous JVM arguments (`-javaagent`, `-agentlib`, `--add-opens`, etc.), sensitive Minecraft flags, and HTTPS download domain allowlists.
- **`sandbox.rs`**: Dual-layer path confinement (lexical normalization + anti-symlink/junction canonicalization), UNC path blocking, renderer denylist (`.secret_key`, `.key_salt`, `horizon_seal.key`, `trusted_external_domains.json`, `github_release_cache.json`), protected delete roots, and atomic file writes with Windows lock retries.
- **`fs_ops.rs`**: Confined filesystem IPC handlers (`fs:*`) enforcing `sandbox.rs`, encoding allowlists, and `MAX_IPC_READ_BYTES` (64 MiB anti-OOM) / `fs:readTail` bounds.
- **`crypto.rs`**: Windows DPAPI (direct FFI to `crypt32.dll`), seamless Chromium/Electron `safeStorage:` (`Local State` + AES-256-GCM) decryption for Windows migration, `v2:` legacy support, PBKDF2 (600,000 iterations) + AES-256-GCM fallback, pure-Rust RFC 1321 MD5, and SHA-1 / SHA-256 / SHA-512 hashing.
- **`network.rs`**: Streaming file downloads (`reqwest` + `rustls`), Modrinth & CurseForge proxies, Microsoft OAuth2 Device Code authentication & token refresh, Mojang profile/skin proxy, and Magic Bytes validation (`PNG`, `JPEG`, `GIF`, `WEBP`, `BMP`, `ICO`, `ZIP`) for sandboxed uploads.
- **`archive.rs`**: Zip-Slip-safe ZIP extraction/compression and pure-Rust USTAR / GNU LongName / PAX `.tar.gz` extraction rejecting symlinks, hardlinks, path traversal, and Zip Bombs (> 4 GiB).
- **`horizon.rs`**: Exclusive communication bridge with `Horizon.exe` / `Horizon`. Verifies SHA-256 integrity against official GitHub releases, enforces a strict CLI flag whitelist, and manages E2E / selective sync settings.
- **`updater.rs`**: Native auto-updater compatible with `electron-updater` manifests (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) with mandatory SHA-512 verification, plus Linux APT `.deb` update support.
- **`system.rs`**: Persistent main-process logging, OS memory inspection (`GlobalMemoryStatusEx` / `/proc/meminfo` / `sysctl`), trusted external URL opener with user confirmation dialog, passive-file whitelist for `open_path`, desktop shortcuts (Win32 COM `.lnk` / `.desktop`), and redacted diagnostic ZIP export.
- **`discord.rs`**: Pure-Rust Discord Rich Presence IPC client (Named Pipes on Windows, Unix domain sockets on Linux/macOS) with PING/PONG/CLOSE opcodes, 15s rate limiting, and exponential backoff.
- **`ping.rs`**: Pure-Rust Minecraft Server List Ping (TCP + VarInt framing + anti-SSRF private/reserved IP blocking + XSS-safe MOTD HTML renderer).
- **`nbt.rs`**: Pure-Rust binary NBT parser (GZIP & uncompressed) with nesting depth and size bounds.
- **`encoding.rs`**: Zero-dependency base64 and hex codecs.

### 2.2 The Security Bridge (`frontend/src/tauri-bridge.js`)

- Exposes a 1:1 `window.api` contract over Tauri v2 (`__TAURI__.core.invoke` / `__TAURI__.event.listen`).
- Enforces static channel whitelists (`VALID_SEND_CHANNELS`, `VALID_INVOKE_CHANNELS`, `VALID_RECEIVE_CHANNELS`).
- Maps local image paths via Tauri's `asset://` protocol (`convertFileSrc`) scoped to `$APPDATA/GensLauncher/**`.
- Restricts `window.api.security.writeJSON` to `accounts.json` and `cf_api_key.enc`.

### 2.3 Frontend (`frontend/`)

- **`frontend/renderer.js` & `frontend/src/ui/*`, `launch/*`, `archives/*`, `local/*`**: Lightweight modular ES interface with zero direct OS/Node access. All system interactions pass asynchronously through `window.api`.

---

## 3. Security Design

The application follows the **Defense in Depth** principle:

1. **Native WebView Isolation & Tauri Capabilities**: The WebView has no direct filesystem, shell, or Node.js access; every privileged operation is mediated by audited Rust handlers.
2. **Anti-Traversal & Anti-Symlink Sandbox (`sandbox.rs`)**: All paths are validated lexically and via canonical `realpath` resolution to block symlink/junction escapes, UNC shares, and Zip/Tar Slip attacks. Writing is strictly confined to `$APPDATA/GensLauncher`.
3. **Strict CSP (`tauri.conf.json`)**: Enforces `script-src 'self'`, `style-src 'self'`, `object-src 'none'`, `frame-src 'none'`, and explicit HTTPS allowlists for `img-src` and `connect-src`.
4. **Encryption (`crypto.rs`)**: Local Microsoft tokens and CurseForge API keys are encrypted via Windows DPAPI or **PBKDF2 (600,000 iterations) + AES-256-GCM**, with automatic migration from Electron `safeStorage:` on Windows.
5. **Static IPC Whitelist**: All channels (`send`, `invoke`, `receive`) are statically whitelisted in `frontend/src/tauri-bridge.js` and typed in `frontend/src/types/ipc.ts`.
6. **HTTPS & Domain Allowlists (`game_validation.rs`)**: Remote downloads enforce `https:` and domain allowlists; multi-tenant hosts (GitHub/GitLab) require hash verification.
7. **Binary Magic Bytes Verification (`network.rs`)**: Uploaded images and archives are verified by both extension and binary header signature before entering the sandbox.
8. **Smart Offline Mode**: `frontend/src/uiCore.js` dynamically locks network-dependent actions and suppresses background pings when offline.

---

## 4. Verification & Static Analysis

Gens-Launcher combines **zero-warning Rust** with a **zero-build-step TypeScript-checked frontend** (`frontend/tsconfig.json` with `allowJs: true`, `checkJs: true`, `strict: true`, `noEmit: true`):

```bash
# 1. Rust static lint (must pass with 0 warnings)
cd src-tauri
cargo clippy --all-targets -- -D warnings

# 2. Rust unit & security test suite
cargo test

# 3. Frontend TypeScript static analysis (must report 0 errors)
cd ../frontend
npx -y typescript@latest -p tsconfig.json --noEmit
```

---

## 5. Deployment and Multi-Distribution Pipelines

The Launcher is packaged and distributed across Windows, Linux, and macOS via GitHub Actions:

### 5.1 Artifacts & Target Platforms

- **Windows**: NSIS Installer (`*-setup.exe`) with `src-tauri/nsis/hooks.nsh` pre-install hook to silently remove legacy Electron installations without losing user data.
- **Linux**:
  - **APT Repository (Debian/Ubuntu)**: Official GPG-signed repository deployed to GitHub Pages (`apt.yml`).
  - **AppImage**: Standalone portable executable with built-in SHA-512 verified auto-updater.
- **macOS**: DMG disk image (`.dmg`).

### 5.2 GitHub Actions Workflows

1. **`ci.yml`**: Runs on every push and PR across `ubuntu-latest`, `windows-latest`, and `macos-latest`, executing `cargo clippy --all-targets -- -D warnings`, `cargo test`, and frontend `tsc --noEmit`.
2. **`release.yml`**: Runs Clippy and tests, builds cross-platform bundles via `tauri-apps/tauri-action`, and generates/uploads `latest.yml`, `latest-linux.yml`, and `latest-mac.yml` manifests compatible with both Electron (`electron-updater`) and Rust (`updater.rs`).
3. **`apt.yml`**: Triggered on published release, compiles VitePress documentation (`npm --prefix docs run docs:build`), pulls the `.deb` package, signs the APT repository with GPG (`Release.gpg`, `InRelease`), and deploys to GitHub Pages.

### 5.3 Code Signing

*Not applicable — Gens Launcher is a free open-source project without a commercial EV certificate. On Windows, SmartScreen may display an initial warning on unverified installers ("More info" → "Run anyway"). All source code and build workflows are 100% public and auditable.*
