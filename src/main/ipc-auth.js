// @ts-check

const { existsSafe } = require('./fs-utils');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupAuthHandlers(context) {
    const { ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, crypto, assertPathUnderSandbox } = context;
    const { encryptText, decryptText } = require("./crypto-utils");

    let isAuthRunning = false;
    /** @type {any} */
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
        if (!(await existsSafe(cacheDir))) await fs.promises.mkdir(cacheDir, { recursive: true });

        try {
            const auth = new MicrosoftAuth();
            activeMicrosoftAuthFlow = auth;

            const response = await auth.flowDeviceCode((/** @type {any} */ deviceInfo) => {
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
                response.msaRefreshToken = null;
            }

            mainLog(`Authentification réussie : ${profile.name}`);
            return { success: true, auth: { access_token: response.mcToken, client_token: crypto.randomUUID(), uuid: profile.id, name: profile.name, user_properties: {}, meta: { type: "msa", demo: false, msaCacheKey: sessionLabel } } };
        } catch (err) {
            /** @type {any} */
            const anyErr = err;
            if (loginMicrosoftUserCancelled || (err instanceof URIError && /cancel/i.test(String(anyErr?.message || "")))) { mainLog("Connexion Microsoft annulée."); return { success: false, cancelled: true }; }
            const msg = anyErr?.message ? anyErr.message : String(err);
            mainLog("Erreur Auth : " + msg);
            return { success: false, error: msg };
        } finally {
            activeMicrosoftAuthFlow = null;
            isAuthRunning = false;
        }
    });

    ipcMain.handle("upload-mojang-skin", async (_, { accessToken, skinData, variant }) => {
        try {
            const fileBlob = new Blob([skinData], { type: "image/png" });
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
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("refresh-microsoft", async (_, sessionLabel) => {
        try {
            if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) {
                return { success: false, error: "Identifiant de session invalide." };
            }
            const MicrosoftAuth = require("../gens-core/components/auth.js");
            const cacheFile = path.join(safeDataDir, "msa-cache", sessionLabel + '.json');
            
            if (!(await existsSafe(cacheFile))) throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");
            const cache = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
            if (!cache || typeof cache !== 'object' || !cache.refreshToken) throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");

            /** @type {string | null} */
            let decryptedToken;
            try {
                decryptedToken = await decryptText(cache.refreshToken);
                if (!decryptedToken) throw new Error("Token déchiffré nul");
            } catch (e) {
                throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");
            }

            const auth = new MicrosoftAuth();
            const response = await auth.flowRefresh(decryptedToken);
            
            if (response.msaRefreshToken) {
                const encryptedToken = await encryptText(response.msaRefreshToken);
                await fs.promises.writeFile(cacheFile, JSON.stringify({ refreshToken: encryptedToken }));
                response.msaRefreshToken = null;
            }
            decryptedToken = null;

            mainLog(`Token Microsoft rafraîchi pour : ${sessionLabel}`);
            return { success: true, access_token: response.mcToken };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            mainLog("Erreur refresh token (Reconnexion requise) : " + msg);
            return { success: false, error: msg };
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
                } catch (err2) {
                    /** @type {any} */
                    const anyErr2 = err2;
                    if (anyErr2 && anyErr2.code !== 'ENOENT') console.warn("Ignored error in ipc-auth.js:", err2);
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            mainLog("Erreur suppression cache MSA : " + msg);
        }
    });

    ipcMain.handle("fetch-mojang-profile", async (_, { token, uuid }) => {
        try {
            /** @param {string | null | undefined} url */
            const getHttps = (url) => url ? url.replace('http://', 'https://') : null;

            if (token) {
                const res = await fetch("https://api.minecraftservices.com/minecraft/profile", {
                    headers: { "Authorization": `Bearer ${token}` }
                });
                if (res.ok) {
                    const profile = await res.json();
                    const activeSkin = profile.skins?.find((/** @type {any} */ s) => s.state === "ACTIVE");
                    const activeCape = profile.capes?.find((/** @type {any} */ c) => c.state === "ACTIVE");
                    if (activeSkin) return { success: true, data: { skinUrl: getHttps(activeSkin.url), capeUrl: getHttps(activeCape?.url) } };
                }
            }
            if (uuid) {
                if (typeof uuid !== "string" || !/^[0-9a-f-]{32,36}$/i.test(uuid)) throw new Error("UUID invalide");
                const profileRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuid)}`);
                if (!profileRes.ok) throw new Error("profile not found: " + profileRes.status);
                const profile = await profileRes.json();
                const encoded = profile.properties?.find((/** @type {any} */ p) => p.name === "textures")?.value;
                if (!encoded) throw new Error("no textures");
                const textures = JSON.parse(Buffer.from(encoded, "base64").toString()).textures;
                return { success: true, data: { skinUrl: getHttps(textures?.SKIN?.url), capeUrl: getHttps(textures?.CAPE?.url) } };
            }
            return { success: false, error: "No valid profile found" };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: false, error };
        }
    });

    ipcMain.handle("fetch-mojang-raw-skin", async (_, { name, uuid }) => {
        try {
            let activeUuid = uuid;
            if (!activeUuid && name) {
                const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
                if (res.ok) {
                    const data = await res.json();
                    activeUuid = data.id;
                }
            }
            if (!activeUuid || typeof activeUuid !== "string" || !/^[0-9a-f-]{32,36}$/i.test(activeUuid)) throw new Error("No valid UUID found");
            const profileRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(activeUuid)}`);
            if (!profileRes.ok) throw new Error("Profile fetch failed");
            const profile = await profileRes.json();
            const encoded = profile.properties?.find((/** @type {any} */ p) => p.name === "textures")?.value;
            if (!encoded) throw new Error("No textures property");
            const textures = JSON.parse(Buffer.from(encoded, "base64").toString()).textures;
            const skinUrl = textures?.SKIN?.url;
            if (!skinUrl) throw new Error("No skin URL");
            
            const safeSkinUrl = new URL(skinUrl.replace('http://', 'https://'));
            if (safeSkinUrl.protocol !== 'https:' || (!safeSkinUrl.hostname.endsWith('.minecraft.net') && !safeSkinUrl.hostname.endsWith('.mojang.com'))) {
                throw new Error("Domaine de skin non autorisé");
            }
            const skinRes = await fetch(safeSkinUrl.toString());
            if (!skinRes.ok) throw new Error("Failed to download skin image");
            
            const buffer = await skinRes.arrayBuffer();
            return { success: true, data: Buffer.from(buffer).toString('base64') };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: false, error };
        }
    });
};
