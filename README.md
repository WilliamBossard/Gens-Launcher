# Gens Launcher

Gens Launcher is a lightweight, open-source Minecraft launcher designed for power users. It combines the clean, efficient workflow of MultiMC with modern integrated features like a mod catalog and Microsoft authentication.

## Key Features

### Instance Management
- **Multi-Instance Support**: Create and manage multiple isolated Minecraft installations.
- **Auto-Modding**: Native support for **Fabric** and **Forge** with one-click installation.
- **Clone & Share**: Duplicate your entire instance folder or export it as a `.zip` file to share with friends.

### Integrated Mod Catalog
- **Modrinth Integration**: Search and install thousands of mods directly from the launcher.
- **Mod Manager**: Enable or disable local mods with a single click (automatically renames to `.disabled`).

### Profiles & Security
- **Official Microsoft Login**: Full support for official Premium accounts via secure IPC bridge.
- **Offline Mode**: Play without an internet connection using local profiles.
- **3D Avatars**: Automatic skin fetching for all profiles.

### Professional Settings
- **Precise RAM Control**: Allocate memory in MB via a visual slider or manual input.
- **Custom Java Paths**: Set specific Java executables and JVM arguments per instance.
- **Custom Resolution**: Force specific window sizes for the game.
- **Live Logs**: Built-in console to debug mod crashes in real-time.

## Getting Started

1. Download the latest version from the **[Releases](https://github.com/WilliamBossard/Gens-Launcher/releases)** tab.
2. Run the `GensLauncher-Setup.exe` file.
3. Add your account, create an instance, and hit **Play**!
   <img width="889" height="628" alt="image" src="https://github.com/user-attachments/assets/19110e3e-294e-4bd1-b554-66ab3640650b" />


## Development (For Developers)

If you want to contribute or build the project from source:

# Clone the repository
git clone [https://github.com/WilliamBossard/Gens-Launcher.git](https://github.com/WilliamBossard/Gens-Launcher.git)

# Install dependencies
npm install

# Run in development mode
npm start

# Build the executable
npm run dist
Technical Stack
Framework: Electron.js

MC Engine: Minecraft-launcher-core

Authentication: MSMC (Microsoft Auth for Minecraft)

APIs: Modrinth (Mods catalogue) & MC-Heads (3D Skins)

Developed with ❤️ by William Bossard
