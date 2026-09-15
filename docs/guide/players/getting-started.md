# Getting Started with Gens Launcher

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Minecraft-Vanilla%20%26%20Modded-green.svg" alt="Minecraft" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg" alt="Platforms" />
  <img src="https://img.shields.io/badge/License-MIT-orange.svg" alt="License" />
</div>

Welcome to the official documentation of **Gens Launcher**. This guide walks you step-by-step through discovering the launcher, connecting your Minecraft account, and launching your first gaming session.

---

## Why Gens Launcher?

Gens Launcher was engineered from the ground up to combine **maximum performance**, **sleek modern ergonomics**, and **uncompromising security**:

- **Lightweight and Blazing Fast:** Built with zero unnecessary third-party bloatware, the launcher boots instantly and consumes negligible system memory.
- **Multi-Modloader Freedom:** Seamlessly create and play **Vanilla**, **Fabric**, **Forge**, **Quilt**, or **NeoForge** profiles in just a few clicks.
- **Horizon Cloud Sync:** Powered by the companion **Gens-Horizon** engine, automatically back up and sync your worlds, options, and mods with Google Drive, Dropbox, or OneDrive.
- **Integrated Content Catalog:** Search and install mods, resource packs, and shaders directly from Modrinth and CurseForge without ever leaving the launcher.
- **100% Privacy Focused:** Free and open-source under the MIT license, with zero corporate telemetry or tracking.

---

## Logging In to Your Minecraft Account

Gens Launcher supports two modes of authentication:

### 1. Official Microsoft Account (Recommended)
1. Click the **Log In with Microsoft** button located in the top-right corner of the home screen.
2. A modal dialog will appear displaying a short code (e.g., `B49X-Y2K9`) and a direct link to `microsoft.com/link`.
3. Confirm the login code in your regular web browser with your Microsoft account owning Minecraft Java Edition.
4. The launcher automatically detects approval, pulls your custom 3D skin preview, and securely encrypts your tokens using OS-level secure storage.

::: tip Maximum Security
Gens Launcher never sees or stores your Microsoft password. Authentication is completed via Microsoft's official OAuth2 Device Code Flow.
:::

### 2. Offline / Local Player Mode
If you don't have an active Internet connection or wish to play on a local area network (LAN):
1. Click on the **Offline Mode / Local Username** option.
2. Enter your desired player name.
3. You can now launch any previously installed instance locally.

---

## Exploring the Interface

The interface of Gens Launcher is organized into 4 main areas:

1. **Instance Gallery:** Visually displays all your configured game profiles with their Minecraft version, modloader icon, and cloud sync status.
2. **Launch Action Bar:** Provides a single-click button to start the selected profile. A dynamic progress bar visualizes asset downloads, delta sync patching, and Java startup.
3. **Content Manager:** Dedicated browser to find and add mods, shaders, and texture packs in one click.
4. **Settings Panel:** Theme customization, RAM allocation, Java runtime selection, and Cloud Provider connections.

---

## Next Steps

- [Multi-OS Installation Guide](./installation)
- [Managing Instances and Installing Mods](./instances-and-mods)
- [Setting Up Horizon Cloud Sync](./cloud-sync)
- [FAQ and Troubleshooting](./troubleshooting)
