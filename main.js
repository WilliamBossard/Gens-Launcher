const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");
const { Authflow, Titles } = require("prismarine-auth");

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app.userAgentFallback = CHROME_UA;

let mainWindow;
const logPath = path.join(app.getPath("userData"), "main-process.log");

function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    console.log(msg);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 600,
        icon: path.join(__dirname, "assets/icon.ico"),
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");
    fs.writeFileSync(logPath, "--- Gens Launcher Main Log ---\n");
}

app.whenReady().then(() => {
    createWindow();

    autoUpdater.logger = {
        info: (m) => mainLog(m),
        warn: (m) => mainLog("WARN: " + m),
        error: (m) => mainLog("ERR: " + m),
    };
    autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
    autoUpdater.autoDownload = true;

    setTimeout(() => {
        mainLog("Vérification des mises à jour...");
        autoUpdater.checkForUpdatesAndNotify();
    }, 3000);
});

autoUpdater.on("update-not-available", () => {
    if (mainWindow)
        mainWindow.webContents.send("update-msg", {
            text: "Gens Launcher est à jour !",
            type: "success",
        });
});
autoUpdater.on("update-available", (info) => {
    if (mainWindow)
        mainWindow.webContents.send("update-msg", {
            text: `Version ${info.version} trouvée ! Téléchargement...`,
            type: "info",
        });
});
autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) mainWindow.webContents.send("update-progress", Math.round(progress.percent));
});
autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.webContents.send("update-downloaded");
});

ipcMain.on("restart_app", () => {
    autoUpdater.quitAndInstall();
});
ipcMain.on("hide-window", () => {
    if (mainWindow) mainWindow.hide();
});
ipcMain.on("show-window", () => {
    if (mainWindow) mainWindow.show();
});

let isAuthRunning = false;
let activeMicrosoftAuthFlow = null;
let loginMicrosoftUserCancelled = false;

ipcMain.on("cancel-login-microsoft", () => {
    loginMicrosoftUserCancelled = true;
    if (activeMicrosoftAuthFlow?.msa) {
        activeMicrosoftAuthFlow.msa.polling = false;
    }
    mainLog("Annulation demandée (connexion Microsoft).");
});

/**
 * Connexion Microsoft via « device code » (prismarine-auth).
 * IMPORTANT : avec flow "live", utiliser MinecraftNintendoSwitch (client Live valide pour la chaîne Xbox).
 * Titles.MinecraftJava provoque un 403 sur title.auth.xboxlive.com — voir prismarine-auth issue #140.
 * getMinecraftJavaToken() récupère quand même le jeton + profil PC Java.
 */
ipcMain.handle("login-microsoft", async () => {
    if (isAuthRunning) return { success: false, error: "Une connexion est déjà en cours." };
    isAuthRunning = true;
    loginMicrosoftUserCancelled = false;

    const sessionLabel = `gens-${crypto.randomUUID()}`;
    const cacheDir = path.join(app.getPath("userData"), "msa-cache");

    try {
        const flow = new Authflow(
            sessionLabel,
            cacheDir,
            {
                flow: "live",
                authTitle: Titles.MinecraftNintendoSwitch,
                deviceType: "Nintendo",
                deviceVersion: "0.0.0",
            },
            (deviceInfo) => {
                const payload = {
                    message: deviceInfo.message,
                    user_code: deviceInfo.user_code,
                    verification_uri: deviceInfo.verification_uri,
                    expires_in: deviceInfo.expires_in,
                };
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("microsoft-device-code", payload);
                }
                mainLog("[MSA device] " + deviceInfo.message);
            }
        );
        activeMicrosoftAuthFlow = flow;

        // prismarine-auth utilise retry() qui ignore toutes les erreurs sauf URIError : après une annulation,
        // l'erreur était ravalée puis getMsaToken() était rappelé → nouveau device code et popup qui revient,
        // invoke bloqué donc bouton « Connexion... » figé. Propager une URIError coupe la chaîne de retry.
        const origGetMsaToken = flow.getMsaToken.bind(flow);
        flow.getMsaToken = async function () {
            if (loginMicrosoftUserCancelled) {
                throw new URIError("Microsoft login cancelled");
            }
            try {
                return await origGetMsaToken();
            } catch (err) {
                if (loginMicrosoftUserCancelled) {
                    throw new URIError("Microsoft login cancelled");
                }
                throw err;
            }
        };

        const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
        if (loginMicrosoftUserCancelled) {
            return { success: false, cancelled: true };
        }

        const profile = response.profile;

        if (!response.token) {
            return { success: false, error: "Jeton Minecraft introuvable après connexion Microsoft." };
        }
        if (!profile || !profile.name || !profile.id) {
            const hint =
                profile?.errorMessage ||
                profile?.error ||
                "Pas de profil Minecraft sur ce compte. Lance le launcher officiel une fois ou vérifie l’achat Java.";
            return { success: false, error: String(hint) };
        }

        mainLog(`Authentification réussie : ${profile.name}`);

        return {
            success: true,
            auth: {
                access_token: response.token,
                client_token: crypto.randomUUID(),
                uuid: profile.id,
                name: profile.name,
                user_properties: {},
                meta: { type: "msa", demo: false, msaCacheKey: sessionLabel },
            },
        };
    } catch (err) {
        if (
            loginMicrosoftUserCancelled ||
            (err instanceof URIError && /cancel/i.test(String(err.message || "")))
        ) {
            mainLog("Connexion Microsoft annulée.");
            return { success: false, cancelled: true };
        }
        const msg = err && err.message ? err.message : String(err);
        mainLog("Erreur Auth : " + msg);
        return { success: false, error: msg };
    } finally {
        activeMicrosoftAuthFlow = null;
        isAuthRunning = false;
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
