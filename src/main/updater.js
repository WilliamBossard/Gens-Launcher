module.exports = function (context) {
    const { app, ipcMain, shell, getMainWindow, mainLog, autoUpdater } = context;

    let userConfirmedUpdate = false;
    let isManualUpdateCheck = false;

    ipcMain.handle("do-deb-update", async () => {
        const isLinuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
        if (!isLinuxDeb) return { success: false, error: 'Not a .deb installation' };
        mainLog('[deb-update] Démarrage...');
        const keyPath = '/usr/share/keyrings/gens-launcher-keyring.gpg';
        const sourcesPath = '/etc/apt/sources.list.d/gens-launcher.list';
        const keyUrl = 'https://williambossard.github.io/Gens-Launcher/public.key';
        const repoLine = `deb [signed-by=${keyPath}] https://williambossard.github.io/Gens-Launcher ./`;
        
        const fs = require('fs');
        let hasKey = false, hasSources = false;
        try { await fs.promises.access(keyPath); hasKey = true; } catch (_) { if (_ && _.code !== 'ENOENT') console.error('[updater.js] Erreur silencieuse interceptée:', _.message || _); }
        try { await fs.promises.access(sourcesPath); hasSources = true; } catch (_) { if (_ && _.code !== 'ENOENT') console.error('[updater.js] Erreur silencieuse interceptée:', _.message || _); }
        mainLog(`[deb-update] hasKey=${hasKey}, hasSources=${hasSources}`);
        
        let shellCmd;
        if (!hasKey || !hasSources) {
            mainLog('[deb-update] Dépôt APT non configuré, ajout automatique...');
            getMainWindow()?.webContents.send('update-msg', { key: 'msg_apt_setup', text: 'Configuration du dépôt APT...', type: 'info' });
            const setupParts = [];
            if (!hasKey) setupParts.push(`curl -fsSL '${keyUrl}' | gpg --dearmor -o '${keyPath}'`);
            if (!hasSources) setupParts.push(`echo '${repoLine}' > '${sourcesPath}'`);
            setupParts.push('apt-get update -qq');
            setupParts.push('apt-get install -y gens-launcher');
            shellCmd = `pkexec sh -c "${setupParts.join(' && ').replace(/"/g, '\\"')}"`;
        } else {
            mainLog('[deb-update] Dépôt configuré, lancement apt-get install...');
            shellCmd = 'pkexec apt-get install -y gens-launcher';
        }
        mainLog('[deb-update] Commande : ' + shellCmd);
        getMainWindow()?.webContents.send('update-msg', { key: 'msg_apt_installing', text: 'Installation en cours (cela peut prendre quelques secondes)...', type: 'info' });
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(shellCmd, { timeout: 180000 }, (err, stdout, stderr) => {
                if (!err) {
                    mainLog('[deb-update] Succès.');
                    resolve({ success: true });
                } else {
                    mainLog('[deb-update] Erreur : ' + (stderr || err.message));
                    resolve({ success: false, error: (stderr || err.message).split('\n')[0] });
                }
            });
        });
    });

    ipcMain.on("confirm-update", () => { userConfirmedUpdate = true; });
    ipcMain.on("restart_app", async () => {
        if (process.platform === 'linux' && !process.env.APPIMAGE && !userConfirmedUpdate) {
            mainLog("[Sécurité] restart_app rejeté : l'utilisateur n'a pas confirmé la mise à jour.");
            return;
        }
        userConfirmedUpdate = false; 
        if (process.platform === 'linux') {
            if (process.env.APPIMAGE) {
                autoUpdater.quitAndInstall();
                return;
            }
            mainLog("MAJ Linux .deb : lancement via pkexec apt-get...");
            const { exec } = require('child_process');
            exec('pkexec apt-get install -y gens-launcher', (err, stdout, stderr) => {
                if (!err) {
                    mainLog("Mise à jour APT réussie. Relancement...");
                    app.relaunch();
                    app.exit(0);
                } else {
                    mainLog("Erreur MAJ APT : " + stderr);
                    exec(`x-terminal-emulator -e 'bash -c "sudo apt update && sudo apt install gens-launcher; read -p \\"Appuyez sur Entree pour fermer...\\" "'`, (err2) => {
                        if (err2) {
                            shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
                        }
                    });
                }
            });
        } else {
            autoUpdater.quitAndInstall();
        }
    });

    ipcMain.handle("check-for-updates", async () => {
        isManualUpdateCheck = true;
        const isLinuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
        if (isLinuxDeb) {
            try {
                const { net } = require('electron');
                return await new Promise((resolve) => {
                    const req = net.request({ url: 'https://api.github.com/repos/WilliamBossard/Gens-Launcher/releases/latest', headers: { 'User-Agent': 'Gens-Launcher-AutoUpdater' } });
                    req.on('response', (res) => {
                        let data = '';
                        res.on('data', (c) => { data += c; });
                        res.on('end', () => {
                            isManualUpdateCheck = false;
                            try {
                                const release = JSON.parse(data);
                                const latestVer = (release.tag_name || '').replace(/^v/, '');
                                const currentVer = app.getVersion();
                                if (latestVer && latestVer !== currentVer) {
                                    getMainWindow()?.webContents.send('update-available-prompt', { version: latestVer });
                                    resolve({ success: true, version: latestVer });
                                } else {
                                    getMainWindow()?.webContents.send('update-msg', { key: 'msg_up_to_date', text: 'Gens Launcher est à jour !', type: 'success' });
                                    resolve({ success: true, version: null });
                                }
                            } catch(e) { resolve({ success: false, error: e.message }); }
                        });
                    });
                    req.on('error', (e) => { isManualUpdateCheck = false; resolve({ success: false, error: e.message }); });
                    req.end();
                });
            } catch(e) { isManualUpdateCheck = false; return { success: false, error: e.message }; }
        }
        try { 
            const result = await autoUpdater.checkForUpdates(); 
            isManualUpdateCheck = false;
            return { success: true, version: result?.updateInfo?.version || null }; 
        } catch (e) { 
            isManualUpdateCheck = false;
            return { success: false, error: e.message }; 
        }
    });

    ipcMain.on("set-auto-download", (_, val) => { autoUpdater.autoDownload = val; });
    ipcMain.on("download-update", () => {
        const isLinuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
        if (isLinuxDeb) {
            mainLog("[deb] Téléchargement ignoré (géré par APT).");
            return;
        }
        autoUpdater.downloadUpdate();
    });

    autoUpdater.on("update-available", (info) => { getMainWindow()?.webContents.send("update-available-prompt", info); });
    autoUpdater.on("update-not-available", () => { 
        if (isManualUpdateCheck) {
            getMainWindow()?.webContents.send("update-msg", { key: "msg_up_to_date", text: "Gens Launcher est à jour !", type: "success" }); 
        }
    });
    autoUpdater.on("download-progress", (progress) => { getMainWindow()?.webContents.send("update-progress", Math.round(progress.percent)); });
    autoUpdater.on("error", (err) => {
        mainLog(`[AutoUpdater] Erreur : ${err.message}`);
        if (isManualUpdateCheck) {
            getMainWindow()?.webContents.send("update-msg", { key: "msg_update_error", text: "Erreur lors de la vérification des mises à jour.", type: "error" });
        }
    });
    autoUpdater.on("update-downloaded", (info) => {
        const isLinuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
        if (isLinuxDeb) {
            mainLog("[deb] update-downloaded ignoré.");
            return;
        }
        if (info?.downloadedFile) { mainLog("MAJ téléchargée : " + info.downloadedFile); }
        getMainWindow()?.webContents.send("update-downloaded");
    });

    return {
        getIsManualUpdateCheck: () => isManualUpdateCheck,
    };
};
