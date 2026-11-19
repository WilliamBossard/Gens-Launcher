// @ts-check

const APT_KEY_SHA256 = '9d9f654a0455664fdd3ce1b4fcdccf424fe3bd17614cc9c5ba5133710a7d8cd0';

/**
 * @param {import('../types/main').MainContext} context
 */
function setupUpdater(context) {
    const { app, ipcMain, shell, getMainWindow, mainLog, autoUpdater } = context;

    let userConfirmedUpdate = false;
    let isManualUpdateCheck = false;
    let debAlreadyInstalled = false;

    const fs = require('fs');

    function isDebPackageInstallation() {
        if (process.platform !== 'linux' || process.env.APPIMAGE || process.env.FLATPAK_ID || process.env.SNAP) {
            return false;
        }
        if (!app.isPackaged) return false;
        const debMarkers = [
            '/var/lib/dpkg/info/gens-launcher.list',
            '/var/lib/dpkg/info/gens-launcher:amd64.list',
            '/var/lib/dpkg/info/gens-launcher:arm64.list',
            '/usr/share/doc/gens-launcher',
            '/etc/apt/sources.list.d/gens-launcher.list'
        ];
        for (const marker of debMarkers) {
            try {
                if (fs.existsSync(marker)) return true;
            } catch (_) {}
        }
        return false;
    }

    ipcMain.handle("do-deb-update", async () => {
        if (!isDebPackageInstallation()) {
            return { success: false, errorCode: 'NOT_DEB', error: 'Not a .deb installation' };
        }
        mainLog('[deb-update] Démarrage...');
        const keyPath = '/usr/share/keyrings/gens-launcher-keyring.gpg';
        const sourcesPath = '/etc/apt/sources.list.d/gens-launcher.list';
        const keyUrl = 'https://williambossard.github.io/Gens-Launcher/public.key';
        const repoLine = `deb [signed-by=${keyPath}] https://williambossard.github.io/Gens-Launcher ./`;

        const os = require('os');
        const path = require('path');
        const crypto = require('crypto');
        const { execFile } = require('child_process');

        let hasKey = false, hasSources = false;
        try { await fs.promises.access(keyPath); hasKey = true; } catch (_) { if (_ && typeof _ === 'object' && 'code' in _ && _.code !== 'ENOENT') console.error('[updater.js] Erreur silencieuse interceptée:', _); }
        try { await fs.promises.access(sourcesPath); hasSources = true; } catch (_) { if (_ && typeof _ === 'object' && 'code' in _ && _.code !== 'ENOENT') console.error('[updater.js] Erreur silencieuse interceptée:', _); }
        mainLog(`[deb-update] hasKey=${hasKey}, hasSources=${hasSources}`);

        /** @type {string | null} */
        let tmpKeyDir = null;
        /** @type {string | null} */
        let tmpKeyFile = null;
        try {
            /** @type {string[]} */
            let pkexecArgs;
            if (!hasKey || !hasSources) {
                mainLog('[deb-update] Dépôt APT non configuré, ajout automatique...');
                getMainWindow()?.webContents.send('update-msg', { key: 'msg_apt_setup', text: 'Configuration du dépôt APT...', type: 'info' });
                const setupParts = [];
                if (!hasKey) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 15000);
                    /** @type {Buffer} */
                    let keyBuf;
                    try {
                        const res = await fetch(keyUrl, { signal: controller.signal });
                        if (!res.ok) throw new Error(`Téléchargement clé GPG HTTP ${res.status}`);
                        keyBuf = Buffer.from(await res.arrayBuffer());
                    } finally {
                        clearTimeout(timer);
                    }
                    const actualSha = crypto.createHash('sha256').update(keyBuf).digest('hex').toLowerCase();
                    if (actualSha !== APT_KEY_SHA256) {
                        throw new Error(`Empreinte SHA-256 invalide pour public.key (${actualSha})`);
                    }
                    tmpKeyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-apt-'));
                    tmpKeyFile = path.join(tmpKeyDir, 'public.key');
                    await fs.promises.writeFile(tmpKeyFile, keyBuf, { mode: 0o600 });
                    setupParts.push('gpg --batch --yes --dearmor -o "$1" "$2"');
                }
                if (!hasSources) setupParts.push('printf "%s\\n" "$3" > "$4"');
                setupParts.push('apt-get update -qq');
                setupParts.push('apt-get install -y gens-launcher');
                pkexecArgs = ['sh', '-c', setupParts.join(' && '), '_', keyPath, tmpKeyFile || '', repoLine, sourcesPath];
            } else {
                mainLog('[deb-update] Dépôt configuré, lancement apt-get update && apt-get install...');
                pkexecArgs = ['sh', '-c', 'apt-get update -qq && apt-get install -y gens-launcher'];
            }
            mainLog('[deb-update] Commande : pkexec ' + pkexecArgs.join(' '));
            getMainWindow()?.webContents.send('update-msg', { key: 'msg_apt_installing', text: 'Installation en cours (cela peut prendre quelques secondes)...', type: 'info' });
            return await new Promise((resolve) => {
                execFile('pkexec', pkexecArgs, { timeout: 180000 }, (err, stdout, stderr) => {
                    if (!err) {
                        mainLog('[deb-update] Succès.');
                        debAlreadyInstalled = true;
                        resolve({ success: true });
                    } else {
                        mainLog('[deb-update] Erreur : ' + (stderr || err.message));
                        resolve({ success: false, error: (stderr || err.message).split('\n')[0] });
                    }
                });
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            mainLog('[deb-update] Erreur préparation clé/dépôt : ' + msg);
            return { success: false, error: msg };
        } finally {
            if (tmpKeyDir) {
                try { await fs.promises.rm(tmpKeyDir, { recursive: true, force: true }); } catch (_) {}
            } else if (tmpKeyFile) {
                try { await fs.promises.unlink(tmpKeyFile); } catch (_) {}
            }
        }
    });

    ipcMain.on("confirm-update", () => { userConfirmedUpdate = true; });
    ipcMain.on("restart_app", async () => {
        if (!userConfirmedUpdate) {
            mainLog("[Sécurité] restart_app rejeté : l'utilisateur n'a pas confirmé la mise à jour.");
            return;
        }
        userConfirmedUpdate = false;
        if (process.platform === 'linux') {
            if (process.env.APPIMAGE) {
                autoUpdater.quitAndInstall();
                return;
            }
            if (debAlreadyInstalled || !isDebPackageInstallation()) {
                debAlreadyInstalled = false;
                mainLog("Relancement Linux post-mise à jour...");
                app.relaunch();
                app.exit(0);
                return;
            }
            mainLog("MAJ Linux .deb : lancement via pkexec apt-get update && install...");
            const { execFile } = require('child_process');
            execFile('pkexec', ['sh', '-c', 'apt-get update -qq && apt-get install -y gens-launcher'], (err, stdout, stderr) => {
                if (!err) {
                    mainLog("Mise à jour APT réussie. Relancement...");
                    app.relaunch();
                    app.exit(0);
                } else {
                    mainLog("Erreur MAJ APT : " + stderr);
                    execFile(
                        'x-terminal-emulator',
                        ['-e', 'bash', '-c', 'sudo apt update && sudo apt install gens-launcher; read -p "Appuyez sur Entree pour fermer..."'],
                        (err2) => {
                            if (err2) {
                                shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
                            }
                        }
                    );
                }
            });
        } else {
            autoUpdater.quitAndInstall();
        }
    });

    /**
     * @param {string} a
     * @param {string} b
     */
    const compareSemver = (a, b) => {
        const pa = String(a).split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
        const pb = String(b).split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        }
        return 0;
    };

    ipcMain.handle("check-for-updates", async () => {
        isManualUpdateCheck = true;
        if (isDebPackageInstallation()) {
            try {
                const { net } = require('electron');
                return await new Promise((resolve) => {
                    let settled = false;
                    /** @type {NodeJS.Timeout | null} */
                    let reqTimeout = null;
                    const req = net.request({ url: 'https://api.github.com/repos/WilliamBossard/Gens-Launcher/releases/latest', headers: { 'User-Agent': 'Gens-Launcher-AutoUpdater' } });
                    /** @param {any} result */
                    const finish = (result) => {
                        if (settled) return;
                        settled = true;
                        if (reqTimeout) clearTimeout(reqTimeout);
                        isManualUpdateCheck = false;
                        resolve(result);
                    };
                    reqTimeout = setTimeout(() => {
                        try { req.abort(); } catch (_) {}
                        finish({ success: false, error: 'Délai dépassé lors de la vérification des mises à jour.' });
                    }, 10000);
                    req.on('response', (res) => {
                        let data = '';
                        res.on('data', (c) => {
                            if (data.length < 512 * 1024) data += c;
                        });
                        res.on('end', () => {
                            if (res.statusCode !== 200) {
                                return finish({ success: false, error: `GitHub API HTTP ${res.statusCode}` });
                            }
                            try {
                                const release = JSON.parse(data);
                                const latestVer = (release.tag_name || '').replace(/^v/, '');
                                const currentVer = app.getVersion();
                                if (latestVer && compareSemver(latestVer, currentVer) > 0) {
                                    getMainWindow()?.webContents.send('update-available-prompt', { version: latestVer });
                                    finish({ success: true, version: latestVer });
                                } else {
                                    getMainWindow()?.webContents.send('update-msg', { key: 'msg_up_to_date', text: 'Gens Launcher est à jour !', type: 'success' });
                                    finish({ success: true, version: null });
                                }
                            } catch(e) {
                                const error = e instanceof Error ? e.message : String(e);
                                finish({ success: false, error });
                            }
                        });
                    });
                    req.on('error', (e) => {
                        const error = e instanceof Error ? e.message : String(e);
                        finish({ success: false, error });
                    });
                    req.end();
                });
            } catch(e) {
                isManualUpdateCheck = false;
                const error = e instanceof Error ? e.message : String(e);
                return { success: false, error };
            }
        }
        try { 
            const result = await autoUpdater.checkForUpdates(); 
            isManualUpdateCheck = false;
            return { success: true, version: result?.updateInfo?.version || null }; 
        } catch (e) { 
            isManualUpdateCheck = false;
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error }; 
        }
    });

    ipcMain.on("set-auto-download", (_, val) => { autoUpdater.autoDownload = val; });
    ipcMain.on("download-update", () => {
        if (isDebPackageInstallation()) {
            mainLog("[deb] Téléchargement ignoré (géré par APT).");
            return;
        }
        autoUpdater.downloadUpdate().catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            mainLog(`[AutoUpdater] Échec downloadUpdate : ${msg}`);
            getMainWindow()?.webContents.send("update-msg", { key: "msg_update_dl_error", text: `Erreur téléchargement mise à jour : ${msg}`, type: "error" });
        });
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
        if (isDebPackageInstallation()) {
            mainLog("[deb] update-downloaded ignoré.");
            return;
        }
        if (info?.downloadedFile) { mainLog("MAJ téléchargée : " + info.downloadedFile); }
        getMainWindow()?.webContents.send("update-downloaded");
    });

    return {
        getIsManualUpdateCheck: () => isManualUpdateCheck,
    };
}

setupUpdater.APT_KEY_SHA256 = APT_KEY_SHA256;
module.exports = setupUpdater;
