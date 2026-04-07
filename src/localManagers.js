import { store } from "./store.js";
import { yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupLocalManagers() {
    function getModWarnings(inst) {
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        let provided = new Set(["minecraft", "java", "fabricloader", "forge", "quilt", "quilt_loader", "fabric"]);
        let reqs = {};
        if (!fs.existsSync(modsPath)) return {};
        
        const files = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
        
        files.forEach(f => {
            try {
                const zip = window.api.tools.AdmZip(path.join(modsPath, f));
                let text = zip.getEntryText("fabric.mod.json") || zip.getEntryText("quilt.mod.json");
                if (text) {
                    const json = JSON.parse(text);
                    if (json.id) provided.add(json.id);
                    if (json.provides) json.provides.forEach(p => provided.add(p));
                    if (json.depends) {
                        reqs[f] = Object.keys(json.depends);
                    }
                } else {
                    let forgeText = zip.getEntryText("META-INF/mods.toml");
                    if (forgeText) {
                        const idMatch = forgeText.match(/modId\s*=\s*"([^"]+)"/);
                        if (idMatch) provided.add(idMatch[1]);
                        
                        const blockRegex = /\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*"([^"]+)"/g;
                        let m;
                        while ((m = blockRegex.exec(forgeText)) !== null) {
                            if (!reqs[f]) reqs[f] = [];
                            reqs[f].push(m[1]);
                        }
                    }
                }
            } catch(e) {}
        });

        let warnings = {};
        for (let f in reqs) {
            reqs[f].forEach(reqId => {
                if (!provided.has(reqId) && !reqId.includes("forge")) {
                    if (!warnings[f]) warnings[f] = [];
                    warnings[f].push(reqId);
                }
            });
        }
        return warnings;
    }

    window.renderModsManager = function() {
        const modsListDiv = document.getElementById("mods-list");
        modsListDiv.innerHTML = "";
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
        
        const warnings = getModWarnings(inst);
        let hasMods = false;
        
        fs.readdirSync(modsPath).forEach((file) => {
            if (file.endsWith(".jar") || file.endsWith(".jar.disabled")) {
                hasMods = true;
                const isEnabled = !file.endsWith(".disabled");
                const displayName = file.replace(".jar.disabled", ".jar");
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                
                let warningHtml = "";
                if (warnings[file]) {
                    warningHtml = `<span class="custom-tooltip-trigger" data-tooltip="${t("msg_warn_deps", "Dépendance manquante potentielle : ")}${warnings[file].join(', ')}" style="margin-left:6px; color:#f87171; font-size:0.9rem; font-weight:bold;">${t("lbl_warning", "[!]")}</span>`;
                }
                
                modsListDiv.innerHTML += `
                <div class="mod-item">
                    <span style="color: ${color}; text-decoration: ${decoration}; display:flex; align-items:center; flex-grow: 1; word-break: break-all; padding-right: 10px;">${displayName}${warningHtml}</span>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleMod('${file}', this.checked)" title="Activer/Désactiver">
                        <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 2px 6px; font-size: 0.7rem;" onclick="deleteMod('${file}')" title="Supprimer définitivement">X</button>
                    </div>
                </div>`;
            }
        });
        if (!hasMods) modsListDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_mods", "Aucun mod local installé.")}</div>`;
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
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        fs.renameSync(
            path.join(modsPath, filename),
            path.join(modsPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderModsManager();
    };

    window.deleteMod = async (filename) => {
      if (await window.showCustomConfirm(t("msg_delete_mod_confirm", "Voulez-vous vraiment supprimer ce fichier ?") + "\n(" + filename + ")", true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
            try {
                const filePath = path.join(modsPath, filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    window.showToast("Mod supprimé !", "success");
                    window.renderModsManager(); 
                }
            } catch(e) {
                window.showToast("Erreur lors de la suppression.", "error");
            }
        }
    };

    window.renderShadersManager = function() {
        const listDiv = document.getElementById("shaders-list");
        listDiv.innerHTML = "";
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "shaderpacks");
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        let hasItems = false;
        fs.readdirSync(targetPath).forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                hasItems = true;
                const isEnabled = !file.endsWith(".disabled");
                const displayName = file.replace(".zip.disabled", ".zip");
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                listDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleShader('${file}', this.checked)"></div>`;
            }
        });
        if (!hasItems) listDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_shaders", "Aucun shader installé.")}</div>`;
    };

    window.toggleShader = (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "shaderpacks");
        fs.renameSync(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderShadersManager();
    };

    window.renderResourcePacksManager = function() {
        const listDiv = document.getElementById("resourcepacks-list");
        listDiv.innerHTML = "";
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "resourcepacks");
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        let hasItems = false;
        fs.readdirSync(targetPath).forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                hasItems = true;
                const isEnabled = !file.endsWith(".disabled");
                const displayName = file.replace(".zip.disabled", ".zip");
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                listDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleResourcePack('${file}', this.checked)"></div>`;
            }
        });
        if (!hasItems) listDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_rps", "Aucun pack de textures installé.")}</div>`;
    };

    window.toggleResourcePack = (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "resourcepacks");
        fs.renameSync(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderResourcePacksManager();
    };

    window.addServer = () => {
        const ip = document.getElementById("new-server-ip").value.trim();
        if (!ip) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst.servers) inst.servers = [];
        if (!inst.servers.includes(ip)) {
            inst.servers.push(ip);
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
        }
        document.getElementById("new-server-ip").value = "";
        window.renderServersManager();
    };

    window.removeServer = (index) => {
        store.allInstances[store.selectedInstanceIdx].servers.splice(index, 1);
        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
        window.renderServersManager();
    };

    window.setAutoConnect = (ip) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.autoConnect === ip) {
            inst.autoConnect = null; 
        } else {
            inst.autoConnect = ip;
        }
        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
        window.renderServersManager();
    };

    window.renderServersManager = () => {
        const list = document.getElementById("server-list");
        list.innerHTML = "";
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst.servers || inst.servers.length === 0) {
            list.innerHTML = `<div style='text-align:center; color:#888; padding: 15px;'>${t("msg_no_servers", "Aucun serveur.")}</div>`;
            return;
        }

inst.servers.forEach((ip, i) => {
            const isAuto = inst.autoConnect === ip;
            const safeIp = window.escapeHTML(ip); 
            
            list.innerHTML += `
            <div style="background: rgba(0,0,0,0.2); border: 1px solid ${isAuto ? 'var(--accent)' : 'var(--border)'}; border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-weight: bold; color: var(--text-light);">${safeIp}</span>
                    <div id="srv-ping-${i}" style="font-size: 0.75rem; color: #aaa;">- ${t("msg_ping", "Ping...")}</div>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn-secondary" style="color: ${isAuto ? 'var(--accent)' : '#aaa'}; border-color: ${isAuto ? 'var(--accent)' : 'var(--border)'}; padding: 4px 8px; font-size: 0.75rem;" onclick="setAutoConnect('${ip.replace(/'/g, "\\'")}')" title="Quick-Connect">>> ${t("btn_auto_connect", "Auto")}</button>
                    <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;" onclick="removeServer(${i})">${t("btn_delete", "Supprimer")}</button>
                </div>
            </div>`;
        });

        window.pingServers();
    };

    window.pingServers = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst || !inst.servers) return;
        for (let i = 0; i < inst.servers.length; i++) {
            const ip = inst.servers[i];
            const statusDiv = document.getElementById(`srv-ping-${i}`);
            if (!statusDiv) continue;
            try {
                const res = await fetch(`https://api.mcsrvstat.us/3/${ip}`);
                const data = await res.json();
                const formatNum = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n;
                if (data.online)
                    statusDiv.innerHTML = `<span style="color:#17B139; font-weight:bold;">[+] ${t("msg_online", "En ligne")}</span> <span style="color:#aaa;">- ${formatNum(data.players.online)}/${formatNum(data.players.max)}</span>`;
                else
                    statusDiv.innerHTML = `<span style="color:#f87171; font-weight:bold;">[x] ${t("msg_offline", "Hors-ligne")}</span>`;
            } catch (e) {
                statusDiv.innerHTML = `<span style="color:#f87171;">[x] ${t("msg_err_ping", "Erreur")}</span>`;
            }
        }
    };

    let pendingUpdates = [];

    window.checkModUpdates = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        if (!fs.existsSync(modsPath)) return;
        
        const files = fs.readdirSync(modsPath).filter((f) => f.endsWith(".jar"));
        if (files.length === 0) {
            window.showToast(t("msg_no_mods", "Aucun mod local installé."), "info");
            return;
        }

        let hashes = {};
        for (let f of files) {
            const hash = window.api.tools.hashFile(path.join(modsPath, f), "sha1");
            hashes[hash] = f;
        }
        
        const loader = inst.loader === "forge" ? "forge" : "fabric";
        const reqBody = {
            hashes: Object.keys(hashes),
            algorithm: "sha1",
            loaders: [loader],
            game_versions: [inst.version],
        };

        window.showLoading(t("msg_check_updates", "Vérification des mises à jour..."));
        
        if (typeof yieldUI !== "undefined") await yieldUI(); 
        
        try {
            const res = await fetch("https://api.modrinth.com/v2/version_files/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reqBody),
            });
            const data = await res.json();
            
            pendingUpdates = [];
            let listHTML = "";

            for (let oldHash in data) {
                const newFileObj = data[oldHash].files.find((f) => f.primary) || data[oldHash].files[0];
                if (newFileObj.filename !== hashes[oldHash]) {
                    pendingUpdates.push({
                        oldFile: hashes[oldHash],
                        newFileObj: newFileObj
                    });
                    listHTML += `<div style="margin-bottom: 5px;">- <span style="color:#f87171; text-decoration:line-through;">${hashes[oldHash]}</span> -> <span style="color:#17B139;">${newFileObj.filename}</span></div>`;
                }
            }
            window.hideLoading();
            
            if (pendingUpdates.length > 0) {
                document.getElementById("updates-list").innerHTML = listHTML;
                document.getElementById("modal-updates").style.display = "flex";
                
                document.getElementById("btn-confirm-updates").onclick = async () => {
                    document.getElementById("modal-updates").style.display = "none";
                    await executeModUpdates();
                };
            } else {
                window.showToast(t("msg_no_updates", "Aucune mise à jour trouvée."), 'info');
            }
        } catch (e) {
            window.hideLoading();
            window.showToast(t("msg_err_dl", "Erreur."), "error");
        }
    };

    async function executeModUpdates() {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        
        let updatedCount = 0;
        const total = pendingUpdates.length;

        window.showLoading(`${t("msg_updating", "Mise à jour...")}`, 0);

        for (let update of pendingUpdates) {
            window.updateLoadingPercent(Math.round((updatedCount / total) * 100), `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`);
            if (typeof yieldUI !== "undefined") await yieldUI();
            
            try {
                const buffer = await (await fetch(update.newFileObj.url)).arrayBuffer();
                fs.writeFileSync(path.join(modsPath, update.newFileObj.filename), Buffer.from(buffer));
                fs.unlinkSync(path.join(modsPath, update.oldFile));
                updatedCount++;
            } catch(e) {}
        }
        
        window.hideLoading();
        window.showToast(`${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`, 'success');
        window.renderModsManager();
    }
}