// @ts-check
import { store } from "../store.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    /**
     * Liste les dossiers de mondes disponibles pour l'instance sélectionnée.
     * @returns {Promise<string[]>}
     */
    window.listInstanceWorlds = async () => {
        if (store.selectedInstanceIdx === null) return [];
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return [];
        const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
        if (!(await window.existsSafe(savesDir))) return [];
        const entries = await fs.promises.readdir(savesDir);
        /** @type {string[]} */
        const worlds = [];
        for (const entry of entries) {
            try {
                const st = await fs.promises.stat(path.join(savesDir, entry));
                const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : Boolean(st.isDirectory);
                if (isDir) worlds.push(entry);
            } catch (_) {}
        }
        return worlds;
    };

    /**
     * @param {string} worldName
     * @returns {Promise<string[]>}
     */
    window.listWorldDatapacks = async (worldName) => {
        if (store.selectedInstanceIdx === null || !worldName) return [];
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return [];
        const dpDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", worldName, "datapacks");
        if (!window.isPathInsideDir(dpDir, path.join(store.instancesRoot, window.safeDir(inst.name), "saves"))) return [];
        if (!(await window.existsSafe(dpDir))) return [];
        const files = await fs.promises.readdir(dpDir);
        return files.filter((/** @type {string} */ f) => f.endsWith(".zip") || f.endsWith(".zip.disabled"));
    };

    /**
     * @param {string} worldName
     * @param {string} filename
     * @param {boolean} isEnabled
     */
    window.toggleWorldDatapack = async (worldName, filename, isEnabled) => {
        if (store.selectedInstanceIdx === null || !worldName || !filename) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const dpDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", worldName, "datapacks");
        if (!window.isPathInsideDir(dpDir, path.join(store.instancesRoot, window.safeDir(inst.name), "saves"))) return;
        const nextName = isEnabled ? filename.replace(/\.disabled$/, "") : (filename.endsWith(".disabled") ? filename : `${filename}.disabled`);
        await fs.promises.rename(path.join(dpDir, filename), path.join(dpDir, nextName));
    };

    /**
     * @param {string} worldName
     * @param {string} filename
     */
    window.deleteWorldDatapack = async (worldName, filename) => {
        if (store.selectedInstanceIdx === null || !worldName || !filename) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const dpDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", worldName, "datapacks");
        if (!window.isPathInsideDir(dpDir, path.join(store.instancesRoot, window.safeDir(inst.name), "saves"))) return;
        const target = path.join(dpDir, filename);
        if (await window.existsSafe(target)) {
            await fs.promises.unlink(target);
        }
    };
}
