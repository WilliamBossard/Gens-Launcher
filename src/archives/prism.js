// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

/**
 * Parse les métadonnées d'une archive Prism Launcher / MultiMC (`mmc-pack.json` + `instance.cfg`).
 * @param {string} mmcPackText
 * @param {string | null} [instanceCfgText]
 * @returns {{ name: string; version: string; loader: 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'; loaderVersion: string; ram: string }}
 */
export function parsePrismPackMetadata(mmcPackText, instanceCfgText = null) {
    let parsed;
    try {
        parsed = JSON.parse(mmcPackText);
    } catch (_) {
        throw new Error("mmc-pack.json invalide.");
    }
    const components = Array.isArray(parsed?.components) ? parsed.components : [];
    let version = "1.20.4";
    /** @type {'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'} */
    let loader = "vanilla";
    let loaderVersion = "";

    for (const comp of components) {
        if (!comp || typeof comp !== "object") continue;
        const uid = String(comp.uid || "");
        const ver = typeof comp.version === "string" ? comp.version.trim() : "";
        if (uid === "net.minecraft" && ver) {
            version = ver;
        } else if (uid === "net.fabricmc.fabric-loader" && ver) {
            loader = "fabric";
            loaderVersion = ver;
        } else if (uid === "net.minecraftforge" && ver) {
            loader = "forge";
            loaderVersion = ver;
        } else if (uid === "net.neoforged" && ver) {
            loader = "neoforge";
            loaderVersion = ver;
        } else if (uid === "org.quiltmc.quilt-loader" && ver) {
            loader = "quilt";
            loaderVersion = ver;
        }
    }

    let name = "Instance Prism";
    let ram = "4096";
    if (typeof instanceCfgText === "string" && instanceCfgText.trim()) {
        for (const rawLine of instanceCfgText.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eqIdx = line.indexOf("=");
            if (eqIdx <= 0) continue;
            const key = line.slice(0, eqIdx).trim();
            const val = line.slice(eqIdx + 1).trim();
            if (key === "name" && val) name = val.substring(0, 128);
            if (key === "MaxMemAlloc" && /^\d+$/.test(val)) {
                ram = String(Math.max(1024, Math.min(65536, parseInt(val, 10))));
            }
        }
    }

    return { name, version, loader, loaderVersion, ram };
}

export function setup() {
    const t = (/** @type {string} */ k, fallback = "") => window.t ? window.t(k, fallback) : (fallback || k);

    /**
     * @param {string} zipPath
     * @param {string | null} [mmcPackText]
     */
    window.handlePrismImport = async (zipPath, mmcPackText = null) => {
        sysLog(`[IMPORT PRISM] Démarrage import Prism/MultiMC : ${zipPath}`);
        window.showLoading(t("msg_extract", "Extraction..."), 0);
        await yieldUI();
        const tempExtractDir = path.join(store.dataDir, "temp_prism_import_" + Date.now());
        try {
            const exRes = await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction archive Prism.");

            let extractRoot = tempExtractDir;
            if (!(await window.existsSafe(path.join(extractRoot, "mmc-pack.json")))) {
                const items = await fs.promises.readdir(tempExtractDir);
                if (items.length === 1) {
                    const sub = path.join(tempExtractDir, items[0]);
                    const st = await fs.promises.stat(sub);
                    const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : Boolean(st.isDirectory);
                    if (isDir && (await window.existsSafe(path.join(sub, "mmc-pack.json")))) {
                        extractRoot = sub;
                    }
                }
            }

            const packRaw = mmcPackText || await fs.promises.readFile(path.join(extractRoot, "mmc-pack.json"), "utf8");
            const cfgPath = path.join(extractRoot, "instance.cfg");
            const cfgRaw = (await window.existsSafe(cfgPath)) ? await fs.promises.readFile(cfgPath, "utf8") : null;
            const meta = parsePrismPackMetadata(packRaw, cfgRaw);

            const finalName = window.nextAvailableInstanceName(meta.name);
            const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
            await fs.promises.mkdir(instDir, { recursive: true });

            const mcSubCandidates = [path.join(extractRoot, ".minecraft"), path.join(extractRoot, "minecraft")];
            let contentSrc = extractRoot;
            for (const cand of mcSubCandidates) {
                if (await window.existsSafe(cand)) {
                    contentSrc = cand;
                    break;
                }
            }

            const BLOCKED_ITEMS = new Set(["mmc-pack.json", "instance.cfg", ".packignore", "instance.json", "instance.lock"]);
            const entries = await fs.promises.readdir(contentSrc);
            for (const item of entries) {
                if (BLOCKED_ITEMS.has(item.toLowerCase())) continue;
                const srcItem = path.join(contentSrc, item);
                const destItem = path.join(instDir, item);
                if (!window.isPathInsideDir(destItem, instDir)) continue;
                await fs.promises.cp(srcItem, destItem, { recursive: true, force: true });
            }

            const instData = {
                name: finalName,
                version: window.isValidVersionId(meta.version) ? meta.version : "1.20.4",
                loader: meta.loader,
                loaderVersion: (meta.loaderVersion && window.isValidVersionId(meta.loaderVersion)) ? meta.loaderVersion : "",
                ram: meta.ram,
                javaPath: "",
                jvmArgs: "",
                playTime: 0,
                launchCount: 0,
                icon: store.defaultIcons[meta.loader] || store.defaultIcons.vanilla,
                _localConfigUpdatedAt: Date.now()
            };
            await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(instData, null, 2));
            store.allInstances.push(instData);
            await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(instData, { preserveTimestamp: true });
            store.selectedInstanceIdx = store.allInstances.length - 1;
            window.showToast(t("msg_prism_imported", "Instance Prism/MultiMC importée avec succès !"), "success");
        } catch (/** @type {any} */ err) {
            window.showToast(t("msg_err_import_invalid", "Erreur import Prism/MultiMC : ") + (err?.message || err), "error");
        } finally {
            try {
                if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true });
            } catch (_) {}
            window.hideLoading();
            if (window.renderUI) window.renderUI();
        }
    };
}
