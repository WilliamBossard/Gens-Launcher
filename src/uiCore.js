
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
                        window.safeWriteJSON(store.instanceFile, store.allInstances);
                        if (window.setUIState) window.setUIState();
                        if (window.renderUI)   window.renderUI();
                        if (window.updateRPC)  window.updateRPC();
                    }
                    if (store.activeInstances.size === 0) {
                        clearInterval(_restorePollInterval);
                        _restorePollInterval = null;
                    }
                } catch(e) { }
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
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
    };
}