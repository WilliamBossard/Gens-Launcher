# Multi-Platform Installation

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-blue.svg" alt="Windows" />
  <img src="https://img.shields.io/badge/macOS-Intel%20%26%20Apple%20Silicon-lightgrey.svg" alt="macOS" />
  <img src="https://img.shields.io/badge/Linux-AppImage%20%26%20APT-red.svg" alt="Linux" />
</div>

Gens Launcher is natively available on **Windows**, **macOS**, and **Linux**. Follow the instructions below to set up the software on your operating system.

---

## Windows (10 and 11)

### Download and Setup
1. Navigate to the [Latest GitHub Releases](https://github.com/WilliamBossard/Gens-Launcher/releases/latest).
2. Download the installer file: **`GensLauncher-Setup-X.X.X.exe`**.
3. Double-click the downloaded executable to begin the NSIS setup wizard.

::: warning Windows Defender SmartScreen Alert
Gens Launcher is an independent open-source project. Because the project does not have an expensive commercial corporate certificate (EV Code Signing, costing hundreds of dollars per year), Windows SmartScreen may display a blue warning:  
*"Windows protected your PC"*.

**To continue installation:**
1. Click the text link **"More info"**.
2. Click the **"Run anyway"** button.
3. All source code is completely public and auditable on GitHub; the software is safe.
:::

---

## macOS (Intel and Apple Silicon)

1. Download the disk image **`GensLauncher-X.X.X-mac.dmg`** from the [GitHub Releases](https://github.com/WilliamBossard/Gens-Launcher/releases/latest).
2. Double-click the `.dmg` file to mount the installation volume.
3. Drag and drop the **Gens Launcher** icon into your **Applications** folder shortcut.

::: danger Mandatory Applications Folder
You must copy the app into `/Applications`. If you launch the app directly from the virtual mounted DMG image, the auto-updater will fail to install background updates.
:::

---

## Linux

We offer two packaging formats for Linux distributions:

### Option 1: Official Signed APT Repository (Recommended for Debian and Ubuntu)
This is the recommended route: it hooks Gens Launcher into your OS package manager for background updates via `apt upgrade`.

Open your terminal and run these 3 commands:

```bash
# 1. Download and import the official GPG signing key
curl -fsSL https://williambossard.github.io/Gens-Launcher/public.key | sudo gpg --dearmor -o /usr/share/keyrings/gens-launcher-keyring.gpg

# 2. Add the Gens Launcher repository to your apt sources
echo "deb [signed-by=/usr/share/keyrings/gens-launcher-keyring.gpg] https://williambossard.github.io/Gens-Launcher/ ./" | sudo tee /etc/apt/sources.list.d/gens-launcher.list

# 3. Update repositories and install Gens Launcher
sudo apt update && sudo apt install gens-launcher
```

To update in the future:
```bash
sudo apt update && sudo apt --only-upgrade install gens-launcher
```

### Option 2: Universal AppImage Package
AppImage runs on any modern Linux distribution (Fedora, Arch Linux, Manjaro, Debian, Ubuntu) without installation:

1. Download the **`GensLauncher-X.X.X.AppImage`** file.
2. Grant execution rights:
   - **Terminal:**
     ```bash
     chmod +x GensLauncher-*.AppImage
     ./GensLauncher-*.AppImage
     ```
   - **File Manager:** Right-click file -> *Properties* -> *Permissions* tab -> check *"Allow executing file as program"*.
3. Double-click the AppImage to launch the game.

---

## System Requirements

| Component | Minimum Specification | Recommended Specification |
|---|---|---|
| **Operating System** | Windows 10 (64-bit), macOS 11+, Linux 64-bit | Windows 11, macOS 14+, Ubuntu 24.04 LTS |
| **System RAM** | 4 GB | 8 to 16 GB |
| **Free Disk Space** | 2 GB for launcher and vanilla Minecraft | 10+ GB (for larger modpacks and shader caches) |
| **Java Runtime** | Java 8, 17, or 21 (depending on Minecraft version) | **Managed automatically by Gens Launcher** |
