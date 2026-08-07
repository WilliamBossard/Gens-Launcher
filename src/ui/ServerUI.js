import { store } from "../store.js";

export function setupServer() {
    window.checkServerStatus = async () => {
        const ip = store.globalSettings.serverIp ? store.globalSettings.serverIp.trim() : "";
        const banner = document.getElementById("server-banner-container");
        if (!ip || store.globalSettings.offlineMode || !navigator.onLine) {
            banner.style.display = "none";
            return;
        }
        banner.style.display = "flex";
        if (banner.innerHTML === "") {
            banner.innerHTML = `<div style="text-align:center; width:100%; color:#aaa;">${window.t("msg_server_search", "Recherche du serveur")} ${window.escapeHTML(ip)}...</div>`;
        }
        try {
            const res = await window.api.invoke("ping-server", ip);
            if (!res.success) throw new Error(`ping HTTP ${res.error}`);
            const data = res.data;
            if (data.online) {
                const safeIcon = (data.icon && (/^https:\/\//i.test(data.icon) || /^data:image\//i.test(data.icon))) ? data.icon : "";
                let iconHtml = safeIcon ? `<img src="${window.escapeHTML(safeIcon)}" style="width: 64px; height: 64px; border-radius: 4px; margin-right: 15px; image-rendering: pixelated;">` : `<div style="width: 64px; height: 64px; background: rgba(255,255,255,0.1); border-radius: 4px; margin-right: 15px;"></div>`;
                let motdHtml = "Serveur Minecraft";
                if (data.motd && data.motd.html) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(data.motd.html, 'text/html');
                    const clean = document.createElement('div');
                    function processNode(src, dest) {
                        for (const child of src.childNodes) {
                            if (child.nodeType === Node.TEXT_NODE) {
                                dest.appendChild(document.createTextNode(child.textContent));
                            } else if (child.nodeType === Node.ELEMENT_NODE) {
                                if (child.tagName === 'BR') {
                                    dest.appendChild(document.createElement('br'));
                                } else if (child.tagName === 'SPAN') {
                                    const span = document.createElement('span');
                                    const rawStyle = child.getAttribute('style') || '';
                                    const safeStyle = rawStyle.replace(/[^a-zA-Z0-9:#\-\s;]/g, '');
                                    if (safeStyle) span.setAttribute('style', safeStyle);
                                    processNode(child, span);
                                    dest.appendChild(span);
                                } else {
                                    processNode(child, dest);
                                }
                            }
                        }
                    }
                    processNode(doc.body, clean);
                    motdHtml = clean.innerHTML;
                }
                banner.innerHTML = `
                ${iconHtml}
                <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                    <div style="font-size: 0.85rem; color: #aaa; font-family: 'Consolas', monospace; background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; line-height: 1.2;">${motdHtml}</div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; justify-content: center; min-width: 100px;">
                    <div style="color: #17B139; font-weight: bold; font-size: 1.2rem;">[+] ${window.t("msg_online", "En ligne")}</div>
                    <div style="color: var(--text-light);">${data.players?.online ?? "?"} / ${data.players?.max ?? "?"} ${window.t("lbl_players", "joueurs")}</div>
                </div>`;
            } else {
                banner.innerHTML = `
                <div style="width: 64px; height: 64px; background: #333; border-radius: 4px; margin-right: 15px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold;">[X]</div>
                <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                    <div style="font-size: 0.85rem; color: #f87171;">${window.t("msg_server_offline_desc", "Le serveur est actuellement hors-ligne.")}</div>
                </div>`;
            }
        } catch (e) {
            banner.innerHTML = `<div style="color:#f87171; padding: 10px; width:100%; text-align:center;">${window.t("msg_server_error", "Erreur de connexion à")} ${window.escapeHTML(ip)}</div>`;
        }
    };
}
