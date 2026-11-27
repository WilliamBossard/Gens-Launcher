# Gens Launcher

Modern, lightweight, and secure open-source Minecraft launcher powered by **Rust + Tauri v2**. Integrates a native mod, shader, and resource pack catalog (Modrinth & CurseForge), secure Microsoft authentication, Horizon Delta Cloud Sync, and advanced instance management (Vanilla, Fabric, Forge, Quilt, NeoForge, import/export, Java auto-detection & Adoptium installer).

<img width="884" height="593" alt="image" src="https://github.com/user-attachments/assets/a9d5026b-2db1-411d-9d77-03930b884fa0" />

## Key Features

- **Ultra-Lightweight Native Core (Rust + Tauri v2):** ~11 MB native binary with minimal RAM footprint, Tokio async I/O, parallel downloads, and zero bundled Chromium bloat.
- **Advanced Instance Management:** Create Vanilla, Forge, Fabric, Quilt, or NeoForge instances in just a few clicks, with automatic Java detection and SHA-256 verified Adoptium JRE installation.
- **Integrated Mod Browser:** Search, download, and update mods, shaders, and resource packs directly from Modrinth and CurseForge without leaving the app.
- **Microsoft Multi-Account Support:** Securely log in (OAuth2 Device Code Flow) and manage multiple Microsoft accounts.
- **Enterprise-Grade Security:** File integrity verification (SHA-1 / SHA-256 / SHA-512), lexical + anti-symlink sandbox confinement, HTTPS allowlist enforcement, Windows DPAPI (+ seamless Electron `safeStorage` migration) & PBKDF2/AES-256-GCM encryption, strict CSP, and atomic "Safe Write" saves.
- **Seamless Electron → Rust Auto-Updater:** Compatible with `electron-updater` manifests (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) and Windows NSIS legacy cleanup hook for smooth upgrades.
- **Strict Static Typing:** Zero-warning Rust (`cargo clippy --all-targets -- -D warnings`) combined with 100% static TypeScript checking (`checkJs: true`, `strict: true`) across the frontend.
- **Linux APT Repository:** Install and update Gens Launcher on Debian/Ubuntu systems using the official GPG-signed APT repository.
- **Total Customization:** Dynamic themes, custom wallpapers, and an option to disable animations for low-end PCs.
- **Discord Rich Presence:** Native pure-Rust Named Pipe / Unix Socket RPC client showing your active instance on Discord.

## Interface Preview

<img width="886" height="593" alt="image" src="https://github.com/user-attachments/assets/d0557c34-0b6c-4dff-835c-c55a3cfc754c" />

<img width="890" height="592" alt="image" src="https://github.com/user-attachments/assets/9694ea7b-1b97-410a-9cad-f3d69cb742a3" />

## Download and Installation Guide (USER)

Welcome to Gens Launcher! Here is how to install the software on your PC in just a few minutes.

### Step 1: Download the Installer

1. On this GitHub page, look on the right side under the **"Releases"** section and click on the latest release.
2. Scroll down to the "Assets" section at the bottom and download the file for your Operating System:
   - **For Windows (Installer):** Download **`Gens-Launcher_X.X.X_x64-setup.exe`**
   - **For Linux (Debian/Ubuntu via APT):** Use the official APT repository (see below)
   - **For Linux (AppImage):** Download **`Gens-Launcher_X.X.X_amd64.AppImage`**
   - **For macOS:** Download **`Gens-Launcher_X.X.X_universal.dmg`** (or architecture-specific `.dmg`)

### Step 2: Run the Installation

#### For Windows: Setup Installer (.exe)

1. Once the download is complete, double-click the `.exe` file to start the installation.
2. **Important (Windows Alert):** Because this launcher is an independent open-source project, Windows Defender might display a blue screen saying *"Windows protected your PC"*.
   - Click **"More info"**, then click **"Run anyway"**.
3. Follow the on-screen instructions. If you are upgrading from an older Electron version of Gens Launcher, the installer automatically cleans up the legacy installation while preserving all your instances, mods, settings, and Microsoft accounts.

#### For Linux - Option A: APT Repository (Debian/Ubuntu)

This method integrates Gens Launcher into your system's package manager, so it updates automatically with `apt upgrade` like any other application.

Run these 3 commands in your terminal once:

```bash
# 1. Add the trusted signing key
curl -fsSL https://williambossard.github.io/Gens-Launcher/public.key | sudo gpg --dearmor -o /usr/share/keyrings/gens-launcher-keyring.gpg

# 2. Add the repository to your sources
echo "deb [signed-by=/usr/share/keyrings/gens-launcher-keyring.gpg] https://williambossard.github.io/Gens-Launcher/ ./" | sudo tee /etc/apt/sources.list.d/gens-launcher.list

# 3. Install!
sudo apt update && sudo apt install gens-launcher
```

To update in the future:

```bash
sudo apt update && sudo apt upgrade gens-launcher
```

#### For Linux - Option B: AppImage (Universal, no install required)

1. Right-click the `.AppImage` file and select **Properties**.
2. Go to the **Permissions** tab and check **"Allow executing file as program"**.
3. Double-click the `.AppImage` to launch Gens Launcher!

#### For macOS (.dmg)

1. Double-click the downloaded `.dmg` file to open it.
2. Drag and drop the **Gens Launcher** icon into the **Applications** folder shortcut.
3. Launch the app from your Applications folder.

### Step 3: Play

- Open Gens Launcher using the shortcut on your Desktop or in your application menu.
- Click on the Microsoft button to log in securely with your Minecraft account.
- Create your first instance, download your mods, and enjoy the game!

## Advanced Features

- **Offline Mode:** Smart offline mode dynamically disables network-dependent actions (Java downloads, Mod catalog, Horizon updates, Discord RPC pings) while allowing you to launch your locally installed instances offline.
- **Horizon Cloud Sync Integration:** Seamlessly sync your instances across devices using the headless **Gens-Horizon** cloud engine (Google Drive, Dropbox, OneDrive) with Delta Sync and optional E2E encryption.

## Installation & Build Guide (DEV)

### Prerequisites

- **Rust Toolchain** (`rustup` — edition 2024, `cargo`, `clippy`)
- **Tauri CLI v2** (`cargo install tauri-cli --version "^2"`)
- **Node.js** (version 22+ — only needed for frontend TypeScript checks and VitePress docs)
- **OS-specific Tauri v2 dependencies:**
  - **Windows:** MSVC Build Tools + WebView2 (pre-installed on Windows 10/11)
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`
  - **macOS:** Xcode Command Line Tools

### Local Development

Clone the repository:

```bash
git clone https://github.com/WilliamBossard/Gens-Launcher.git
cd Gens-Launcher
```

Run the launcher in development mode:

```bash
cargo tauri dev
```

Run static checks (zero warnings) and automated tests:

```bash
# Rust lint & unit tests
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test

# Frontend TypeScript strict check
cd ../frontend
npx -y typescript@latest -p tsconfig.json --noEmit
```

### Compiling the App (Windows, macOS & Linux)

Build native production installers for your current platform:

```bash
cargo tauri build
```

Generated installers and binaries are located in `src-tauri/target/release/bundle/` (`nsis/`, `deb/`, `appimage/`, `dmg/`).

### Documentation (VitePress)

```bash
npm --prefix docs install
npm --prefix docs run docs:dev
npm --prefix docs run docs:build
```

## Contributing

Contributions are always welcome! Feel free to open an Issue to report a bug or suggest a feature, or submit a Pull Request.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.

*(Note: Minecraft is a trademark of Mojang Synergies AB. This project is not affiliated with Mojang or Microsoft).*
