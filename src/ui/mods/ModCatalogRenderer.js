// @ts-check
import { renderProgressiveList } from "../components/VirtualList.js";

const t = (/** @type {string} */ k, fallback = "") => window.t ? window.t(k, fallback) : (fallback || k);

/**
 * Crée une carte de mod CurseForge pour le constructeur de modpack.
 * @param {any} mod
 * @param {Array<{ id: string }>} builderSelectedMods
 * @returns {HTMLElement | null}
 */
export function createCurseForgeBuilderCard(mod, builderSelectedMods) {
    if (!mod || !mod.id) return null;
    const safeId = window.escapeHTML(mod.id.toString());
    const safeTitle = window.escapeHTML(mod.name);
    const safeDesc = window.escapeHTML(mod.summary || "");
    const safeAuthor = window.escapeHTML(mod.authors && mod.authors[0] ? mod.authors[0].name : "");
    const downloads = mod.downloadCount >= 1000000
        ? (mod.downloadCount / 1000000).toFixed(1) + "M DLs"
        : (mod.downloadCount >= 1000 ? (mod.downloadCount / 1000).toFixed(0) + "k DLs" : mod.downloadCount + " DLs");
    const isAdded = builderSelectedMods.some(m => m.id === safeId);
    const btnHtml = isAdded
        ? `<button class="btn-secondary u-s273" disabled>${t("btn_added", "Ajouté")}</button>`
        : `<button class="btn-primary builder-add-btn u-s274">${t("btn_add_to_pack", "Ajouter")}</button>`;
    const rawThumb = (mod.logo && mod.logo.thumbnailUrl) ? String(mod.logo.thumbnailUrl) : "";
    const iconUrl = /^https:\/\//i.test(rawThumb) ? window.escapeHTML(rawThumb) : "";
    const iconHtml = iconUrl
        ? `<img src="${iconUrl}" alt="" loading="lazy" class="u-s276">`
        : `<div class="u-s277"></div>`;

    const card = document.createElement("div");
    card.className = "catalog-card catalog-card-builder";
    card.innerHTML = `
        ${iconHtml}
        <div class="u-s278">
            <div class="u-s279">${safeTitle}</div>
            <div class="u-s283">${safeAuthor} — ${downloads} (CurseForge)</div>
            <div class="u-s281">${safeDesc}</div>
            <div class="btn-container u-s282" data-mod-id="${safeId}">${btnHtml}</div>
        </div>`;
    return card;
}

/**
 * Rend une liste de résultats dans le catalogue avec virtualisation progressive.
 * @template T
 * @param {HTMLElement} container
 * @param {T[]} items
 * @param {(item: T, index: number) => HTMLElement | null} renderFn
 * @param {(root: HTMLElement) => void} [onBatchAppended]
 */
export function renderCatalogProgressive(container, items, renderFn, onBatchAppended) {
    return renderProgressiveList(container, items, renderFn, { batchSize: 40, onBatchAppended });
}
