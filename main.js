const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const SPOOF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app.userAgentFallback = SPOOF_UA;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Spoofing uniquement sur les domaines Mojang/Minecraft
const MOJANG_HOSTS = [
    "mojang.com", "minecraft.net", "minecraftservices.com",
    "launchermeta.mojang.com", "launcher.mojang.com",
    "resources.download.minecraft.net", "libraries.minecraft.net"
];

function applySpoofing(sess) {
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            if (MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h))) {
                details.requestHeaders['User-Agent'] = SPOOF_UA;
                delete details.requestHeaders['sec-ch-ua'];
                delete details.requestHeaders['sec-ch-ua-mobile'];
                delete details.requestHeaders['sec-ch-ua-platform'];
            }
        } catch (e) {}
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
}

let mainWindow;

const logPath = path.join(app.getPath("userData"), "main-process.log");
function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    console.log(msg);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 1000, minHeight: 600,
        icon: path.join(__dirname, "assets/icon.ico"),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");
    fs.writeFileSync(logPath, "--- Gens Launcher Main Log ---\n");
}

app.whenReady().then(() => {
    applySpoofing(session.defaultSession);
    app.on('session-created', applySpoofing);
    createWindow();

    autoUpdater.logger = { info: (m) => mainLog(m), warn: (m) => mainLog("WARN: " + m), error: (m) => mainLog("ERR: " + m) };
    autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
    autoUpdater.autoDownload = true;

    setTimeout(() => {
        mainLog("Vérification des mises à jour...");
        autoUpdater.checkForUpdatesAndNotify();
    }, 3000);
});

autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: "Gens Launcher est à jour !", type: "success" });
});
autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-msg', { text: `Version ${info.version} trouvée ! Téléchargement...`, type: "info" });
});
autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-progress', Math.round(progress.percent));
});
autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update-downloaded');
});

ipcMain.on('restart_app', () => { autoUpdater.quitAndInstall(); });
ipcMain.on('hide-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('show-window', () => { if (mainWindow) mainWindow.show(); });

// -------------------------------------------------------
// Auth Microsoft — fenêtre Electron avec session isolée
// et user agent réaliste défini directement sur la fenêtre
// -------------------------------------------------------
ipcMain.handle("login-microsoft", async () => {
    return new Promise((resolve) => {
        const REDIRECT_URI = "https://login.live.com/oauth20_desktop.srf";
        let resolved = false;

        // Session isolée = pas de spoofing ni d'historique du launcher
        const authWindow = new BrowserWindow({
            width: 520,
            height: 650,
            title: "Connexion Microsoft",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                partition: "persist:ms-auth"
            }
        });

        authWindow.setMenuBarVisibility(false);

        // User agent d'un vrai Chrome — défini directement sur la fenêtre
        authWindow.webContents.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );

        const authUrl = "https://login.live.com/oauth20_authorize.srf?" + new URLSearchParams({
            client_id: "00000000402b5328",
            response_type: "code",
            scope: "service::user.auth.xboxlive.com::MBI_SSL",
            redirect_uri: REDIRECT_URI,
            prompt: "select_account"
        });

        authWindow.loadURL(authUrl);
        mainLog("Fenêtre OAuth Microsoft ouverte.");

        function finish(result) {
            if (resolved) return;
            resolved = true;
            try { authWindow.close(); } catch (e) {}
            resolve(result);
        }

        async function handleCallback(url) {
            if (!url.startsWith(REDIRECT_URI)) return;
            if (resolved) return;

            const code = new URL(url).searchParams.get("code");
            if (!code) {
                finish({ success: false, error: "Connexion annulée." });
                return;
            }

            mainLog("Code OAuth reçu, échange des tokens...");

            try {
                // Étape 1 : Access token Microsoft
                const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        client_id: "00000000402b5328",
                        code,
                        grant_type: "authorization_code",
                        redirect_uri: REDIRECT_URI
                    })
                });
                const tokenData = await tokenRes.json();
                if (!tokenData.access_token) throw new Error("Pas d'access_token MS : " + JSON.stringify(tokenData));
                mainLog("Access token Microsoft obtenu.");

                // Étape 2 : Xbox Live token
                const xblRes = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Accept": "application/json" },
                    body: JSON.stringify({
                        Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: tokenData.access_token },
                        RelyingParty: "http://auth.xboxlive.com",
                        TokenType: "JWT"
                    })
                });
                const xblData = await xblRes.json();
                mainLog("Token Xbox Live obtenu.");

                // Étape 3 : XSTS token
                const xstsRes = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Accept": "application/json" },
                    body: JSON.stringify({
                        Properties: { SandboxId: "RETAIL", UserTokens: [xblData.Token] },
                        RelyingParty: "rp://api.minecraftservices.com/",
                        TokenType: "JWT"
                    })
                });
                const xstsData = await xstsRes.json();
                const uhs = xstsData.DisplayClaims.xui[0].uhs;
                mainLog("Token XSTS obtenu.");

                // Étape 4 : Token Minecraft
                const mcRes = await fetch("https://api.minecraftservices.com/authentication/login_with_xbox", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsData.Token}` })
                });
                const mcData = await mcRes.json();
                if (!mcData.access_token) throw new Error("Pas de token Minecraft : " + JSON.stringify(mcData));
                mainLog("Token Minecraft obtenu.");

                // Étape 5 : Profil
                const profileRes = await fetch("https://api.minecraftservices.com/minecraft/profile", {
                    headers: { "Authorization": `Bearer ${mcData.access_token}` }
                });
                const profile = await profileRes.json();
                if (!profile.name) throw new Error("Profil introuvable : " + JSON.stringify(profile));
                mainLog(`Authentification réussie : ${profile.name}`);

                finish({
                    success: true,
                    auth: {
                        access_token: mcData.access_token,
                        client_token: "0",
                        uuid: profile.id,
                        name: profile.name,
                        user_properties: "{}",
                        meta: { type: "msa", demo: false }
                    }
                });
            } catch (err) {
                mainLog("Erreur OAuth : " + err.message);
                finish({ success: false, error: err.message });
            }
        }

        // Intercepter la redirection vers oauth20_desktop.srf
        authWindow.webContents.on("will-redirect", (event, url) => handleCallback(url));
        authWindow.webContents.on("did-navigate", (event, url) => handleCallback(url));

        authWindow.on("closed", () => {
            finish({ success: false, error: "Connexion annulée." });
        });
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});