const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require("electron-updater");
const msmc = require('msmc');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdates();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

autoUpdater.on('update-available', () => {
  dialog.showMessageBox({ type: 'info', title: 'Mise à jour', message: 'Téléchargement en cours...', buttons: ['OK'] });
});
autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({ type: 'question', title: 'Mise à jour prête', message: 'Redémarrer pour installer ?', buttons: ['Redémarrer', 'Plus tard'] })
  .then((result) => { if (result.response === 0) autoUpdater.quitAndInstall(); });
});

ipcMain.handle('login-microsoft', async () => {
    try {
        const authManager = new msmc.Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        const token = await xboxManager.getMinecraft();
        return { success: true, auth: token.mclc() };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
});