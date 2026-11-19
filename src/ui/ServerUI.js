// @ts-check

import { store } from "../store.js";

export function setupServer() {
    let _isCheckingServer = false;
    window.checkServerStatus = async () => {
        if (_isCheckingServer) return;
        
        const gs = /** @type {{serverIp?: string; offlineMode?: boolean}} */ (store.globalSettings);
        const ip = gs.serverIp ? gs.serverIp.trim() : "";
        const banner = document.getElementById("server-banner-container");
        if (!banner) return;
        if (!ip || gs.offlineMode || !window.isTrulyOnline) {
            banner.style.display = "none";
            return;
        }
        
        _isCheckingServer = true;
        banner.style.display = "flex";
        if (banner.innerHTML === "") {
            banner.innerHTML = `<div class="u-s292">${window.t("msg_server_search", "Recherche du serveur")} ${window.escapeHTML(ip)}...</div>`;
        }
        try {
            const res = /** @type {{success?: boolean; error?: string; data?: any}} */ (await window.api.invoke("ping-server", ip));
            if (!res.success) throw new Error(`ping HTTP ${res.error}`);
            const data = res.data;
            if (data.online) {
                const safeIcon = (data.icon && (/^https:\/\//i.test(data.icon) || /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)(?:;|,)/i.test(data.icon))) ? data.icon : "";
                let iconHtml = safeIcon ? `<img src="${window.escapeHTML(safeIcon)}" class="u-s293">` : `<div class="u-s294"></div>`;
                let motdNode = null;
                if (data.motd && data.motd.html) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(data.motd.html, 'text/html');
                    const clean = document.createDocumentFragment();
                    const SAFE_MC_CLASS = /^mc-(?:c-[a-z_]{3,16}|bold|italic|underlined|strikethrough)$/;
                    const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
                    /**
                     * @param {Node} src
                     * @param {Node} dest
                     */
                    function processNode(src, dest) {
                        for (const child of Array.from(src.childNodes)) {
                            if (child.nodeType === Node.TEXT_NODE) {
                                dest.appendChild(document.createTextNode(child.textContent || ""));
                            } else if (child.nodeType === Node.ELEMENT_NODE) {
                                const el = /** @type {HTMLElement} */ (child);
                                if (el.tagName === 'BR') {
                                    dest.appendChild(document.createElement('br'));
                                } else if (el.tagName === 'SPAN') {
                                    const span = document.createElement('span');
                                    for (const cls of Array.from(el.classList)) {
                                        if (SAFE_MC_CLASS.test(cls)) span.classList.add(cls);
                                    }
                                    const rgb = el.getAttribute('data-mc-rgb') || '';
                                    if (HEX_COLOR_RE.test(rgb)) {
                                        span.style.color = rgb;
                                    }
                                    processNode(el, span);
                                    dest.appendChild(span);
                                } else {
                                    processNode(el, dest);
                                }
                            }
                        }
                    }
                    processNode(doc.body, clean);
                    motdNode = clean;
                }
                const safePlayerCount = (/** @type {unknown} */ v) => {
                    const n = Number(v);
                    return Number.isFinite(n) && n >= 0 ? String(Math.trunc(n)) : "?";
                };
                banner.innerHTML = `
                ${iconHtml}
                <div class="server-banner-info">
                    <div class="server-banner-ip">${window.escapeHTML(ip)}</div>
                    <div class="server-banner-motd"></div>
                </div>
                <div class="server-banner-status">
                    <div class="server-banner-online">[+] ${window.et("msg_online", "En ligne")}</div>
                    <div class="server-banner-players">${safePlayerCount(data.players?.online)} / ${safePlayerCount(data.players?.max)} ${window.et("lbl_players", "joueurs")}</div>
                </div>`;
                const motdBox = banner.querySelector('.server-banner-motd');
                if (motdBox) {
                    if (motdNode) motdBox.replaceChildren(motdNode);
                    else motdBox.textContent = "Serveur Minecraft";
                }
            } else {
                banner.innerHTML = `
                <div class="u-s295">[X]</div>
                <div class="u-s296">
                    <div class="u-s297">${window.escapeHTML(ip)}</div>
                    <div class="u-s298">${window.t("msg_server_offline_desc", "Le serveur est actuellement hors-ligne.")}</div>
                </div>`;
            }
        } catch (e) {
            banner.innerHTML = `<div class="u-s299">${window.t("msg_server_error", "Erreur de connexion à")} ${window.escapeHTML(ip)}</div>`;
        } finally {
            _isCheckingServer = false;
        }
    };
}
