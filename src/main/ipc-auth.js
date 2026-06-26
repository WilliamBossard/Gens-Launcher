const { Titles } = require("prismarine-auth");

module.exports = function setupAuthHandlers(context) {
    const { ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, crypto } = context;

    let isAuthRunning = false;
    let activeMicrosoftAuthFlow = null;
    let loginMicrosoftUserCancelled = false;

    ipcMain.on("cancel-login-microsoft", () => {
        loginMicrosoftUserCancelled = true;
        if (activeMicrosoftAuthFlow?.msa) activeMicrosoftAuthFlow.msa.polling = false;
        mainLog("Annulation demandée (connexion Microsoft).");
    });

    ipcMain.handle("login-microsoft", async () => {
        if (isAuthRunning) return { success: false, errorCode: "ERR_AUTH_RUNNING", error: "Une connexion est déjà en cours." };
        isAuthRunning = true;
        loginMicrosoftUserCancelled = false;

        const { Authflow } = require("prismarine-auth");

        const sessionLabel = `gens-${crypto.randomUUID()}`;
        const cacheDir = path.join(safeDataDir, "msa-cache");

        try {
            const flow = new Authflow(sessionLabel, cacheDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", deviceVersion: "0.0.0" }, (deviceInfo) => {
                const payload = { message: deviceInfo.message, user_code: deviceInfo.user_code, verification_uri: deviceInfo.verification_uri, expires_in: deviceInfo.expires_in };
                const mainWindow = getMainWindow();
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("microsoft-device-code", payload);
                mainLog("[MSA device] " + deviceInfo.message);
            });
            activeMicrosoftAuthFlow = flow;

            const origGetMsaToken = flow.getMsaToken.bind(flow);
            flow.getMsaToken = async function () {
                if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled");
                try { return await origGetMsaToken(); } catch (err) { if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled"); throw err; }
            };

            const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
            if (loginMicrosoftUserCancelled) return { success: false, cancelled: true };
            if (!response.token) return { success: false, errorCode: "ERR_NO_MC_TOKEN", error: "Jeton Minecraft introuvable." };
            const profile = response.profile;
            if (!profile?.name || !profile?.id) return { success: false, errorCode: "ERR_NO_MC_PROFILE", error: profile?.errorMessage || "Pas de profil Minecraft" };

            mainLog(`Authentification réussie : ${profile.name}`);
            return { success: true, auth: { access_token: response.token, client_token: crypto.randomUUID(), uuid: profile.id, name: profile.name, user_properties: {}, meta: { type: "msa", demo: false, msaCacheKey: sessionLabel } } };
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
            const fileBuffer = await fs.promises.readFile(skinPath);
            const fileBlob = new Blob([fileBuffer], { type: "image/png" });
            const formData = new FormData();
            formData.append("variant", variant || "classic");
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
            const { Authflow } = require("prismarine-auth");
            const cacheDir = path.join(safeDataDir, "msa-cache");

            const flow = new Authflow(sessionLabel, cacheDir, {
                flow: "live",
                authTitle: Titles.MinecraftNintendoSwitch,
                deviceType: "Nintendo",
                deviceVersion: "0.0.0",
            }, (deviceInfo) => {
                throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");
            });

            const response = await flow.getMinecraftJavaToken({ fetchProfile: false });
            mainLog(`Token Microsoft rafraîchi pour : ${sessionLabel}`);
            return { success: true, access_token: response.token };
        } catch (err) {
            mainLog("Erreur refresh token (Reconnexion requise) : " + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.on("delete-msa-cache", async (_, sessionLabel) => {
        try {
            if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) { mainLog(`Suppression cache MSA bloquée : label invalide`); return; }
            const cacheDir = path.join(safeDataDir, "msa-cache", sessionLabel);

            try {
                await fs.promises.access(cacheDir);
                await fs.promises.rm(cacheDir, { recursive: true, force: true });
                mainLog(`Cache MSA supprimé pour : ${sessionLabel}`);
            } catch (e) {
            }
        } catch (e) { mainLog("Erreur suppression cache MSA : " + e.message); }
    });
};
