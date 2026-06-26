/**
 * ModalManager.js
 * Centralise la création de modales dynamiques pour alléger le code métier.
 */

export function showJavaTypeModal(version, t) {
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
            <div style="
                background: var(--bg-panel, rgba(45, 45, 48, 0.85));
                backdrop-filter: blur(12px);
                border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
                border-radius: 12px; padding: 24px; width: 440px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); box-sizing: border-box;
                transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            ">
                <h3 style="margin-top:0; color:var(--text-light, #fff); font-size:1.2rem; margin-bottom:12px;">
                    ${t("java_choice_title", "Installation de Java {version}").replace("{version}", version)}
                </h3>
                <p style="font-size:0.85rem; opacity:0.8; margin-bottom:20px; line-height:1.4;">
                    ${t("java_choice_desc", "Sélectionnez le type d'environnement à installer pour votre jeu :")}
                </p>
                <div id="choice-jre" style="
                    border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius:8px; padding:16px; margin-bottom:12px;
                    cursor:pointer; transition: all 0.2s ease; box-sizing: border-box; background: rgba(255,255,255,0.02);
                ">
                    <strong style="color: var(--accent, #3b82f6); font-size:1rem; display:block; margin-bottom:4px;">JRE (Java Runtime Environment)</strong>
                    <span style="font-size:0.8rem; opacity:0.75; line-height:1.4; display:block;">
                        ${t("java_jre_spec", "Version allégée (env. 40 Mo). Idéale pour le jeu de base (Vanilla) et les modpacks légers. Consomme moins d'espace disque.")}
                    </span>
                </div>
                <div id="choice-jdk" style="
                    border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius:8px; padding:16px; margin-bottom:24px;
                    cursor:pointer; transition: all 0.2s ease; box-sizing: border-box; background: rgba(255,255,255,0.02);
                ">
                    <strong style="color: var(--accent, #3b82f6); font-size:1rem; display:block; margin-bottom:4px;">JDK (Java Development Kit)</strong>
                    <span style="font-size:0.8rem; opacity:0.75; line-height:1.4; display:block;">
                        ${t("java_jdk_spec", "Version complète (env. 150 Mo). Recommandée pour les gros modpacks complexes (gros mods, serveurs locaux) et le développement.")}
                    </span>
                </div>
                <div style="display:flex; justify-content:flex-end;">
                    <button id="choice-cancel" class="btn-secondary" style="height:34px; padding:0 24px; font-size:0.85rem; cursor:pointer; border-radius: 6px;">
                        ${t("btn_cancel", "Annuler")}
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        requestAnimationFrame(() => {
            modal.style.opacity = "1";
            modal.querySelector("div").style.transform = "scale(1)";
        });

        const jreBox = modal.querySelector("#choice-jre");
        const jdkBox = modal.querySelector("#choice-jdk");
        const cancelBtn = modal.querySelector("#choice-cancel");

        const hoverIn = (el) => {
            el.style.backgroundColor = "rgba(255,255,255,0.06)";
            el.style.borderColor = "var(--accent, #3b82f6)";
            el.style.transform = "translateY(-2px)";
        };
        const hoverOut = (el) => {
            el.style.backgroundColor = "rgba(255,255,255,0.02)";
            el.style.borderColor = "var(--border, rgba(255, 255, 255, 0.1))";
            el.style.transform = "translateY(0)";
        };

        jreBox.onmouseover = () => hoverIn(jreBox);
        jreBox.onmouseout = () => hoverOut(jreBox);
        jdkBox.onmouseover = () => hoverIn(jdkBox);
        jdkBox.onmouseout = () => hoverOut(jdkBox);

        const closeAndResolve = (val) => {
            modal.style.opacity = "0";
            modal.querySelector("div").style.transform = "scale(0.95)";
            setTimeout(() => {
                if (document.body.contains(modal)) document.body.removeChild(modal);
                resolve(val);
            }, 200);
        };

        jreBox.onclick = () => closeAndResolve("jre");
        jdkBox.onclick = () => closeAndResolve("jdk");
        cancelBtn.onclick = () => closeAndResolve(null);
    });
}
