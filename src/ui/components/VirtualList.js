// @ts-check

/**
 * Rend une grande liste d'éléments de manière progressive (fenêtrage par lots + IntersectionObserver)
 * afin d'éviter le gel du thread UI sur des catalogues ou listes de 100+ éléments.
 *
 * @template T
 * @param {HTMLElement} container
 * @param {T[]} items
 * @param {(item: T, index: number) => HTMLElement | null} renderItem
 * @param {{ batchSize?: number; onBatchAppended?: (root: HTMLElement) => void }} [options]
 * @returns {() => void} Fonction d'annulation/nettoyage
 */
export function renderProgressiveList(container, items, renderItem, options = {}) {
    const batchSize = Math.max(10, options.batchSize || 40);
    container.innerHTML = "";
    if (!Array.isArray(items) || items.length === 0) {
        return () => {};
    }

    let cursor = 0;
    let cancelled = false;
    /** @type {IntersectionObserver | null} */
    let observer = null;
    const sentinel = document.createElement("div");
    sentinel.className = "virtual-list-sentinel";
    sentinel.style.height = "1px";

    const appendNextBatch = () => {
        if (cancelled || cursor >= items.length) return;
        const end = Math.min(cursor + batchSize, items.length);
        const fragment = document.createDocumentFragment();
        for (let i = cursor; i < end; i++) {
            const el = renderItem(items[i], i);
            if (el) fragment.appendChild(el);
        }
        cursor = end;
        if (sentinel.parentNode === container) {
            container.insertBefore(fragment, sentinel);
        } else {
            container.appendChild(fragment);
        }
        if (options.onBatchAppended) {
            options.onBatchAppended(container);
        }
        if (cursor >= items.length) {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            if (sentinel.parentNode === container) {
                container.removeChild(sentinel);
            }
        }
    };

    appendNextBatch();
    if (cursor < items.length) {
        container.appendChild(sentinel);
        if (typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver((entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    appendNextBatch();
                }
            }, { rootMargin: "250px" });
            observer.observe(sentinel);
        } else {
            // Fallback sans IntersectionObserver
            const pump = () => {
                if (cancelled || cursor >= items.length) return;
                appendNextBatch();
                if (cursor < items.length) requestAnimationFrame(pump);
            };
            requestAnimationFrame(pump);
        }
    }

    return () => {
        cancelled = true;
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (sentinel.parentNode === container) {
            container.removeChild(sentinel);
        }
    };
}
