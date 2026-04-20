import { store } from "./store.js";
import { yieldUI, sysLog } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupLocalManagers() {
    function safeAttrJson(value) {
        return JSON.stringify(value).replace(/'/g, "&#39;");
    }
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
                const cleanId = reqId.toLowerCase();
                if (!provided.has(cleanId) && 
                    !cleanId.startsWith("fabric-") && 
                    !cleanId.startsWith("quilt_") && 
                    !cleanId.startsWith("forge:") && 
                    cleanId !== "commonnetworking" &&
                    cleanId !== "architectury" &&
                    cleanId !== "midnightlib" 
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
        modsListDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_loading", "Chargement...")}</div>`;
        
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
        
        const files = await fs.promises.readdir(modsPath);
        const warnings = getModWarnings(inst);
        
        let hasMods = false;
        let htmlBuilder = ""; 
        
        for (const file of files) {
            if (file.endsWith(".jar") || file.endsWith(".jar.disabled")) {
                hasMods = true;
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".jar.disabled", ".jar"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);

                let warningHtml = "";
                if (warnings[file]) {
                    const safeTooltip = window.escapeHTML(t("msg_warn_deps", "Dépendance manquante potentielle : ") + warnings[file].join(', '));
                    warningHtml = `<span class="custom-tooltip-trigger" data-tooltip="${safeTooltip}" style="margin-left:6px; color:#f87171; font-size:0.9rem; font-weight:bold;">${t("lbl_warning", "[!]")}</span>`;
                }
                
                htmlBuilder += `
                <div class="mod-item">
                    <span style="color: ${color}; text-decoration: ${decoration}; display:flex; align-items:center; flex-grow: 1; word-break: break-all; padding-right: 10px;">${displayName}${warningHtml}</span>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange='toggleMod(${fileJson}, this.checked)' title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 2px 6px; font-size: 0.7rem;" onclick='deleteMod(${fileJson})' title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
            }
        }
        
        if (hasMods) {
            modsListDiv.innerHTML = htmlBuilder;
        } else {
            modsListDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_mods", "Aucun mod local installé.")}</div>`;
        }
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
      if (await window.showCustomConfirm(t("msg_delete_confirm", "Voulez-vous vraiment supprimer ce fichier ?") + "\n(" + filename + ")", true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
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
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);
                
                listDiv.innerHTML += `
                <div class="mod-item">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange='toggleShader(${fileJson}, this.checked)' title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" onclick='deleteShader(${fileJson})' title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
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

    window.deleteShader = async (filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce shader ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "shaderpacks", filename);
            try {
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                    window.showToast(t("msg_shader_deleted", "Shader supprimé !"), "success");
                    window.renderShadersManager();
                }
            } catch(e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
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
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);
                
                listDiv.innerHTML += `
                <div class="mod-item">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange='toggleResourcePack(${fileJson}, this.checked)' title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" onclick='deleteResourcePack(${fileJson})' title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
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

    window.deleteResourcePack = async (filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce pack ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const targetPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "resourcepacks", filename);
            try {
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                    window.showToast(t("msg_rp_deleted", "Pack supprimé !"), "success");
                    window.renderResourcePacksManager();
                }
            } catch(e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
    };

    async function syncServersDat(inst) {
        try {
            const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
            if (!fs.existsSync(instDir)) return;
            const datPath = path.join(instDir, "servers.dat");

            const serverEntries = (inst.servers || []).map(ip => ({
                name: { type: "string", value: ip },
                ip:   { type: "string", value: ip }
            }));

            const nbtRoot = {
                type: "compound",
                name: "",
                value: {
                    servers: {
                        type: "list",
                        value: {
                            type: serverEntries.length > 0 ? "compound" : "end",
                            value: serverEntries
                        }
                    }
                }
            };

            fs.writeFileSync(datPath, window.api.nbt.write(nbtRoot));
        } catch(e) {
            sysLog("Erreur sync servers.dat : " + (e.message || e), true);
        }
    }

    window.addServer = async () => {
        const ip = document.getElementById("new-server-ip").value.trim();
        if (!ip) return;

        const serverValid = /^[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(ip);
        if (!serverValid) {
            window.showToast(t("msg_err_server_invalid", "Adresse de serveur invalide."), "error");
            return;
        }
        const portMatch = ip.match(/:(\d+)$/);
        if (portMatch) {
            const port = parseInt(portMatch[1], 10);
            if (port < 1 || port > 65535) {
                window.showToast(t("msg_err_server_invalid", "Port invalide (1-65535)."), "error");
                return;
            }
        }

        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst.servers) inst.servers = [];
        if (!inst.servers.includes(ip)) {
            inst.servers.push(ip);
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            await syncServersDat(inst);
        }
        document.getElementById("new-server-ip").value = "";
        window.renderServersManager();
    };

    window.removeServer = async (index) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        inst.servers.splice(index, 1);
        window.safeWriteJSON(store.instanceFile, store.allInstances);
        await syncServersDat(inst);
        window.renderServersManager();
    };

    window.setAutoConnect = (ip) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.autoConnect === ip) {
            inst.autoConnect = null; 
        } else {
            inst.autoConnect = ip;
        }
        window.safeWriteJSON(store.instanceFile, store.allInstances);
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

        const minorVer = parseInt(inst.version.split('.')[1]) || 0;
        const canAutoConnect = minorVer >= 20;

        inst.servers.forEach((ip, i) => {
            const isAuto = inst.autoConnect === ip;
            const safeIp = window.escapeHTML(ip);
            
            let autoBtnHtml = "";
            if (canAutoConnect) {
                autoBtnHtml = `<button class="btn-secondary btn-auto-connect" data-ip="${safeIp}" style="color: ${isAuto ? 'var(--accent)' : '#aaa'}; border-color: ${isAuto ? 'var(--accent)' : 'var(--border)'}; padding: 4px 8px; font-size: 0.75rem;" title="${t("lbl_quick_connect", "Connexion automatique au lancement")}">&gt;&gt; ${t("btn_auto_connect", "Auto")}</button>`;
            } else {
                autoBtnHtml = `<span style="font-size: 0.65rem; color: #666; margin-right: 5px; align-self: center;" title="${t("msg_req_mc_120", "Nécessite Minecraft 1.20+")}">Auto 1.20+</span>`;
            }

            list.innerHTML += `
            <div style="background: rgba(0,0,0,0.2); border: 1px solid ${isAuto ? 'var(--accent)' : 'var(--border)'}; border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-weight: bold; color: var(--text-light);">${safeIp}</span>
                    <div id="srv-ping-${i}" style="font-size: 0.75rem; color: #aaa;">- ${t("msg_ping", "Ping...")}</div>
                </div>
                <div style="display: flex; gap: 5px;">
                    ${autoBtnHtml}
                    <button class="btn-secondary btn-remove-server" data-index="${i}" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;">${t("btn_delete", "Supprimer")}</button>
                </div>
            </div>`;
        });

        list.querySelectorAll(".btn-auto-connect").forEach(btn => {
            btn.addEventListener("click", () => window.setAutoConnect(btn.dataset.ip));
        });
        list.querySelectorAll(".btn-remove-server").forEach(btn => {
            btn.addEventListener("click", () => window.removeServer(parseInt(btn.dataset.index)));
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
                const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(ip)}`);
                const data = await res.json();
                const formatNum = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n;
                if (data.online)
                    statusDiv.innerHTML = `<span style="color:#17B139; font-weight:bold;">[+] ${t("msg_online", "En ligne")}</span> <span style="color:#aaa;">- ${formatNum(data.players?.online ?? 0)}/${formatNum(data.players?.max ?? 0)}</span>`;
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
        await yieldUI();

        const checkController = new AbortController();
        const checkTimeout = setTimeout(() => checkController.abort(), 30000);

        try {
            const res = await fetch("https://api.modrinth.com/v2/version_files/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reqBody),
                signal: checkController.signal,
            });
            clearTimeout(checkTimeout);            
            
            if (!res.ok) {
                window.hideLoading();
                if (res.status === 404) {
                    window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
                } else {
                    window.showToast(t("msg_err_dl", "Erreur lors de la vérification."), "error");
                }
                return;
            }

            const data = await res.json();
            
            pendingUpdates = [];
            let listHTML = "";

            if (typeof data === "object" && !Array.isArray(data)) {
                for (let oldHash in data) {
                    if (data[oldHash] && Array.isArray(data[oldHash].files)) {
                        const newFileObj = data[oldHash].files.find((f) => f.primary) || data[oldHash].files[0];
                        if (newFileObj && newFileObj.filename !== hashes[oldHash]) {
                            pendingUpdates.push({
                                oldFile: hashes[oldHash],
                                newFileObj: newFileObj
                            });
                            listHTML += `<div style="margin-bottom: 5px;">- <span style="color:#f87171; text-decoration:line-through;">${window.escapeHTML(hashes[oldHash])}</span> -> <span style="color:#17B139;">${window.escapeHTML(newFileObj.filename)}</span></div>`;
                        }
                    }
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
                window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
            }
        } catch (e) {
            clearTimeout(checkTimeout);
            window.hideLoading();
            if (e.name === "AbortError") {
                window.showToast(t("msg_err_timeout", "Délai dépassé. Vérifiez votre connexion."), "error");
            } else {
                window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
            }
        }
    };

    async function executeModUpdates() {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        
        let updatedCount = 0;
        const total = pendingUpdates.length;

        window.showLoading(`${t("msg_updating", "Mise à jour...")}`, 0);

        for (let update of pendingUpdates) {
            window.updateLoadingPercent(
                Math.round((updatedCount / total) * 100),
                `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
            );
            await yieldUI();

            try {
                const newPath = path.join(modsPath, update.newFileObj.filename);
                const oldPath = path.join(modsPath, update.oldFile);

                const dlController = new AbortController();
                const dlTimeout = setTimeout(() => dlController.abort(), 60000);
                let buffer;
                try {
                    const dlRes = await fetch(update.newFileObj.url, { signal: dlController.signal });
                    buffer = await dlRes.arrayBuffer();
                } finally {
                    clearTimeout(dlTimeout);
                }

                const fileBytes = new Uint8Array(buffer);

                if (update.newFileObj.hashes?.sha1) {
                    const dlHash = window.api.tools.hashBuffer(fileBytes, "sha1");
                    if (dlHash !== update.newFileObj.hashes.sha1) {
                        sysLog(`SÉCURITÉ : hash SHA1 invalide pour la mise à jour ${update.newFileObj.filename} (attendu: ${update.newFileObj.hashes.sha1}, reçu: ${dlHash})`, true);
                        window.showToast(t("msg_err_hash", "Fichier corrompu ou modifié !") + ` : ${update.newFileObj.filename}`, "error");
                        continue;
                    }
                }

                const tmpPath = newPath + ".tmp";
                fs.writeFileSync(tmpPath, fileBytes);
                fs.renameSync(tmpPath, newPath);

                if (oldPath !== newPath && fs.existsSync(oldPath)) {
                    fs.unlinkSync(oldPath);
                }
                updatedCount++;

                window.updateLoadingPercent(
                    Math.round((updatedCount / total) * 100),
                    `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
                );
            } catch(e) {
                sysLog("Erreur mise à jour mod " + update.oldFile + " : " + e.message, true);
            }
        }
        
        window.hideLoading();
        window.showToast(`${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`, 'success');
        window.renderModsManager();
    }
}