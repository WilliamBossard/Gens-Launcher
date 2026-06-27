import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    async function getModWarnings(inst) {
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        let provided = new Set(["minecraft", "java", "fabricloader", "forge", "quilt", "quilt_loader", "fabric"]);
        let reqs = {};
        if (!fs.existsSync(modsPath)) return {};
        const files = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
        for (const f of files) {
            try {
                const fullPath = path.join(modsPath, f);
                const res = await window.api.invoke("read-zip-text", { 
                    zipPath: fullPath, 
                    entryNames: ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml"] 
                });
                if (res.success && res.text) {
                    if (res.file.endsWith(".json")) {
                        const json = JSON.parse(res.text);
                        if (json.id) provided.add(json.id);
                        if (json.provides) json.provides.forEach(p => provided.add(p));
                        if (json.depends) reqs[f] = Object.keys(json.depends);
                    } else if (res.file.endsWith(".toml")) {
                        const idMatch = res.text.match(/modId\s*=\s*"([^"]+)"/);
                        if (idMatch) provided.add(idMatch[1]);
                        const blockRegex = /\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*"([^"]+)"/g;
                        let m;
                        while ((m = blockRegex.exec(res.text)) !== null) {
                            if (!reqs[f]) reqs[f] = [];
                            reqs[f].push(m[1]);
                        }
                    }
                }
            } catch(e) {}
            await yieldUI(); 
        }
        let warnings = {};
        for (let f in reqs) {
            reqs[f].forEach(reqId => {
                const cleanId = reqId.toLowerCase();
                if (!provided.has(cleanId) && 
                    !cleanId.startsWith("fabric-") && 
                    !cleanId.startsWith("quilt_") && 
                    !cleanId.startsWith("forge:") && 
                    !["commonnetworking", "architectury", "midnightlib"].includes(cleanId)
                ) {
                    if (!warnings[f]) warnings[f] = [];
                    warnings[f].push(reqId);
                }
            });
        }
        return warnings;
    }
    window.renderModsManager = async function() {
        const modsListDiv = document.getElementById("mods-list");
        const savedScroll = modsListDiv.scrollTop;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
        const files = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
        const warnings = await getModWarnings(inst);
        let hasMods = files.length > 0;
        let htmlBuilder = ""; 
        files.forEach(f => {
            const isEnabled = !f.endsWith(".disabled");
            const displayName = window.escapeHTML(f.replace(".disabled", ""));
            const color = isEnabled ? "var(--text-light)" : "#666";
            const decoration = isEnabled ? "none" : "line-through";
            const fileJson = safeAttrJson(f);
            let warningHtml = "";
            if (warnings[f] && isEnabled) {
                warningHtml = `<div style="font-size:0.7rem; color:#f48a21; margin-top:2px;">⚠ ${t("msg_warn_deps", "Dépendance manquante potentielle : ")} ${window.escapeHTML(warnings[f].join(", "))}</div>`;
            }
            htmlBuilder += `
            <div class="mod-item" style="flex-direction: column; align-items: flex-start;">
                <div style="display:flex; width: 100%; justify-content: space-between; align-items: center;">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange='toggleMod(${fileJson}, this.checked)' title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" onclick='deleteMod(${fileJson})' title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>
                ${warningHtml}
            </div>`;
        });
        if (hasMods) {
            modsListDiv.innerHTML = htmlBuilder;
            if (window.filterLocalMods) window.filterLocalMods();
        } else {
            modsListDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_mods", "Aucun mod local installé.")}</div>`;
        }
        modsListDiv.scrollTop = savedScroll;
    };
    window.filterLocalMods = () => {
        const filter = document.getElementById("local-mod-search").value.toLowerCase();
        const items = document.querySelectorAll("#mods-list .mod-item");
        items.forEach(item => {
            const text = item.innerText.toLowerCase();
            item.style.display = text.includes(filter) ? "flex" : "none";
        });
    };
    window.toggleMod = (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        fs.renameSync(
            path.join(modsPath, filename),
            path.join(modsPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderModsManager();
    };
    window.deleteMod = async (filename) => {
      if (await window.showCustomConfirm(t("msg_delete_confirm", "Voulez-vous vraiment supprimer ce fichier ?") + "\n(" + filename + ")", true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
            try {
                const filePath = path.join(modsPath, filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    window.showToast(t("msg_mod_deleted", "Mod supprimé !"), "success");
                    window.renderModsManager(); 
                }
            } catch(e) {
                window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error");
            }
        }
    };
}
