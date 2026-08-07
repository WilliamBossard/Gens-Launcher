# Gens Launcher

Modern and lightweight open-source Minecraft launcher based on Electron. Integrates a native catalog mod,shader,texture (Modrinth), secure Microsoft authentication, and advanced instance management inspired by MultiMC (Fabric/Forge, import/export, Java auto-detection).

<img width="884" height="593" alt="image" src="https://github.com/user-attachments/assets/a9d5026b-2db1-411d-9d77-03930b884fa0" />

## Key Features

- **Advanced Instance Management:** Create Vanilla, Forge, Fabric, Quilt, or NeoForge instances in just a few clicks.
- **Integrated Mod Browser:** Search, download, and update mods directly from Modrinth and CurseForge without leaving the app.
- **Microsoft Multi-Account Support:** Securely log in and manage multiple Microsoft accounts.
- **Enterprise-Grade Security:** File integrity verification (SHA1), strict HTTPS enforcement, and a "Safe Write" anti-corruption save system.
- **Windows Integration (Jump List):** Launch your favorite instances directly from the Windows taskbar via right-click.
- **Total Customization:** Dynamic themes, custom wallpapers, blur effects (Acrylic/Mica), and an option to disable animations for low-end PCs.
- **Discord Rich Presence:** Show off the instance you are currently playing directly on your Discord profile.

## Interface Preview

<img width="886" height="593" alt="image" src="https://github.com/user-attachments/assets/d0557c34-0b6c-4dff-835c-c55a3cfc754c" />

<img width="890" height="592" alt="image" src="https://github.com/user-attachments/assets/9694ea7b-1b97-410a-9cad-f3d69cb742a3" />

## Download and Installation Guide (USER)

Welcome to Gens Launcher! Here is how to install the software on your PC in just a few minutes.

### Step 1: Download the Installer
1. On this GitHub page, look on the right side under the **"Releases"** section and click on the latest release (e.g., `v1.5.0`).
2. Scroll down to the "Assets" section at the bottom and download the file for your Operating System:
   - **For Windows:** Download **`GensLauncher-Setup-1.5.0.exe`**
   - **For Linux (Debian/Ubuntu):** Download **`GensLauncher-1.5.0-amd64.deb`** *(an .AppImage version is also available).*

### Step 2: Run the Installation

**🔹 For Windows:**
1. Once the download is complete, double-click the `.exe` file to start the installation.
2. **Important (Windows Alert):** Because this launcher is an independent project, Windows Defender might display a blue screen saying *"Windows protected your PC"*. This is completely normal for unverified indie apps.
   - Simply click on the **"More info"** text.
   - Then click the **"Run anyway"** button.
3. Follow the on-screen instructions, leave the boxes checked to create shortcuts, and click "Install".

**🔹 For Linux (.deb):**
1. Once the `.deb` file is downloaded, double-click it to open your distribution's Software Center (like Ubuntu Software) and click **"Install"**.
2. *Alternatively, via terminal:* Open your terminal in the downloads folder and run:
   ```bash
   sudo apt install ./GensLauncher-1.5.0-amd64.deb
   ```

### Step 3: Play!
- Open Gens Launcher using the new shortcut on your Desktop or in your application menu.
- Click on the Microsoft button to log in securely with your Minecraft account.
- Create your first instance, download your mods, and enjoy the game!

## Advanced Features

- **Offline Mode:** Gens Launcher features a smart offline mode. When it detects no internet connection, it dynamically disables network-dependent actions (like Java downloads, Mod catalog, Horizon updates, and Discord RPC background pings) while allowing you to fully play your previously downloaded instances offline.
- **Horizon Cloud Sync Integration:** Seamlessly sync your instances across devices using the headless **Gens-Horizon** cloud engine. Connect your Google Drive, Dropbox, or OneDrive directly from the launcher to back up and restore your game data effortlessly using advanced Delta Sync technology.

## Installation & Build Guide (DEV)

### Prerequisites
- **Node.js** (version 18 or higher recommended)
- A Microsoft account with a valid Minecraft Java Edition license

### Local Development
Clone the repository:
```bash
git clone https://github.com/YourUsername/gens-launcher.git
cd gens-launcher
```

Install the dependencies:
```bash
npm install
```

Run the launcher in development mode:
```bash
npm start
```

### Compiling the App (Windows & Linux)
To generate the final professional installers ready to be distributed to players, run the following commands based on your target OS:

**For Windows (.exe):**
```bash
npm run dist:win
```

**For Linux (.deb & .AppImage):**
```bash
npm run dist:linux
```

**For all platforms:**
```bash
npm run dist:all
```

The generated executables will be located in the `dist/` folder.

## Contributing
Contributions are always welcome! Feel free to open an Issue to report a bug or suggest a feature, or submit a Pull Request.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.

*(Note: Minecraft is a trademark of Mojang Synergies AB. This project is not affiliated with Mojang or Microsoft).*
