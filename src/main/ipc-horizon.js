module.exports = function setupHorizonHandlers(context) {
    const {
        ipcMain, safeDataDir, mainLog, path, fs, crypto, spawn, app,
        horizonBinDir, horizonExePath, horizonVersionPath, isWin, safeSend
    } = context;

    let _horizonQueue = Promise.resolve();

    let githubReleaseCache = null;
    let githubReleaseCacheTime = 0;
    let cachedExpectedHash = null;
    let cachedExpectedHashTime = 0; // timestamp du dernier fetch du hash
    const HASH_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures — aligné sur le cache GitHub
    const githubCacheFile = path.join(safeDataDir, 'github_release_cache.json');

    // Cache du hash local de Horizon.exe — invalidé si mtime ou size change
    let _localHashCache = null;
    let _localHashCacheMtime = 0;
    let _localHashCacheSize = 0;

    /**
     * Calcule le SHA-256 de l'exécutable Horizon via stream asynchrone.
     * Résultat mis en cache (invalidé si mtime ou taille changent).
     * Évite le readFileSync bloquant sur un binaire de ~50 Mo.
     */
    async function getLocalHorizonHash(exePath) {
        const stat = await fs.promises.stat(exePath);
        if (_localHashCache &&
            stat.mtimeMs === _localHashCacheMtime &&
            stat.size === _localHashCacheSize) {
            return _localHashCache;
        }
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(exePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        _localHashCache = hash.digest('hex');
        _localHashCacheMtime = stat.mtimeMs;
        _localHashCacheSize = stat.size;
        return _localHashCache;
    }

    /**
     * Fetch avec timeout via AbortController.
     */
    async function fetchWithTimeout(url, timeoutMs = 5000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(id);
        }
    }

    (async () => {
        try {
            if (await fs.promises.access(githubCacheFile).then(()=>true).catch(()=>false)) {
                const parsed = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8'));
                if (parsed && parsed.time && parsed.data) {
                    githubReleaseCacheTime = parsed.time;
                    githubReleaseCache = parsed.data;
                }
                // AUDIT-12 : validation du format sha256 avant utilisation du hash en cache
                if (parsed && parsed.hash && isValidSha256(parsed.hash)) {
                    cachedExpectedHash = parsed.hash.toLowerCase();
                }
            }
        } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
    })();

    // AUDIT-12 : validation du hash avant utilisation pour éviter l'injection d'un hash malformé depuis le cache local
    function isValidSha256(h) { return typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h); }

    async function fetchLatestHorizonRelease(forceBypassCache = false) {
        if (!forceBypassCache && githubReleaseCache && Date.now() - githubReleaseCacheTime < 2 * 60 * 60 * 1000) {
            return githubReleaseCache;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        // AUDIT-20 : version dynamique via app.getVersion() au lieu de la valeur hardcodée
        const launcherVersion = (typeof app !== 'undefined' && app.getVersion) ? app.getVersion() : '1.8.4';
        const res = await fetch('https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest', { 
            headers: { "User-Agent": `Gens-Launcher/${launcherVersion}` },
            signal: controller.signal 
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("Erreur fetch Github");
        const data = await res.json();
        githubReleaseCache = data;
        githubReleaseCacheTime = Date.now();
        try { await fs.promises.writeFile(githubCacheFile, JSON.stringify({ time: githubReleaseCacheTime, data })); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
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
        const ALLOWED_COMMANDS = ['--check', '--sync', '--upload', '--login', '--quota', '--rollback', '--status', '--clean', '--help', '--version'];
        
        const isSafeCommand = _lockArgs.length > 0 && ALLOWED_COMMANDS.includes(_lockArgs[0]);
        // AUDIT-11 : validation durcie des arguments — les arguments positionnels (noms d'instance) n'acceptent plus '/' ni '.'
        const isSafeChars = _lockArgs.every((arg, i) => {
            if (i === 0) return ALLOWED_COMMANDS.includes(arg); // commande principale déjà validée ci-dessus
            if (arg.startsWith('--')) return /^--[a-zA-Z\-]+(=[a-zA-Z0-9]+)?$/.test(arg); // flags booléens ou simples
            // Argument positionnel (nom d'instance) : pas de slash, pas de point, pas de séquence ..
            return /^[a-zA-Z0-9_\-\u00C0-\u017F ]+$/.test(arg) && !arg.includes('..');
        });
        
        if (!isSafeCommand || !isSafeChars) {
            mainLog(`SÉCURITÉ : Arguments Horizon rejetés : ${_lockArgs.join(' ')}`);
            return Promise.resolve({ exitCode: -1, lastJson: null });
        }

        const isWriteOp = isHorizonWriteOp(_lockArgs);

        if (await fs.promises.access(horizonExePath).then(()=>true).catch(()=>false)) {
            let expectedHash = null;
            const hashIsStale = !cachedExpectedHash || (Date.now() - cachedExpectedHashTime > HASH_CACHE_TTL_MS);
            if (!hashIsStale) {
                expectedHash = cachedExpectedHash;
            } else {
                try {
                    const data = await fetchLatestHorizonRelease();
                    const asset = data.assets.find(a => isWin ? a.name.endsWith('.exe') : a.name.toLowerCase().includes('linux')) || data.assets.find(a => !path.extname(a.name));
                    if (asset) {
                        const shaAsset = data.assets.find(a => a.name === asset.name + ".sha256");
                        if (shaAsset) {
                            const hashRes = await fetchWithTimeout(shaAsset.browser_download_url, 5000);
                            if (hashRes.ok) {
                                expectedHash = (await hashRes.text()).trim().split(/\s/)[0].toLowerCase();
                                cachedExpectedHash = expectedHash;
                                cachedExpectedHashTime = Date.now(); // TTL: re-fetch après 2h
                                try {
                                    let c = {};
                                    try { c = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8')); } catch (_) { }
                                    c.hash = expectedHash;
                                    await fs.promises.writeFile(githubCacheFile, JSON.stringify(c));
                                } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                            }
                        }
                    }
                } catch(e) {
                    mainLog("Erreur vérification SHA256 (réseau): " + e.message);
                    if (cachedExpectedHash) {
                        mainLog("Utilisation du hash en cache (obsolète) suite à l'erreur réseau.");
                        expectedHash = cachedExpectedHash;
                    } else {
                        mainLog("SÉCURITÉ : Exécution de Horizon sans vérification de hash (Mode Hors Ligne complet).");
                    }
                }
            }

            if (expectedHash) {
                try {
                    // Stream async — ne bloque pas le Main Process (remplace readFileSync sur ~50 Mo)
                    const actualHash = await getLocalHorizonHash(horizonExePath);
                    if (actualHash !== expectedHash) {
                        if (!app.isPackaged) {
                            mainLog(`SÉCURITÉ IGNORÉE (DEV) : Le hash de Horizon.exe ne correspond pas.`);
                        } else {
                            mainLog(`SÉCURITÉ CRITIQUE : Le hash de Horizon.exe ne correspond pas à la version officielle !`);
                            if (event) safeSend(event, 'horizon-status', { type: 'ERROR', message: "SÉCURITÉ CRITIQUE : Exécutable Horizon corrompu ou falsifié. Veuillez réinstaller le module Cloud." });
                            return Promise.resolve({ exitCode: -1, lastJson: null });
                        }
                    }
                } catch (hashReadErr) {
                    mainLog(`Erreur lecture Horizon.exe pour hash : ${hashReadErr.message}`);
                }
            }
        }

        if (isWriteOp) {
            const lockFile = path.join(horizonBinDir, 'horizon.lock');
            // AUDIT-18 : polling simplifié — une seule tentative suffit car ENOENT signifie pas de lock actif
            let rawPid = NaN;
            try {
                const content = (await fs.promises.readFile(lockFile, 'utf8')).trim();
                if (content) rawPid = parseInt(content, 10);
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", e); }
            if (!isNaN(rawPid)) {
                let alive = false;
                try { process.kill(rawPid, 0); alive = true; } catch (killErr) {
                    if (killErr.code === 'EPERM') {
                        try {
                            const age = Date.now() - (await fs.promises.stat(lockFile)).mtimeMs;
                            if (age > 2 * 60 * 60 * 1000) {
                                await fs.promises.unlink(lockFile);
                            } else {
                                alive = true;
                            }
                        } catch (_) {
                            try { await fs.promises.unlink(lockFile); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                        }
                    }
                }
                if (alive) {
                    const msg = { type: 'ERROR', errorCode: 'ERR_ALREADY_RUNNING', message: 'ERR_ALREADY_RUNNING' };
                    safeSend(event, 'horizon-status', msg);
                    return Promise.resolve({ exitCode: -1, lastJson: msg });
                } else {
                    try { 
                        await fs.promises.unlink(lockFile); 
                        mainLog("[Horizon] Verrou obsolète nettoyé avec succès.");
                    } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                }
            }
        }

        const timeoutMs = isWriteOp ? 60 * 60 * 1000 : 10 * 60 * 1000;
        return new Promise((resolve) => {
            const args = Array.isArray(action) ? action : [action];
            mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

            const horizon = spawn(horizonExePath, args, { cwd: horizonBinDir, env: { ...process.env, HORIZON_DATA_DIR: horizonBinDir } });
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
                        } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
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
                                    try { horizon.kill("SIGKILL"); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                                }
                            }, 2000);
                        } catch (_) {
                            try { horizon.kill("SIGKILL"); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
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
        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", e); }

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
            } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }

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
        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", e); }

        const specificTokenPath = path.join(horizonBinDir, `token_${currentProvider}.json`);
        const legacyTokenPath = path.join(horizonBinDir, "token.json");

        let isInstalled = false;
        let isLinked = false;
        try { await fs.promises.access(horizonExePath); isInstalled = true; } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
        try {
            await fs.promises.access(specificTokenPath); isLinked = true;
        } catch (_) {
            if (currentProvider === "google") {
                try { await fs.promises.access(legacyTokenPath); isLinked = true; } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
            }
        }

        let localVersion = "v0.0.0";
        try {
            await fs.promises.access(horizonVersionPath);
            localVersion = JSON.parse(await fs.promises.readFile(horizonVersionPath, "utf8")).version;
        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", e); }

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
            const data = await fetchLatestHorizonRelease(true);
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

            try {
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
                await new Promise((resolve, reject) => {
                    fileStream.on('finish', resolve);
                    fileStream.on('error', reject);
                });
            } catch (err) {
                fileStream.destroy();
                try { await fs.promises.unlink(tmpPath); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                throw err;
            }

            const sha256Asset = data.assets.find(a => a.name === asset.name + ".sha256");
            if (!sha256Asset) {
                try { await fs.promises.unlink(tmpPath); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
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
                cachedExpectedHash = expected;
                try {
                    let c = {};
                    try { c = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8')); } catch (_) { }
                    c.hash = expected;
                    await fs.promises.writeFile(githubCacheFile, JSON.stringify(c));
                } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                mainLog(`[Horizon] Intégrité SHA256 vérifiée pour la version ${data.tag_name}.`);
            } catch (hashErr) {
                try { await fs.promises.unlink(tmpPath); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-horizon.js:", _); }
                throw new Error(`SÉCURITÉ CRITIQUE : Impossible de vérifier le hash .sha256 — ${hashErr.message}`);
            }

            await fs.promises.rename(tmpPath, horizonExePath);
            if (!isWin) await fs.promises.chmod(horizonExePath, 0o755);
            await fs.promises.writeFile(horizonVersionPath, JSON.stringify({ version: data.tag_name }));
            return { success: true, version: data.tag_name };
        } catch (e) { return { success: false, error: e.message }; }
    });
};
