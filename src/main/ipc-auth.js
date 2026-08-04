

module.exports = function setupAuthHandlers(context) {
    const { ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, crypto, assertPathUnderSandbox } = context;
    const { encryptText, decryptText } = require("./crypto-utils");

    let isAuthRunning = false;
    let activeMicrosoftAuthFlow = null;
    let loginMicrosoftUserCancelled = false;

    ipcMain.on("cancel-login-microsoft", () => {
        loginMicrosoftUserCancelled = true;
        if (activeMicrosoftAuthFlow) activeMicrosoftAuthFlow.cancel();
        mainLog("Annulation demandée (connexion Microsoft).");
    });

    ipcMain.handle("login-microsoft", async () => {
        if (isAuthRunning) return { success: false, errorCode: "ERR_AUTH_RUNNING", error: "Une connexion est déjà en cours." };
        isAuthRunning = true;
        loginMicrosoftUserCancelled = false;

        const MicrosoftAuth = require("../gens-core/components/auth.js");

        const sessionLabel = `gens-${crypto.randomUUID()}`;
        const cacheDir = path.join(safeDataDir, "msa-cache");
        if (!(await fs.promises.access(cacheDir).then(()=>true).catch(()=>false))) await fs.promises.mkdir(cacheDir, { recursive: true });

        try {
            const auth = new MicrosoftAuth();
            activeMicrosoftAuthFlow = auth;

            const response = await auth.flowDeviceCode((deviceInfo) => {
                const payload = { message: deviceInfo.message, user_code: deviceInfo.user_code, verification_uri: deviceInfo.verification_uri, expires_in: deviceInfo.expires_in };
                const mainWindow = getMainWindow();
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("microsoft-device-code", payload);
                mainLog("[MSA device] " + deviceInfo.message);
            });

            if (loginMicrosoftUserCancelled) return { success: false, cancelled: true };
            if (!response.mcToken) return { success: false, errorCode: "ERR_NO_MC_TOKEN", error: "Jeton Minecraft introuvable." };
            
            const profile = response.profile;
            if (!profile?.name || !profile?.id) return { success: false, errorCode: "ERR_NO_MC_PROFILE", error: profile?.errorMessage || "Pas de profil Minecraft" };

            if (response.msaRefreshToken) {
                const encryptedToken = await encryptText(response.msaRefreshToken);
                await fs.promises.writeFile(path.join(cacheDir, sessionLabel + '.json'), JSON.stringify({ refreshToken: encryptedToken }));
            }

            mainLog(`Authentification réussie : ${profile.name}`);
            return { success: true, auth: { access_token: response.mcToken, client_token: crypto.randomUUID(), uuid: profile.id, name: profile.name, user_properties: {}, meta: { type: "msa", demo: false, msaCacheKey: sessionLabel } } };
        } catch (err) {
            if (loginMicrosoftUserCancelled || (err instanceof URIError && /cancel/i.test(String(err.message || "")))) { mainLog("Connexion Microsoft annulée."); return { success: false, cancelled: true }; }
            const msg = err?.message ? err.message : String(err);
            mainLog("Erreur Auth : " + msg);
            return { success: false, error: msg };
        } finally {
            activeMicrosoftAuthFlow = null;
            isAuthRunning = false;
        }
    });

    ipcMain.handle("upload-mojang-skin", async (_, { accessToken, skinPath, variant }) => {
        try {
            const safeSkinPath = assertPathUnderSandbox(skinPath);
            const fileBuffer = await fs.promises.readFile(safeSkinPath);
            const fileBlob = new Blob([fileBuffer], { type: "image/png" });
            const formData = new FormData();
            const VALID_VARIANTS = new Set(["classic", "slim"]);
            const safeVariant = VALID_VARIANTS.has(variant) ? variant : "classic";
            formData.append("variant", safeVariant);
            formData.append("file", fileBlob, "skin.png");

            const res = await fetch("https://api.minecraftservices.com/minecraft/profile/skins", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                },
                body: formData
            });

            if (res.ok) {
                return { success: true };
            } else {
                const errText = await res.text();
                return { success: false, error: `Erreur HTTP ${res.status}: ${errText}` };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle("refresh-microsoft", async (_, sessionLabel) => {
        try {
            if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) {
                return { success: false, error: "Identifiant de session invalide." };
            }
            const MicrosoftAuth = require("../gens-core/components/auth.js");
            const cacheFile = path.join(safeDataDir, "msa-cache", sessionLabel + '.json');
            
            if (!(await fs.promises.access(cacheFile).then(()=>true).catch(()=>false))) throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");
            const cache = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
            if (!cache.refreshToken) throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");

            let decryptedToken;
            try {
                decryptedToken = await decryptText(cache.refreshToken); // AUDIT-13 : await manquant corrigé
                if (!decryptedToken) throw new Error("Token déchiffré nul");
            } catch (e) {
                throw new Error("Impossible de déchiffrer le token de rafraîchissement.");
            }

            const auth = new MicrosoftAuth();
            const response = await auth.flowRefresh(decryptedToken);
            
            if (response.msaRefreshToken) {
                const encryptedToken = await encryptText(response.msaRefreshToken);
                await fs.promises.writeFile(cacheFile, JSON.stringify({ refreshToken: encryptedToken }));
            }

            mainLog(`Token Microsoft rafraîchi pour : ${sessionLabel}`);
            return { success: true, access_token: response.mcToken };
        } catch (err) {
            mainLog("Erreur refresh token (Reconnexion requise) : " + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("delete-msa-cache", async (_, sessionLabel) => { // AUDIT-28 : on→handle pour retourner un résultat
        try {
            if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) { mainLog(`Suppression cache MSA bloquée : label invalide`); return; }
            const cacheFile = path.join(safeDataDir, "msa-cache", sessionLabel + '.json');

            try {
                await fs.promises.access(cacheFile);
                await fs.promises.rm(cacheFile, { force: true });
                mainLog(`Cache MSA supprimé pour : ${sessionLabel}`);
            } catch (e) {
                const cacheDir = path.join(safeDataDir, "msa-cache", sessionLabel);
                try {
                    await fs.promises.access(cacheDir);
                    await fs.promises.rm(cacheDir, { recursive: true, force: true });
                    mainLog(`Ancien Cache MSA supprimé pour : ${sessionLabel}`);
                } catch (err2) { if (err2 && err2.code !== 'ENOENT') console.warn("Ignored error in ipc-auth.js:", err2); }
            }
        } catch (e) { mainLog("Erreur suppression cache MSA : " + e.message); }
    });

    ipcMain.handle("fetch-mojang-profile", async (_, { token, uuid }) => {
        try {
            if (token) {
                const res = await fetch("https://api.minecraftservices.com/minecraft/profile", {
                    headers: { "Authorization": `Bearer ${token}` }
                });
                if (res.ok) {
                    const profile = await res.json();
                    const activeSkin = profile.skins?.find(s => s.state === "ACTIVE");
                    const activeCape = profile.capes?.find(c => c.state === "ACTIVE");
                    const getHttps = (url) => url ? url.replace('http://', 'https://') : null;
                    if (activeSkin) return { success: true, data: { skinUrl: getHttps(activeSkin.url), capeUrl: getHttps(activeCape?.url) } };
                }
            }
            if (uuid) {
                const profileRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
                if (!profileRes.ok) throw new Error("profile not found: " + profileRes.status);
                const profile = await profileRes.json();
                const encoded = profile.properties?.find(p => p.name === "textures")?.value;
                if (!encoded) throw new Error("no textures");
                const textures = JSON.parse(Buffer.from(encoded, "base64").toString()).textures;
                const getHttps = (url) => url ? url.replace('http://', 'https://') : null;
                return { success: true, data: { skinUrl: getHttps(textures?.SKIN?.url), capeUrl: getHttps(textures?.CAPE?.url) } };
            }
            return { success: false, error: "No valid profile found" };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
};
