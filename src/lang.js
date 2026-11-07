// @ts-check
import { store } from "./store.js";
const fs = window.api.fs;
const path = window.api.path;

export async function setupLang() {
    window.applyTranslations = () => {
        document.querySelectorAll("[data-i18n]").forEach((element) => {
            const el = /** @type {HTMLElement} */ (element);
            const key = el.getAttribute("data-i18n");
            if (key && store.currentLangObj[key]) {
                if (el instanceof HTMLInputElement && el.type === "text") el.placeholder = store.currentLangObj[key];
                else el.innerText = store.currentLangObj[key];
            }
        });
        document.querySelectorAll("[data-i18n-title]").forEach((element) => {
            const el = /** @type {HTMLElement} */ (element);
            const key = el.getAttribute("data-i18n-title");
            if (key && store.currentLangObj[key]) el.title = store.currentLangObj[key];
        });
        document.querySelectorAll("[data-i18n-tooltip]").forEach((element) => {
            const el = /** @type {HTMLElement} */ (element);
            const key = el.getAttribute("data-i18n-tooltip");
            if (key && store.currentLangObj[key]) el.setAttribute("data-tooltip", store.currentLangObj[key]);
        });
        
        const cv = document.getElementById("current-app-version");
        if (cv) cv.innerText = "v" + window.api.version;
        if (window.updateLaunchButton) window.updateLaunchButton();
        if (window.updateRPC) window.updateRPC();
    };

    const syncReadyPromise = (async () => {
        let defaultFr = {};
        let defaultEn = {};

        try {
            let appDir = decodeURIComponent(window.location.pathname);
            if (appDir.startsWith("/") && appDir.match(/^\/[a-zA-Z]:/)) {
                appDir = appDir.substring(1);
            }
            appDir = path.dirname(appDir);

            const frPath = path.join(appDir, "src", "locales", "fr.json");
            const frContent = await fs.promises.readFile(frPath, "utf8");
            defaultFr = JSON.parse(frContent);

            const enPath = path.join(appDir, "src", "locales", "en.json");
            const enContent = await fs.promises.readFile(enPath, "utf8");
            defaultEn = JSON.parse(enContent);
        } catch (e) {
            console.error("Erreur de lecture des traductions internes:", e);
        }

        /**
         * @param {string} filePath
         * @param {Record<string, any>} defaultObj
         */
        async function syncLangFile(filePath, defaultObj) {
            let current = {};
            if (await window.existsSafe(filePath)) {
                try { current = JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in lang.js:", e); }
            }
            const merged = Object.assign({}, defaultObj, current);
            const dir = path.dirname(filePath);
            if (!(await window.existsSafe(dir))) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            const mergedJson = JSON.stringify(merged, null, 2);
            if (JSON.stringify(current, null, 2) !== mergedJson) {
                await fs.promises.writeFile(filePath, mergedJson);
            }
        }

        await syncLangFile(path.join(store.langDir, "fr.json"), defaultFr);
        await syncLangFile(path.join(store.langDir, "en.json"), defaultEn);
    })();

    window.loadLanguage = async (/** @type {string} */ code) => {
        await syncReadyPromise;
        const p = path.join(store.langDir, `${code}.json`);
        if (await window.existsSafe(p)) {
            try {
                const content = await fs.promises.readFile(p, "utf8");
                store.currentLangObj = JSON.parse(content);
                window.applyTranslations();
            } catch (e) {
                console.error("Erreur lecture fichier de langue:", e);
            }
        }
    };

    window.changeLanguage = async (/** @type {string} */ code) => {
        store.globalSettings.language = code;
        if (window.safeWriteJSONAsync) {
            await window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            await fs.promises.writeFile(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        await window.loadLanguage(code);
        if (window.renderUI) window.renderUI();
        if (window.checkServerStatus && store.globalSettings.serverIp?.trim()) window.checkServerStatus();
        if (window.checkAchievement) {
            window.checkAchievement("polyglot");
        }
    };

    window.saveFirstLaunch = async () => {
        const input = /** @type {HTMLSelectElement | HTMLInputElement | null} */ (document.getElementById("first-launch-lang"));
        const code = input ? input.value : "fr";
        store.globalSettings.language = code;
        if (window.safeWriteJSONAsync) {
            await window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            await fs.promises.writeFile(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        await window.loadLanguage(code);
        if (window.populateLangDropdown) await window.populateLangDropdown();
        const modal = document.getElementById("modal-first-launch");
        if (modal) modal.style.display = "none";
    };

    window.populateLangDropdown = async () => {
        await syncReadyPromise;
        const select = /** @type {HTMLSelectElement | null} */ (document.getElementById("global-lang"));
        if (!select) return;
        select.innerHTML = "";
        const allFiles = await fs.promises.readdir(store.langDir);
        allFiles.filter((f) => f.endsWith(".json")).forEach((f) => {
            const code = f.replace(".json", "");
            const opt = document.createElement("option");
            opt.value = code;
            opt.innerText = code.toUpperCase();
            if (code === store.globalSettings.language) opt.selected = true;
            select.appendChild(opt);
        });
    };

    await syncReadyPromise;
}
