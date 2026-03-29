const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require("electron-updater");
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
  dialog.showMessageBox({
    type: 'info',
    title: 'Mise à jour disponible',
    message: 'Une nouvelle version a été trouvée. Téléchargement en cours en arrière-plan...',
    buttons: ['OK']
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'question',
    title: 'Mise à jour prête',
    message: 'Le téléchargement est terminé. Veux-tu redémarrer le launcher maintenant pour l\'installer ?',
    buttons: ['Redémarrer', 'Plus tard']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall(); 
    }
  });
});

autoUpdater.on('error', (err) => {
  dialog.showErrorBox('Erreur de Mise à jour', err == null ? "Erreur inconnue" : (err.stack || err).toString());
});