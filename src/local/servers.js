import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    async function syncServersDat(inst) {
        try {
            const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
            if (!(await window.existsSafe(instDir))) return;
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
            const tmpPath = datPath + ".tmp";
            await fs.promises.writeFile(tmpPath, window.api.nbt.write(nbtRoot));
            await fs.promises.rename(tmpPath, datPath);
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
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            await syncServersDat(inst);
        }
        document.getElementById("new-server-ip").value = "";
        await window.renderServersManager();
    };
    window.removeServer = async (index) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        inst.servers.splice(index, 1);
        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        await syncServersDat(inst);
        await window.renderServersManager();
    };
    window.setAutoConnect = async (ip) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.autoConnect === ip) {
            inst.autoConnect = null; 
        } else {
            inst.autoConnect = ip;
        }
        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        await window.renderServersManager();
    };
    /**
     * Lit servers.dat de l'instance et merge les IPs dedans dans inst.servers.
     * Ne supprime jamais une IP déjà présente dans inst.servers (priorité au store).
     * Retourne true si des nouveaux serveurs ont été trouvés.
     */
    async function syncServersDatToStore(inst) {
        try {
            const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
            const datPath = path.join(instDir, "servers.dat");
            if (!(await window.existsSafe(datPath))) return false;
            const buffer = await fs.promises.readFile(datPath);
            const { parsed } = await window.api.nbt.parse(buffer);
            const entries = parsed?.value?.servers?.value?.value || [];
            if (!Array.isArray(entries) || entries.length === 0) return false;
            if (!inst.servers) inst.servers = [];
            let changed = false;
            for (const entry of entries) {
                const ip = entry?.ip?.value || entry?.host?.value || "";
                if (ip && !inst.servers.includes(ip)) {
                    inst.servers.push(ip);
                    changed = true;
                }
            }
            if (changed) {
                window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                sysLog(`syncServersDatToStore : ${inst.name} — ${entries.length} serveur(s) importé(s) depuis servers.dat`);
            }
            return changed;
        } catch (e) {
            sysLog("syncServersDatToStore erreur : " + (e.message || e), true);
            return false;
        }
    }
    window.renderServersManager = async () => {
        const list = document.getElementById("server-list");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        list.innerHTML = `<div style='text-align:center; color:#888; padding:15px;'>${t("msg_loading", "Chargement...")}</div>`;
        await syncServersDatToStore(inst);
        if (!inst.servers || inst.servers.length === 0) {
            list.innerHTML = `<div style='text-align:center; color:#888; padding: 15px;'>${t("msg_no_servers", "Aucun serveur.")}</div>`;
            return;
        }
        const minorVer = parseInt(inst.version.split('.')[1]) || 0;
        const canAutoConnect = minorVer >= 20;
        let srvHtml = "";
        inst.servers.forEach((ip, i) => {
            const isAuto = inst.autoConnect === ip;
            const safeIp = window.escapeHTML(ip);
            let autoBtnHtml = "";
            if (canAutoConnect) {
                autoBtnHtml = `<button class="btn-secondary btn-auto-connect" data-ip="${safeIp}" style="color: ${isAuto ? 'var(--accent)' : '#aaa'}; border-color: ${isAuto ? 'var(--accent)' : 'var(--border)'}; padding: 4px 8px; font-size: 0.75rem;" title="${t("lbl_quick_connect", "Connexion automatique au lancement")}">&gt;&gt; ${t("btn_auto_connect", "Auto")}</button>`;
            } else {
                autoBtnHtml = `<span style="font-size: 0.65rem; color: #666; margin-right: 5px; align-self: center;" title="${t("msg_req_mc_120", "Nécessite Minecraft 1.20+")}">Auto 1.20+</span>`;
            }
            srvHtml += `
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
        list.innerHTML = srvHtml;
        list.querySelectorAll(".btn-auto-connect").forEach(btn => {
            btn.addEventListener("click", () => window.setAutoConnect(btn.dataset.ip));
        });
        list.querySelectorAll(".btn-remove-server").forEach(btn => {
            btn.addEventListener("click", () => window.removeServer(parseInt(btn.dataset.index)));
        });
        window.pingServers();
    };
    let _pingAbortController = null;
    window.pingServers = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst || !inst.servers || inst.servers.length === 0) return;
        if (_pingAbortController) _pingAbortController.abort();
        _pingAbortController = new AbortController();
        const signal = _pingAbortController.signal;
        const instName = inst.name;
        const servers  = [...inst.servers];

        const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
        if (isOffline) {
            for (let i = 0; i < servers.length; i++) {
                const statusDiv = document.getElementById(`srv-ping-${i}`);
                if (statusDiv) statusDiv.innerHTML = `<span style="color:#f87171; font-weight:bold;">[x] ${t("msg_offline", "Hors-ligne")}</span>`;
            }
            return;
        }
        const pingOne = async (ip, i) => {
            const statusDiv = document.getElementById(`srv-ping-${i}`);
            if (!statusDiv || signal.aborted) return;
            try {
                const res = await window.api.invoke("ping-server", ip);
                if (signal.aborted) return;
                const currentInst = store.allInstances[store.selectedInstanceIdx];
                if (!currentInst || currentInst.name !== instName) return;
                const freshDiv = document.getElementById(`srv-ping-${i}`);
                if (!freshDiv) return;
                if (!res.success) throw new Error(res.error);
                const data = res.data;
                const formatNum = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n;
                if (data.online)
                    freshDiv.innerHTML = `<span style="color:#17B139; font-weight:bold;">[+] ${t("msg_online", "En ligne")}</span> <span style="color:#aaa;">- ${formatNum(data.players?.online ?? 0)}/${formatNum(data.players?.max ?? 0)}</span>`;
                else
                    freshDiv.innerHTML = `<span style="color:#f87171; font-weight:bold;">[x] ${t("msg_offline", "Hors-ligne")}</span>`;
            } catch (e) {
                if (signal.aborted || e.name === "AbortError") return;
                const freshDiv = document.getElementById(`srv-ping-${i}`);
                if (freshDiv) freshDiv.innerHTML = `<span style="color:#f87171;">[x] ${t("msg_err_ping", "Erreur")}</span>`;
            }
        };
const timeoutId = setTimeout(() => _pingAbortController?.abort(), 8000);
        for (let i = 0; i < servers.length; i++) {
            if (signal.aborted) break;
            pingOne(servers[i], i);
            await new Promise(r => setTimeout(r, 200)); 
        }
        clearTimeout(timeoutId);
    };
}
