#  Gens Launcher

Gens Launcher is a modern, secure, and highly customizable Minecraft launcher built with Electron and Node.js. Designed to offer a seamless experience, it features advanced instance management, integrated mod downloading, and performance optimization tools.

<img width="884" height="593" alt="image" src="https://github.com/user-attachments/assets/a9d5026b-2db1-411d-9d77-03930b884fa0" />


##  Key Features

- **Advanced Instance Management:** Create Vanilla, Forge, Fabric, Quilt, or NeoForge instances in just a few clicks.
- **Integrated Mod Browser:** Search, download, and update mods directly from Modrinth and CurseForge without leaving the app.
- **Microsoft Multi-Account Support:** Securely log in and manage multiple Microsoft accounts.
- **Enterprise-Grade Security:** File integrity verification (SHA1), strict HTTPS enforcement, and a "Safe Write" anti-corruption save system.
- **Windows Integration (Jump List):** Launch your favorite instances directly from the Windows taskbar via right-click.
- **Total Customization:** Dynamic themes, custom wallpapers, blur effects (Acrylic/Mica), and an option to disable animations for low-end PCs.
- **Discord Rich Presence:** Show off the instance you are currently playing directly on your Discord profile.

##  Interface Preview

<img width="886" height="593" alt="image" src="https://github.com/user-attachments/assets/d0557c34-0b6c-4dff-835c-c55a3cfc754c" />

<img width="890" height="592" alt="image" src="https://github.com/user-attachments/assets/9694ea7b-1b97-410a-9cad-f3d69cb742a3" />

##  Download and Installation Guide (USER)

Welcome to Gens Launcher! Here is how to install the software on your PC in just a few minutes.

### Step 1: Download the Installer
1. On this GitHub page, look on the right side under the **"Releases"** section and click on the latest release (e.g., `v1.5.0`).
2. Scroll down to the "Assets" section at the bottom and click on the file named **`GensLauncher-Setup-1.5.0.exe`** to download it.

### Step 2: Run the Installation
1. Once the download is complete, double-click the `.exe` file to start the installation.
2.  **Important (Windows Alert):** Because this launcher is an independent project, Windows Defender might display a blue screen saying *"Windows protected your PC"*. This is completely normal for unverified indie apps.
   - Simply click on the **"More info"** text.
   - Then click the **"Run anyway"** button.

### Step 3: Setup
1. The Gens Launcher installer will open.
2. Follow the on-screen instructions (you will be able to choose the installation folder on your hard drive).
3. Leave the boxes checked if you want to create a shortcut on your Desktop and in your Start menu.
4. Click "Install".

### Step 4: Play!
1. Open Gens Launcher using the new shortcut on your Desktop.
2. Click on the Microsoft button to log in securely with your Minecraft account.
3. Create your first instance, download your mods, and enjoy the game! 

##  Installation & Build Guide (DEV)

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or higher recommended)
- A Microsoft account with a valid Minecraft Java Edition license

### Local Development
1. Clone the repository:
   git clone [https://github.com/YourUsername/gens-launcher.git](https://github.com/YourUsername/gens-launcher.git)
   cd gens-launcher
Install the dependencies:

npm install

Run the launcher in development mode:

npm start

 Compiling the App (Windows .exe)
To generate the final professional installer (Setup) ready to be distributed to players:

npm run dist

The generated executable will be located in the dist/ folder.

 Contributing
Contributions are always welcome! Feel free to open an Issue to report a bug or suggest a feature, or submit a Pull Request.

 License
This project is licensed under the MIT License. See the LICENSE file for more details.
(Note: Minecraft is a trademark of Mojang Synergies AB. This project is not affiliated with Mojang or Microsoft).
