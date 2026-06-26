module.exports = function setupHorizonHandlers(context) {
    const {
        ipcMain, safeDataDir, mainLog, path, fs, crypto, spawn,
        horizonBinDir, horizonExePath, horizonVersionPath, isWin, safeSend
    } = context;

    let _horizonQueue = Promise.resolve();

    let githubReleaseCache = null;
    let githubReleaseCacheTime = 0;

    async function fetchLatestHorizonRelease() {
        if (githubReleaseCache && Date.now() - githubReleaseCacheTime < 30 * 60 * 1000) {
            return githubReleaseCache;
        }
        const res = await fetch('https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest');
        if (!res.ok) throw new Error("Erreur fetch Github");
        const data = await res.json();
        githubReleaseCache = data;
        githubReleaseCacheTime = Date.now();
        return data;
    }

    function isHorizonWriteOp(args) {
        if (args.includes('--upload') || args.includes('--rollback')) return true;
        if (args.includes('--sync') && args.includes('--delete')) return true;
        if (args.includes('--sync') && !args.includes('--list')) return true;
        return false;
    }

    async function _runHorizonActionImpl(action, event = null) {
        const _lockArgs = Array.isArray(action) ? action : [action];
        const isSafe = _lockArgs.every(arg =>
            /^[a-zA-Z0-9_\-\.\=\/ \(\)\[\]]+$/.test(arg) &&
            !arg.includes('..')
        );
        if (!isSafe) {
            mainLog(`SÉCURITÉ : Arguments Horizon rejetés : ${_lockArgs.join(' ')}`);
            return Promise.resolve({ exitCode: -1, lastJson: null });
        }

        const isWriteOp = isHorizonWriteOp(_lockArgs);
        if (isWriteOp) {
            const lockFile = path.join(horizonBinDir, 'horizon.lock');
            let rawPid = NaN;
            for (let i = 0; i < 5; i++) {
                try {
                    const content = fs.readFileSync(lockFile, 'utf8').trim();
                    if (content) {
                        rawPid = parseInt(content, 10);
                        break;
                    }
                } catch (_) { }
                if (isNaN(rawPid)) await new Promise(r => setTimeout(r, 100));
            }
            if (!isNaN(rawPid)) {
                let alive = false;
                try { process.kill(rawPid, 0); alive = true; } catch (killErr) {
                    if (killErr.code === 'EPERM') {
                        try {
                            const age = Date.now() - fs.statSync(lockFile).mtimeMs;
                            if (age > 30 * 60 * 1000) {
                                fs.unlinkSync(lockFile);
                            } else {
                                alive = true;
                            }
                        } catch (_) {
                            try { fs.unlinkSync(lockFile); } catch (_) { }
                        }
                    }
                }
                if (alive) {
                    const msg = { type: 'ERROR', errorCode: 'ERR_ALREADY_RUNNING', message: 'ERR_ALREADY_RUNNING' };
                    safeSend(event, 'horizon-status', msg);
                    return Promise.resolve({ exitCode: -1, lastJson: msg });
                } else {
                    try { fs.unlinkSync(lockFile); } catch (_) { }
                }
            }
        }

        const timeoutMs = isWriteOp ? 60 * 60 * 1000 : 10 * 60 * 1000;
        return new Promise((resolve) => {
            const args = Array.isArray(action) ? action : [action];
            mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

            const horizon = spawn(horizonExePath, args, { cwd: horizonBinDir });
            let settled = false;
            let killTimer;
            let shutdownTimer;
            let stdoutBuf = '';
            let lastJson = null;

            const finish = (exitCode) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (shutdownTimer) clearTimeout(shutdownTimer);
                if (stdoutBuf.trim()) {
                    for (const line of stdoutBuf.split('\n')) {
                        if (!line.trim()) continue;
                        try {
                            const json = JSON.parse(line);
                            lastJson = json;
                            safeSend(event, 'horizon-status', json);
                        } catch (_) { }
                    }
                    stdoutBuf = '';
                }
                resolve({ exitCode, lastJson });
            };

            const resetTimeout = () => {
                if (killTimer) clearTimeout(killTimer);
                killTimer = setTimeout(() => {
                    if (!settled) {
                        mainLog(`[Horizon] TIMEOUT d'inactivité — demande d'arrêt (SHUTDOWN).`);
                        try {
                            if (horizon.stdin) horizon.stdin.write("SHUTDOWN\n");
                            shutdownTimer = setTimeout(() => {
                                if (!settled) {
                                    mainLog(`[Horizon] Arrêt forcé (SIGKILL) après inactivité.`);
                                    try { horizon.kill("SIGKILL"); } catch (_) { }
                                }
                            }, 2000);
                        } catch (_) {
                            try { horizon.kill("SIGKILL"); } catch (_) { }
                        }
                        finish(-1);
                    }
                }, timeoutMs);
            };

            resetTimeout();

            horizon.stdout.on('data', (data) => {
                resetTimeout();
                stdoutBuf += data.toString();
                const lines = stdoutBuf.split('\n');
                stdoutBuf = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        lastJson = json;
                        safeSend(event, 'horizon-status', json);
                        mainLog(`[Horizon Output] ${line}`);
                    } catch (e) {
                        mainLog(`[Horizon Raw] ${line}`);
                    }
                }
            });
            horizon.stderr.on('data', (data) => { mainLog(`[Horizon Error] ${data.toString().trim()}`); });
            horizon.on('close', (code) => {
                if (!settled) { clearTimeout(killTimer); mainLog(`[Horizon] Terminé (code ${code})`); finish(code ?? -1); }
            });
            horizon.on('error', (err) => {
                if (!settled) { clearTimeout(killTimer); mainLog(`[Horizon] Erreur spawn : ${err.message}`); finish(-1); }
            });
        });
    }

    function runHorizonAction(action, event = null) {
        const job = _horizonQueue.then(() => _runHorizonActionImpl(action, event));
        _horizonQueue = job.catch(() => { });
        return job;
    }

    ipcMain.handle("get-horizon-settings", async () => {
        const settingsPath = path.join(horizonBinDir, "horizon_settings.json");
        const defaults = { systemEnabled: true, syncMode: "SMART", autoSync: true, autoUpload: true, maxRetries: 3, retryBaseDelay: 1500, deltaCleanupThreshold: 10 };
        let fileContent = {};

        try {
            await fs.promises.access(settingsPath);
            fileContent = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
        } catch (e) { }

        const merged = { ...defaults, ...fileContent };
        const hasMissingKey = Object.keys(defaults).some(k => !(k in fileContent));

        if (hasMissingKey) {
            const tmpPath = settingsPath + ".tmp";
            await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2));
            await fs.promises.rename(tmpPath, settingsPath);
        }
        return merged;
    });

    ipcMain.handle("save-horizon-settings", async (event, settings) => {
        try {
            const ALLOWED_KEYS = ["systemEnabled", "syncMode", "autoSync", "autoUpload", "provider", "deltaCleanupThreshold", "maxRetries", "retryBaseDelay"];
            const safe = Object.fromEntries(Object.entries(settings).filter(([k]) => ALLOWED_KEYS.includes(k)));
            const settingsPath = path.join(horizonBinDir, "horizon_settings.json");

            let existing = {};
            try {
                await fs.promises.access(settingsPath);
                existing = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
            } catch (_) { }

            const merged = { ...existing, ...safe };
            const tmp = settingsPath + ".tmp";
            await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2));
            await fs.promises.rename(tmp, settingsPath);
            return { success: true };
        }
        catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle("check-horizon-status", async () => {
        let currentProvider = "google";
        const hSettingsPath = path.join(horizonBinDir, "horizon_settings.json");

        try {
            await fs.promises.access(hSettingsPath);
            const p = JSON.parse(await fs.promises.readFile(hSettingsPath, "utf8"));
            if (p.provider) currentProvider = p.provider;
        } catch (e) { }

        const specificTokenPath = path.join(horizonBinDir, `token_${currentProvider}.json`);
        const legacyTokenPath = path.join(horizonBinDir, "token.json");

        let isInstalled = false;
        let isLinked = false;
        try { await fs.promises.access(horizonExePath); isInstalled = true; } catch (_) { }
        try {
            await fs.promises.access(specificTokenPath); isLinked = true;
        } catch (_) {
            if (currentProvider === "google") {
                try { await fs.promises.access(legacyTokenPath); isLinked = true; } catch (_) { }
            }
        }

        let localVersion = "v0.0.0";
        try {
            await fs.promises.access(horizonVersionPath);
            localVersion = JSON.parse(await fs.promises.readFile(horizonVersionPath, "utf8")).version;
        } catch (e) { }

        try {
            const data = await fetchLatestHorizonRelease();
            return { installed: isInstalled, localVersion, latestVersion: data.tag_name, needsUpdate: data.tag_name !== localVersion, linked: isLinked, provider: currentProvider };
        } catch (e) {
            return { installed: isInstalled, localVersion, latestVersion: null, needsUpdate: false, offline: true, linked: isLinked, provider: currentProvider };
        }
    });

    ipcMain.handle('call-horizon', async (event, action) => runHorizonAction(action, event));

    ipcMain.handle('install-horizon', async (event) => {
        try {
            const data = await fetchLatestHorizonRelease();
            const asset = data.assets.find(a => isWin ? a.name.endsWith('.exe') : a.name.toLowerCase().includes('linux')) || data.assets.find(a => !path.extname(a.name));
            if (!asset) throw new Error("Aucun binaire compatible trouvé sur la release GitHub");

            const response = await fetch(asset.browser_download_url);
            if (!response.ok) throw new Error("Erreur de téléchargement du binaire");

            const contentLength = parseInt(response.headers.get('content-length'), 10);
            let loaded = 0;
            let lastPct = -1;

            const hash = crypto.createHash('sha256');
            const tmpPath = horizonExePath + '.tmp';
            const fileStream = fs.createWriteStream(tmpPath);

            for await (const chunk of response.body) {
                fileStream.write(chunk);
                hash.update(chunk);
                loaded += chunk.length;
                if (contentLength && event) {
                    const pct = Math.round((loaded / contentLength) * 100);
                    if (pct !== lastPct) {
                        safeSend(event, 'horizon-install-progress', pct);
                        lastPct = pct;
                    }
                }
            }
            fileStream.end();
            await new Promise(r => fileStream.on('finish', r));

            const sha256Asset = data.assets.find(a => a.name === asset.name + ".sha256");
            if (!sha256Asset) {
                try { fs.unlinkSync(tmpPath); } catch (_) { }
                throw new Error("SÉCURITÉ CRITIQUE : Fichier .sha256 introuvable sur la release GitHub. L'intégrité de l'exécutable ne peut être garantie.");
            }
            try {
                const hashRes = await fetch(sha256Asset.browser_download_url);
                if (!hashRes.ok) throw new Error("Erreur fetch hash HTTP " + hashRes.status);
                const hashText = await hashRes.text();
                const expected = hashText.trim().split(/\s/)[0].toLowerCase();
                const actual = hash.digest('hex');
                if (actual !== expected) {
                    throw new Error(`Vérification SHA256 du binaire Horizon échouée.\nAttendu : ${expected}\nObtenu  : ${actual}`);
                }
                mainLog(`[Horizon] Intégrité SHA256 vérifiée pour la version ${data.tag_name}.`);
            } catch (hashErr) {
                try { fs.unlinkSync(tmpPath); } catch (_) { }
                throw new Error(`SÉCURITÉ CRITIQUE : Impossible de vérifier le hash .sha256 — ${hashErr.message}`);
            }

            await fs.promises.rename(tmpPath, horizonExePath);
            if (!isWin) await fs.promises.chmod(horizonExePath, 0o755);
            await fs.promises.writeFile(horizonVersionPath, JSON.stringify({ version: data.tag_name }));
            return { success: true, version: data.tag_name };
        } catch (e) { return { success: false, error: e.message }; }
    });
};
