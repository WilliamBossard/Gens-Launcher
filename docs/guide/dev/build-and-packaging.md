# Build, Packaging, and CI/CD

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Tool-Tauri%20v2%20CLI-orange.svg" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-green.svg" alt="GitHub Actions" />
  <img src="https://img.shields.io/badge/Repository-Signed%20APT-red.svg" alt="APT" />
</div>

Gens-Launcher uses **Cargo + Tauri v2 (`tauri-action`)** to produce lightweight native installers for Windows, macOS, and Linux.

---

## 1. Development Prerequisites

- **Rust Toolchain:** Stable Rust (edition 2024) via `rustup`, with `clippy` and `rustfmt`.
- **Tauri CLI v2:** `cargo install tauri-cli --version "^2"`.
- **Node.js:** Version 22+ (only required for frontend TypeScript checks and building VitePress docs).
- **OS-Specific Dependencies:**
  - **Windows:** Visual Studio C++ Build Tools + WebView2 (built into Windows 10/11).
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`.
  - **macOS:** Xcode Command Line Tools.

---

## 2. Local Build & Verification Commands

```bash
# Start the launcher in development mode (hot-reloads Rust backend)
cargo tauri dev

# Strict Rust linting (0 warnings allowed)
cd src-tauri && cargo clippy --all-targets -- -D warnings

# Run Rust unit & security tests
cd src-tauri && cargo test

# Frontend TypeScript static analysis (0 errors allowed)
cd frontend && npx -y typescript@latest -p tsconfig.json --noEmit

# Build production installers for the current OS
cargo tauri build
```

Generated installers are placed in `src-tauri/target/release/bundle/`:
- **Windows:** `nsis/*-setup.exe` (includes `src-tauri/nsis/hooks.nsh` to silently uninstall legacy Electron installations)
- **Linux:** `deb/*.deb` and `appimage/*.AppImage`
- **macOS:** `dmg/*.dmg`

---

## 3. Packaging Configuration (`src-tauri/tauri.conf.json`)

The release profile in `src-tauri/Cargo.toml` optimizes for minimal binary size (`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`), yielding a ~11 MB Windows executable.

```json
{
  "productName": "Gens Launcher",
  "identifier": "com.gens.launcher",
  "build": {
    "frontendDist": "../frontend"
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "windows": {
      "nsis": {
        "installerHooks": "nsis/hooks.nsh"
      }
    }
  }
}
```

---

## 4. CI/CD Pipelines (`.github/workflows/`)

Gens-Launcher uses three automated GitHub Actions workflows:

1. **`ci.yml` (Continuous Integration):** Triggered on every `push` and `pull_request` to `main`/`master`. Runs `cargo clippy --all-targets -- -D warnings` and `cargo test` across `ubuntu-latest`, `windows-latest`, and `macos-latest`, plus frontend `tsc --noEmit`.
2. **`release.yml` (Multi-OS Release Builder):** Runs Clippy and Rust tests, compiles Windows/Linux/macOS bundles via `tauri-apps/tauri-action@v0`, and generates/uploads `latest.yml`, `latest-linux.yml`, and `latest-mac.yml` manifests (SHA-512) for seamless Electron → Rust and Rust → Rust auto-updates.
3. **`apt.yml` (Automated APT Repository & Docs Deployment):** Triggered on published release, compiles VitePress documentation (`npm --prefix docs run docs:build` → `website/`), downloads the `.deb` package, signs the APT repository with GPG (`Release.gpg`, `InRelease`), and deploys to GitHub Pages:

```text
[ GitHub Release Event ]
            |
            v
 [ Compile VitePress Docs (npm --prefix docs run docs:build -> website/) ]
            |
            v
 [ Download compiled .deb package ]
            |
            v
 [ Prepare apt-workspace/ staging area ]
   - Copy GPG public key (public.key)
   - Copy compiled website & docs (website/*)
            |
            v
 [ Build Debian APT index ]
   - dpkg-scanpackages --multiversion . > Packages
   - gzip -k -f Packages
   - apt-ftparchive release . > Release
            |
            v
 [ GPG Cryptographic Signatures ]
   - gpg -abs -o Release.gpg Release
   - gpg --clearsign -o InRelease Release
            |
            v
 [ Deploy to GitHub Pages ]
   - Atomically published at williambossard.github.io/Gens-Launcher/
```
