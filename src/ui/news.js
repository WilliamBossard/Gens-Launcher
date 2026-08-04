import { store } from "../store.js";

export let _newsLoaded = false;

export function setupNews() {
    window.loadNews = async function() {
        if (_newsLoaded) return;
        if (store.globalSettings.offlineMode || !navigator.onLine) return;
        try {
            const newsController = new AbortController();
            const newsTimeout = setTimeout(() => newsController.abort(new Error("Timeout")), 5000);
            const res = await fetch("https://launchercontent.mojang.com/v2/news.json", { signal: newsController.signal });
            clearTimeout(newsTimeout);
            if (!res.ok) throw new Error(`News HTTP ${res.status}`);
            const data = await res.json();
            const container = document.getElementById("news-container");
            if (!data || !Array.isArray(data.entries)) return;
            container.style.display = "block";
            const isCollapsed = store.globalSettings.newsCollapsed;
            const toggleText = isCollapsed ? (store.currentLangObj?.btn_show || "Afficher") : (store.currentLangObj?.btn_hide || "Masquer");
            let html = `
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
                <div style="font-weight: bold; color: var(--text-light);">${window.t("lbl_news", "Actualités Minecraft")}</div>
                <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" id="btn-toggle-news">${toggleText}</button>
            </div>
            <div id="news-content-wrapper" style="display: ${isCollapsed ? 'none' : 'block'};">`;
            
            data.entries.slice(0, 6).forEach(news => {
                const rawImgUrl = news.playPageImage?.url || "";
                const imgUrl = rawImgUrl.startsWith("/") ? `https://launchercontent.mojang.com${rawImgUrl}` : rawImgUrl;
                const link = news.readMoreLink.startsWith("http") ? news.readMoreLink : `https://minecraft.net${news.readMoreLink}`;
                const safeTitle = window.escapeHTML(news.title);
                const safeCategory = window.escapeHTML(news.category);
                const safeLink = window.escapeHTML(link);
                const safeImgUrl = window.escapeHTML(imgUrl);
                html += `
                <div class="news-card" data-link="${safeLink}">
                    <img src="${safeImgUrl}" class="news-img">
                    <div class="news-content">
                        <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                        <div style="font-size: 0.7rem; color: var(--accent);">${safeCategory}</div>
                    </div>
                </div>`;
            });
            html += `</div>`;
            container.innerHTML = html;
            // Délégation d'événements post-injection
            container.querySelector('#btn-toggle-news')?.addEventListener('click', () => toggleNews());
            container.querySelectorAll('.news-card[data-link]').forEach(card => {
                card.addEventListener('click', () => window.api.shell.openExternal(card.dataset.link));
            });
            _newsLoaded = true;
        } catch(e) {
            if (e.name === 'AbortError' || e.message === 'Timeout' || e.message.includes('aborted')) {
                console.warn("[News] Mojang API unreachable or timed out.");
            } else {
                console.warn("[News] loadNews failed:", e.message);
            }
        }
    };

    window.toggleNews = () => {
        store.globalSettings.newsCollapsed = !store.globalSettings.newsCollapsed;
        window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        const wrapper = document.getElementById("news-content-wrapper");
        const btn = document.getElementById("btn-toggle-news");
        if (store.globalSettings.newsCollapsed) {
            if (wrapper) wrapper.style.display = "none";
            if (btn) btn.innerText = store.currentLangObj?.btn_show || "Afficher";
        } else {
            if (wrapper) wrapper.style.display = "block";
            if (btn) btn.innerText = store.currentLangObj?.btn_hide || "Masquer";
        }
    };
}
