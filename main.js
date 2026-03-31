const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { Auth } = require("msmc");
const { autoUpdater } = require("electron-updater");

// Désactiver temporairement la vérification stricte des certificats (utile pour GitHub sans signature)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let mainWindow;

const logPath = path.join(app.getPath("userData"), "main-process.log");
function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    console.log(msg);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 1000, minHeight: 600,
    icon: path.join(__dirname, "assets/icon.ico"),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile("index.html");
  fs.writeFileSync(logPath, "--- Gens Launcher Main Log ---\n");
}

app.whenReady().then(() => {
  createWindow();

  // --- CONFIGURATION UPDATER ---
  autoUpdater.logger = { info: (m) => mainLog(m), warn: (m) => mainLog("WARN: "+m), error: (m) => mainLog("ERR: "+m) };
  
  // Simuler un navigateur pour éviter le blocage GitHub
  autoUpdater.requestHeaders = { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" 
  };

  // Optionnel : permettre le test en mode dev si le fichier dev-app-update.yml existe
  if (!app.isPackaged && fs.existsSync(path.join(__dirname, 'dev-app-update.yml'))) {
      autoUpdater.forceDevUpdateConfig = true;
  }

  setTimeout(() => {
    mainLog("Vérification des mises à jour...");
    autoUpdater.checkForUpdatesAndNotify();
  }, 3000);

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// --- ÉVÉNEMENTS UPDATER ---
autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: "Vérification des mises à jour...", type: "info" });
});

autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: "Gens Launcher est à jour !", type: "success" });
});

autoUpdater.on('update-available', (info) => {
    mainLog(`MAJ trouvée : ${info.version}`);
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: `Version ${info.version} trouvée ! Téléchargement...`, type: "info" });
});

autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-progress', Math.round(progress.percent));
});

autoUpdater.on('update-downloaded', () => {
    mainLog("MAJ téléchargée.");
    if (mainWindow) mainWindow.webContents.send('update-downloaded');
});

autoUpdater.on('error', (err) => {
    // On affiche l'erreur brute pour comprendre le code (404, 403, etc.)
    mainLog(`ERREUR DÉTAILLÉE : ${err.message}`);
    if (mainWindow) {
        mainWindow.webContents.send('update-msg', { 
            text: `Erreur : ${err.message.split('\n')[0]}`, 
            type: "error" 
        });
    }
});

ipcMain.on('restart_app', () => { autoUpdater.quitAndInstall(); });

// Login MS (inchangé)
ipcMain.handle("login-microsoft", async () => {
  try {
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("raw");
    const token = await xboxManager.getMinecraft();
    return { success: true, auth: token.mclc() };
  } catch (error) { return { success: false, error: error.message }; }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });