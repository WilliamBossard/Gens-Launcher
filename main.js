const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const SPOOF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app.userAgentFallback = SPOOF_UA;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function applySpoofing(sess) {
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = SPOOF_UA;
        
        delete details.requestHeaders['sec-ch-ua'];
        delete details.requestHeaders['sec-ch-ua-mobile'];
        delete details.requestHeaders['sec-ch-ua-platform'];
        
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
}

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
  applySpoofing(session.defaultSession);
  
  app.on('session-created', applySpoofing);

  createWindow();

  autoUpdater.logger = { info: (m) => mainLog(m), warn: (m) => mainLog("WARN: "+m), error: (m) => mainLog("ERR: "+m) };
  autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
  autoUpdater.autoDownload = true;
  
  setTimeout(() => {
      mainLog("Vérification des mises à jour...");
      autoUpdater.checkForUpdatesAndNotify();
  }, 3000);
});

autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: "Gens Launcher est à jour !", type: "success" });
});

autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: `Version ${info.version} trouvée ! Téléchargement...`, type: "info" });
});

autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-progress', Math.round(progress.percent));
});

autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update-downloaded');
});

ipcMain.on('restart_app', () => { autoUpdater.quitAndInstall(); });

ipcMain.on('hide-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('show-window', () => { if (mainWindow) mainWindow.show(); });

ipcMain.handle("login-microsoft", async () => {
  try {
    const { Auth } = require("msmc");
    mainLog("Lancement de l'authentification MSMC v4...");

    await session.defaultSession.clearStorageData();

    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("electron");
    const token = await xboxManager.getMinecraft();
    
    mainLog("Authentification réussie !");
    return { success: true, auth: token.mclc() };
  } catch (err) {
    mainLog("Erreur MSMC : " + err.message);
    return { success: false, error: err.message };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});