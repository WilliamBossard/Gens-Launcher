import { store } from "./store.js";
const fs = window.api.fs;
const path = window.api.path;

export async function setupLang() {
    window.applyTranslations = () => {
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            const key = el.getAttribute("data-i18n");
            if (store.currentLangObj[key]) {
                if (el.tagName === "INPUT" && el.type === "text") el.placeholder = store.currentLangObj[key];
                else el.innerText = store.currentLangObj[key];
            }
        });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => {
            const key = el.getAttribute("data-i18n-title");
            if (store.currentLangObj[key]) el.title = store.currentLangObj[key];
        });
        document.querySelectorAll("[data-i18n-tooltip]").forEach((el) => {
            const key = el.getAttribute("data-i18n-tooltip");
            if (store.currentLangObj[key]) el.setAttribute("data-tooltip", store.currentLangObj[key]);
        });
        
        const cv = document.getElementById("current-app-version");
        if (cv) cv.innerText = "v" + window.api.version;
        if (window.updateLaunchButton) window.updateLaunchButton();
        if (window.updateRPC) window.updateRPC();
    };

    window.loadLanguage = (code) => {
        const p = path.join(store.langDir, `${code}.json`);
        if (fs.existsSync(p)) {
            try {
                store.currentLangObj = (() => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch(e) { return {}; } })();
                window.applyTranslations();
            } catch (e) {
                console.error("Erreur lecture fichier de langue:", e);
            }
        }
    };

    window.changeLanguage = (code) => {
        store.globalSettings.language = code;
        if (window.safeWriteJSON) {
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        window.loadLanguage(code);
        if (window.checkAchievement) {
            window.checkAchievement("polyglot");
        }
    };

    window.saveFirstLaunch = () => {
        const code = document.getElementById("first-launch-lang").value;
        store.globalSettings.language = code;
        if (window.safeWriteJSON) {
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        window.loadLanguage(code);
        if (window.populateLangDropdown) window.populateLangDropdown();
        document.getElementById("modal-first-launch").style.display = "none";
    };

    window.populateLangDropdown = () => {
        const select = document.getElementById("global-lang");
        if (!select) return;
        select.innerHTML = "";
        fs.readdirSync(store.langDir).filter((f) => f.endsWith(".json")).forEach((f) => {
            const code = f.replace(".json", "");
            const opt = document.createElement("option");
            opt.value = code;
            opt.innerText = code.toUpperCase();
            if (code === store.globalSettings.language) opt.selected = true;
            select.appendChild(opt);
        });
    };

    let defaultFr = {};
    let defaultEn = {};

    try {
        const frUrl = new URL("./locales/fr.json", import.meta.url).href;
        const resFr = await fetch(frUrl);
        defaultFr = await resFr.json();

        const enUrl = new URL("./locales/en.json", import.meta.url).href;
        const resEn = await fetch(enUrl);
        defaultEn = await resEn.json();
    } catch (e) {
        console.error("Erreur de lecture des traductions internes:", e);
    }

    function syncLangFile(filePath, defaultObj) {
        let current = {};
        if (fs.existsSync(filePath)) {
            try { current = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in lang.js:", e); }
        }
        const merged = Object.assign({}, defaultObj, current);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const mergedJson = JSON.stringify(merged, null, 2);
        if (JSON.stringify(current, null, 2) !== mergedJson) {
            fs.writeFileSync(filePath, mergedJson);
        }
    }

    syncLangFile(path.join(store.langDir, "fr.json"), defaultFr);
    syncLangFile(path.join(store.langDir, "en.json"), defaultEn);

    window.applyTranslations = () => {
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            const key = el.getAttribute("data-i18n");
            if (store.currentLangObj[key]) {
                if (el.tagName === "INPUT" && el.type === "text") el.placeholder = store.currentLangObj[key];
                else el.innerText = store.currentLangObj[key];
            }
        });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => {
            const key = el.getAttribute("data-i18n-title");
            if (store.currentLangObj[key]) el.title = store.currentLangObj[key];
        });
        document.querySelectorAll("[data-i18n-tooltip]").forEach((el) => {
            const key = el.getAttribute("data-i18n-tooltip");
            if (store.currentLangObj[key]) el.setAttribute("data-tooltip", store.currentLangObj[key]);
        });
        
        const cv = document.getElementById("current-app-version");
        if (cv) cv.innerText = "v" + window.api.version;
        if (window.updateLaunchButton) window.updateLaunchButton();
        if (window.updateRPC) window.updateRPC();
    };

    window.loadLanguage = (code) => {
        const p = path.join(store.langDir, `${code}.json`);
        if (fs.existsSync(p)) {
            try {
                store.currentLangObj = (() => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch(e) { return {}; } })();
                window.applyTranslations();
            } catch (e) {
                console.error("Erreur lecture fichier de langue:", e);
            }
        }
    };

    window.changeLanguage = (code) => {
        store.globalSettings.language = code;
        if (window.safeWriteJSON) {
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        window.loadLanguage(code);
        if (window.checkAchievement) {
            window.checkAchievement("polyglot");
        }
    };

    window.saveFirstLaunch = () => {
        const code = document.getElementById("first-launch-lang").value;
        store.globalSettings.language = code;
        if (window.safeWriteJSON) {
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        } else {
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        }
        window.loadLanguage(code);
        if (window.populateLangDropdown) window.populateLangDropdown();
        document.getElementById("modal-first-launch").style.display = "none";
    };

    window.populateLangDropdown = () => {
        const select = document.getElementById("global-lang");
        if (!select) return;
        select.innerHTML = "";
        fs.readdirSync(store.langDir).filter((f) => f.endsWith(".json")).forEach((f) => {
            const code = f.replace(".json", "");
            const opt = document.createElement("option");
            opt.value = code;
            opt.innerText = code.toUpperCase();
            if (code === store.globalSettings.language) opt.selected = true;
            select.appendChild(opt);
        });
    };
}
