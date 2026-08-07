
import { store } from "./store.js";
const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const clipboard = window.api.clipboard;
export function setupUICore() {
    let _restorePollInterval = null;
    window.restoreRunningInstances = async () => {
        if (_restorePollInterval) return;
        try {
            const stillRunning = await window.api.invoke("get-still-running");
            if (!stillRunning || stillRunning.length === 0) return;
            stillRunning.forEach(rawId => {
                const displayName = window.resolveInstanceName(rawId);
                store.activeInstances.add(displayName);
            });
            if (window.setUIState) window.setUIState();
            if (window.renderUI)   window.renderUI();
            stillRunning.forEach(rawId => {
                const displayName = window.resolveInstanceName(rawId);
                const inst = store.allInstances.find(i => i.name === displayName);
                if (inst && !inst._tempSessionStart) inst._tempSessionStart = Date.now();
            });
            _restorePollInterval = setInterval(async () => {
                try {
                    const alive = await window.api.invoke("get-still-running");
                    const aliveSet = new Set(alive || []);
                    let changed = false;
                    for (const instanceId of [...store.activeInstances]) {
                        const folderSlug = window.resolveInstanceFolder(instanceId);
                        const stillUp = alive.some(id =>
                            id === instanceId ||
                            window.resolveInstanceName(id) === instanceId ||
                            window.safeDir(id) === folderSlug
                        );
                        if (stillUp) continue;
                        store.activeInstances.delete(instanceId);
                        changed = true;
                        const inst = store.allInstances.find(i => i.name === instanceId);
                        if (inst) {
                            const now = Date.now();
                            const sessionDuration = inst._tempSessionStart
                                ? now - inst._tempSessionStart
                                : 0;
                            inst._tempSessionStart = null;
                            if (sessionDuration > 0 && sessionDuration < 86400000) {
                                inst.playTime   = (inst.playTime   || 0) + sessionDuration;
                                inst.lastPlayed = now;
                                if (!inst.sessionHistory) inst.sessionHistory = [];
                                const d = new Date();
                                const today = d.getFullYear() + "-" +
                                    String(d.getMonth() + 1).padStart(2, "0") + "-" +
                                    String(d.getDate()).padStart(2, "0");
                                const existing = inst.sessionHistory.find(s => s.date === today);
                                if (existing) existing.ms += sessionDuration;
                                else inst.sessionHistory.push({ date: today, ms: sessionDuration });
                                inst.sessionHistory = inst.sessionHistory.slice(-30);
                            }
                        }
                    }
                    if (changed) {
                        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                        if (window.setUIState) window.setUIState();
                        if (window.renderUI)   window.renderUI();
                        if (window.updateRPC)  window.updateRPC();
                    }
                    if (store.activeInstances.size === 0) {
                        clearInterval(_restorePollInterval);
                        _restorePollInterval = null;
                    }
                } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in uiCore.js:", e); }
            }, 5000);
        } catch(e) {
            console.error("Erreur restauration instances actives:", e);
        }
    };
    window.handleInstanceDoubleClick = (idx) => {
        window.selectInstance(idx);
        const inst = store.allInstances[idx];
        if (!store.activeInstances.has(inst.name)) {
            const btn = document.getElementById('launch-btn');
            if (btn) btn.click();
        }
    };
    window.toggleCategory = (element, groupName) => {
        const grid = element.nextElementSibling; 
        const arrow = element.querySelector('.cat-arrow'); 
        if (!store.globalSettings.collapsedGroups) store.globalSettings.collapsedGroups = {};
        if (grid.style.display === 'none') { 
            grid.style.display = 'grid'; 
            arrow.style.transform = 'rotate(0deg)';
            store.globalSettings.collapsedGroups[groupName] = false;
        } else { 
            grid.style.display = 'none'; 
            arrow.style.transform = 'rotate(-90deg)'; 
            store.globalSettings.collapsedGroups[groupName] = true;
        }
        if (window.safeWriteJSONAsync) {
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        }
    };

    window.activeModal = null;
    window.openModal = (modalId) => {
        if (window.activeModal && window.activeModal !== modalId) {
            window.closeModal(window.activeModal);
        }
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = "block";
            window.activeModal = modalId;
        }
    };
    
    window.closeModal = (modalId) => {
        const id = modalId || window.activeModal;
        if (!id) return;
        const modal = document.getElementById(id);
        if (modal) {
            modal.style.display = "none";
        }
        if (window.activeModal === id) {
            window.activeModal = null;
        }
    };

    window.isTrulyOnline = navigator.onLine;
    window.checkRealInternet = async () => {
        if (!navigator.onLine) {
            if (window.isTrulyOnline) {
                window.isTrulyOnline = false;
                window.updateOfflineUIState();
            }
            return;
        }
        try {
            const isOnline = await window.api.invoke("check-internet");
            if (window.isTrulyOnline !== isOnline) {
                window.isTrulyOnline = isOnline;
                window.updateOfflineUIState();
                if (isOnline && window.checkServerStatus) window.checkServerStatus();
            }
        } catch(e) {}
    };
    setInterval(window.checkRealInternet, 5000);
    setTimeout(window.checkRealInternet, 1000);

    window.updateOfflineUIState = () => {
        const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
        const elementsToDisable = [
            "btn-toolbar-catalog",
            "btn-toolbar-builder",
            "btn-open-catalog-mods",
            "btn-open-catalog-shaders",
            "btn-open-catalog-resourcepacks",
            "btn-update-modpack",
            "btn-check-mod-updates",
            "btn-check-launcher",
            "btn-ms-login",
            "btn-horizon-update",
            "btn-skin-acc",
            "settings-horizon-content"
        ];
        
        elementsToDisable.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (isOffline) {
                    el.classList.add("offline-disabled");
                    if (id === "settings-horizon-content") {
                        el.style.pointerEvents = "none";
                    }
                } else {
                    el.classList.remove("offline-disabled");
                    if (id === "settings-horizon-content") {
                        el.style.pointerEvents = "auto";
                    }
                }
            }
        });

        document.querySelectorAll('[id^="btn-dl-java-"]').forEach(btn => {
            if (btn.getAttribute("data-i18n") === "btn_java_dl") {
                if (isOffline) {
                    btn.classList.add("offline-disabled");
                    btn.onclick = (e) => {
                        if (window.showToast) window.showToast(window.t("msg_err_offline", "Cette fonctionnalité nécessite une connexion internet."), "error");
                    };
                } else {
                    btn.classList.remove("offline-disabled");
                    const v = btn.id.replace("btn-dl-java-", "");
                    btn.onclick = () => { if (window.downloadJavaAuto) window.downloadJavaAuto(parseInt(v)); };
                }
            }
        });

        if (!isOffline && window.loadNews) {
            window.loadNews();
        }
    };

    window.addEventListener('online', () => { window.checkRealInternet(); });
    window.addEventListener('offline', () => { window.checkRealInternet(); });
}