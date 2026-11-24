// @ts-check

/**
 * @param {string | number} version
 * @param {(key: string, fallback?: string) => string} t
 * @returns {Promise<"jre" | "jdk" | null>}
 */
export function showJavaTypeModal(version, t = window.t) {
    return new Promise((resolve) => {
        const modal = document.createElement("div");
        modal.id = "modal-java-choice";
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(5px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999; font-family: sans-serif; color: var(--text, #fff);
            opacity: 0; transition: opacity 0.2s ease-in-out;
        `;

        modal.innerHTML = `
            <div class="u-s252">
                <h3 class="u-s253">
                    ${t("java_choice_title", "Installation de Java {version}").replace("{version}", String(version))}
                </h3>
                <p class="u-s254">
                    ${t("java_choice_desc", "Sélectionnez le type d'environnement à installer pour votre jeu :")}
                </p>
                <div id="choice-jre" class="u-s255">
                    <strong class="u-s256">JRE (Java Runtime Environment)</strong>
                    <span class="u-s257">
                        ${t("java_jre_spec", "Version allégée (env. 40 Mo). Idéale pour le jeu de base (Vanilla) et les modpacks légers. Consomme moins d'espace disque.")}
                    </span>
                </div>
                <div id="choice-jdk" class="u-s258">
                    <strong class="u-s256">JDK (Java Development Kit)</strong>
                    <span class="u-s257">
                        ${t("java_jdk_spec", "Version complète (env. 150 Mo). Recommandée pour les gros modpacks complexes (gros mods, serveurs locaux) et le développement.")}
                    </span>
                </div>
                <div class="u-s259">
                    <button id="choice-cancel" class="btn-secondary u-s260">
                        ${t("btn_cancel", "Annuler")}
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        requestAnimationFrame(() => {
            modal.style.opacity = "1";
            const inner = /** @type {HTMLElement | null} */ (modal.querySelector("div"));
            if (inner) inner.style.transform = "scale(1)";
        });

        const jreBox = /** @type {HTMLElement | null} */ (modal.querySelector("#choice-jre"));
        const jdkBox = /** @type {HTMLElement | null} */ (modal.querySelector("#choice-jdk"));
        const cancelBtn = /** @type {HTMLElement | null} */ (modal.querySelector("#choice-cancel"));

        /** @param {HTMLElement} el */
        const hoverIn = (el) => {
            el.style.backgroundColor = "rgba(255,255,255,0.06)";
            el.style.borderColor = "var(--accent, #3b82f6)";
            el.style.transform = "translateY(-2px)";
        };
        /** @param {HTMLElement} el */
        const hoverOut = (el) => {
            el.style.backgroundColor = "rgba(255,255,255,0.02)";
            el.style.borderColor = "var(--border, rgba(255, 255, 255, 0.1))";
            el.style.transform = "translateY(0)";
        };

        if (jreBox) {
            jreBox.onmouseover = () => hoverIn(jreBox);
            jreBox.onmouseout = () => hoverOut(jreBox);
            jreBox.onclick = () => closeAndResolve("jre");
        }
        if (jdkBox) {
            jdkBox.onmouseover = () => hoverIn(jdkBox);
            jdkBox.onmouseout = () => hoverOut(jdkBox);
            jdkBox.onclick = () => closeAndResolve("jdk");
        }
        if (cancelBtn) {
            cancelBtn.onclick = () => closeAndResolve(null);
        }

        /** @param {"jre" | "jdk" | null} val */
        const closeAndResolve = (val) => {
            modal.style.opacity = "0";
            const inner = /** @type {HTMLElement | null} */ (modal.querySelector("div"));
            if (inner) inner.style.transform = "scale(0.95)";
            setTimeout(() => {
                if (document.body.contains(modal)) document.body.removeChild(modal);
                resolve(val);
            }, 200);
        };
    });
}

/**
 * Affiche une modale invitant l'utilisateur à saisir sa clé de récupération E2E
 * lorsqu'une synchronisation rencontre E2E_KEY_REQUIRED ou E2E_KEY_MISMATCH.
 * @param {string} reasonCode
 * @param {(key: string, fallback?: string) => string} [t]
 * @returns {Promise<string | null>}
 */
export function showE2EKeyPromptModal(reasonCode, t = window.t) {
    return new Promise((resolve) => {
        const modal = document.createElement("div");
        modal.id = "modal-e2e-key-prompt";
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(5px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999; font-family: sans-serif; color: var(--text, #fff);
            opacity: 0; transition: opacity 0.2s ease-in-out;
        `;

        const esc = window.escapeHTML ? window.escapeHTML : (/** @type {string} */ s) => String(s);
        const title = esc(t("horizon_e2e_modal_title", "Clé de déchiffrement E2E requise"));
        const desc = reasonCode === "E2E_KEY_MISMATCH"
            ? esc(t("horizon_e2e_modal_mismatch", "La clé E2E enregistrée est incorrecte pour cette sauvegarde. Saisissez la clé de récupération valide :"))
            : esc(t("horizon_e2e_modal_required", "Cette sauvegarde Cloud est chiffrée. Saisissez votre clé de récupération E2E (GH-...) pour synchroniser cette instance :"));
        const placeholder = esc(t("horizon_e2e_modal_placeholder", "GH-XXXX-XXXX-XXXX-XXXX"));
        const confirmLbl = esc(t("horizon_e2e_modal_confirm", "Enregistrer et synchroniser"));
        const cancelLbl = esc(t("btn_cancel", "Annuler"));

        modal.innerHTML = `
            <div class="u-s252">
                <h3 class="u-s253">${title}</h3>
                <p class="u-s254">${desc}</p>
                <input id="modal-e2e-input" type="password" class="form-input u-s016" placeholder="${placeholder}" autocomplete="off" />
                <div class="u-s259">
                    <button id="modal-e2e-cancel" class="btn-secondary u-s260">${cancelLbl}</button>
                    <button id="modal-e2e-confirm" class="btn-primary">${confirmLbl}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = /** @type {HTMLInputElement | null} */ (modal.querySelector("#modal-e2e-input"));
        const cancelBtn = /** @type {HTMLElement | null} */ (modal.querySelector("#modal-e2e-cancel"));
        const confirmBtn = /** @type {HTMLElement | null} */ (modal.querySelector("#modal-e2e-confirm"));

        requestAnimationFrame(() => {
            modal.style.opacity = "1";
            input?.focus();
        });

        /** @param {string | null} val */
        const closeAndResolve = (val) => {
            modal.style.opacity = "0";
            setTimeout(() => {
                if (document.body.contains(modal)) document.body.removeChild(modal);
                resolve(val);
            }, 200);
        };

        cancelBtn?.addEventListener("click", () => closeAndResolve(null));
        confirmBtn?.addEventListener("click", () => {
            const v = (input?.value || "").trim();
            if (v.length >= 4) closeAndResolve(v);
            else input?.focus();
        });
        input?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") confirmBtn?.click();
            else if (e.key === "Escape") closeAndResolve(null);
        });
    });
}
