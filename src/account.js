import { store } from "./store.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupAccountUI() {
    
    async function fetchSkinBase64(playerName) {
        try {
            const safeName = encodeURIComponent(playerName);
            const res = await fetch(`https://mc-heads.net/avatar/${safeName}/32?t=${Date.now()}`);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch(e) { return null; }
    }

    window.openAccountModal = () => {
        document.getElementById("acc-name").value = "";
        document.getElementById("offline-input-container").style.display = "none";
        document.getElementById("modal-account").style.display = "flex";
        
        store.uiSelectedAccRow = store.selectedAccountIdx;
        window.renderAccountManager();
    };

    window.renderAccountManager = function() {
        const list = document.getElementById("account-list");
        list.innerHTML = "";
        
        const btnUse = document.getElementById("btn-use-acc");
        const btnDel = document.getElementById("btn-del-acc");
        const btnSkin = document.getElementById("btn-skin-acc");

        if (store.allAccounts.length === 0) {
            list.innerHTML = `<div style="padding: 20px; color: #aaa; text-align: center;">${t("msg_no_acc", "Aucun profil enregistré.")}</div>`;
            if (btnUse) btnUse.disabled = true;
            if (btnDel) btnDel.disabled = true;
            if (btnSkin) btnSkin.disabled = true;
            store.uiSelectedAccRow = null;
            return;
        }

        if (btnUse) btnUse.disabled = (store.uiSelectedAccRow === null || store.uiSelectedAccRow === store.selectedAccountIdx);
        if (btnDel) btnDel.disabled = (store.uiSelectedAccRow === null);
        if (btnSkin) btnSkin.disabled = (store.uiSelectedAccRow === null);

        let rowsHtml = "";
        store.allAccounts.forEach((acc, i) => {
            const isSelected = store.uiSelectedAccRow === i;
            const isActive = store.selectedAccountIdx === i;

            const typeText = acc.type === "microsoft" ? t("lbl_ms_account", "Compte Microsoft") : t("lbl_offline_account", "Hors-Ligne (Crack)");
            const activeText = isActive ? `✔ ${t("lbl_active_acc", "Actif")}` : "";
            const safeName = window.escapeHTML(acc.name);

            if (!acc.skinBase64 && window.navigator.onLine) {
                fetchSkinBase64(acc.name).then(b64 => {
                    if (b64) {
                        acc.skinBase64 = b64;
                        fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
                        const imgEl = document.getElementById(`acc-img-${i}`);
                        if (imgEl) imgEl.src = b64;
                    }
                });
            }
            const imgSrc = acc.skinBase64 || `https://mc-heads.net/avatar/${encodeURIComponent(acc.name)}/32?t=${Date.now()}`;

            rowsHtml += `
            <div class="mmc-account-item ${isSelected ? 'selected' : ''}" onclick="selectAccountRow(${i})" ondblclick="useSelectedRow()">
                <img id="acc-img-${i}" src="${imgSrc}" alt="${safeName}">
                <div class="mmc-info">
                    <div class="mmc-name">${safeName}</div>
                    <div class="mmc-type">${typeText}</div>
                </div>
                <div class="mmc-active-label">${activeText}</div>
            </div>`;
        });
        list.innerHTML = rowsHtml;
    };

    window.selectAccountRow = (index) => {
        store.uiSelectedAccRow = index;
        window.renderAccountManager();
    };

    window.useSelectedRow = () => {
        if (store.uiSelectedAccRow !== null) {
            store.selectedAccountIdx = store.uiSelectedAccRow;
            fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
            
            if (window.renderAccountManager) window.renderAccountManager();
            if (window.updateAccountDropdown) window.updateAccountDropdown();
        }
    };

    window.deleteSelectedRow = async () => {
        if (store.uiSelectedAccRow !== null) {
            const confirmMsg = (store.currentLangObj && store.currentLangObj.msg_remove_acc) || "Retirer ce compte ?";
            
            if (await window.showCustomConfirm(confirmMsg, true)) {
                const accToDel = store.allAccounts[store.uiSelectedAccRow];

                if (accToDel.type === "microsoft") {
                    const msaCacheKey = accToDel.mclcAuth?.meta?.msaCacheKey;
                    if (msaCacheKey) {
                        window.api.send("delete-msa-cache", msaCacheKey);
                    }
                }

                store.allAccounts.splice(store.uiSelectedAccRow, 1);
                
                if (store.selectedAccountIdx === store.uiSelectedAccRow) {
                    store.selectedAccountIdx = store.allAccounts.length > 0 ? 0 : null;
                } else if (store.selectedAccountIdx > store.uiSelectedAccRow) {
                    store.selectedAccountIdx--;
                }
                
                store.uiSelectedAccRow = null;
                
                fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
                
                if (window.renderAccountManager) window.renderAccountManager();
                if (window.updateAccountDropdown) window.updateAccountDropdown(); 
            }
        }
    };

    window.toggleOfflineInput = () => {
        const container = document.getElementById("offline-input-container");
        container.style.display = container.style.display === "none" ? "flex" : "none";
        if (container.style.display === "flex") {
            document.getElementById("acc-name").focus();
        }
    };

    window.saveOfflineAccount = () => {
        const nameInput = document.getElementById("acc-name");
        const name = nameInput.value.trim();
        if (!name) {
            if (window.showToast) window.showToast(t("msg_err_pseudo_req", "Le pseudo est obligatoire !"), "error");
            return;
        }
        
        store.allAccounts.push({
            type: "offline",
            name: name,
            uuid: window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID().replace(/-/g, "") : "00000000000030008000" + Date.now().toString().slice(-12)
        });
        store.selectedAccountIdx = store.allAccounts.length - 1;
        
        fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
        
        nameInput.value = "";
        document.getElementById("offline-input-container").style.display = "none";
        
        if (window.renderAccountManager) window.renderAccountManager();
        if (window.updateAccountDropdown) window.updateAccountDropdown();
    };

    window.closeAccountModal = () => {
        document.getElementById("modal-account").style.display = "none";
    };

    window.updateAccountDropdown = () => {
        const dropdown = document.getElementById("account-dropdown");
        const skinImg = document.getElementById("active-skin");
        if (!dropdown) return;
        
        dropdown.innerHTML = "";
        if (store.allAccounts.length === 0) {
            dropdown.innerHTML = `<option value="">${t("msg_no_acc", "Aucun compte")}</option>`;
            if (skinImg) skinImg.style.display = "none";
            return;
        }
        
        store.allAccounts.forEach((acc, i) => {
            const opt = document.createElement("option");
            opt.value = i;
            opt.innerText = acc.name;
            if (i === store.selectedAccountIdx) opt.selected = true;
            dropdown.appendChild(opt);
        });
        
        if (skinImg && store.selectedAccountIdx !== null) {
            const activeAcc = store.allAccounts[store.selectedAccountIdx];
            
            if (!activeAcc.skinBase64 && window.navigator.onLine) {
                fetchSkinBase64(activeAcc.name).then(b64 => {
                    if (b64) {
                        activeAcc.skinBase64 = b64;
                        fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
                        skinImg.src = b64;
                    }
                });
            }
            
            skinImg.src = activeAcc.skinBase64 || `https://mc-heads.net/avatar/${encodeURIComponent(activeAcc.name)}/32?t=${Date.now()}`;
            skinImg.style.display = "block";
        } else if (skinImg) {
            skinImg.style.display = "none";
        }
        if (window.updateLaunchButton) window.updateLaunchButton();
    };

    window.changeAccount = () => {
        const dropdown = document.getElementById("account-dropdown");
        const newIdx = parseInt(dropdown.value);
        if (!isNaN(newIdx)) {
            store.selectedAccountIdx = newIdx;
            fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2));
            window.updateAccountDropdown(); 
            if (window.renderUI) window.renderUI();
            if (window.renderAccountManager) window.renderAccountManager();
        }
    };

    let fullscreenSkinViewer = null;

    async function getMojangCapeUrl(uuid) {
        try {
            const cleanUuid = uuid.replace(/-/g, "");
            const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`);
            if (!res.ok) return null;
            
            const data = await res.json();
            const texturesProp = data.properties.find(p => p.name === "textures");
            if (!texturesProp) return null;
            
            const texturesJson = JSON.parse(atob(texturesProp.value));
            if (texturesJson.textures && texturesJson.textures.CAPE) {
                return texturesJson.textures.CAPE.url;
            }
        } catch (e) {
            console.error("Erreur récupération cape Mojang :", e);
        }
        return null;
    }

    window.openSkinModal = () => {
        if (store.uiSelectedAccRow === null) return;
        const acc = store.allAccounts[store.uiSelectedAccRow];
        
        const btnUpload = document.getElementById("btn-upload-skin");
        const btnLink = document.getElementById("btn-link-ms-skin");
        const divider = document.getElementById("skin-divider");
        const titleName = document.getElementById("skin-modal-name");

        titleName.innerText = acc.name;
        document.getElementById("modal-skin").style.display = "flex";

        if (acc.type === "offline") {
            btnUpload.style.display = "none";
            btnLink.style.display = "none";
            divider.style.display = "none";
        } else {
            btnUpload.style.display = "block";
            btnUpload.innerText = t("btn_test_skin", "Tester un Skin (Aperçu)");
            btnLink.style.display = "block";
            divider.style.display = "block";
        }

        const canvas = document.getElementById("fullscreen-skin-canvas");
        canvas.style.transition = "opacity 0.2s ease";
        canvas.style.opacity = "0";

        const skinUrl = `https://minotar.net/skin/${encodeURIComponent(acc.name)}?t=${Date.now()}`;

        if (!fullscreenSkinViewer) {
            fullscreenSkinViewer = new skinview3d.SkinViewer({
                canvas: canvas,
                width: 200,
                height: 300,
                skin: skinUrl
            });
            fullscreenSkinViewer.controls.enableRotate = true;
            fullscreenSkinViewer.controls.enableZoom = true;
            fullscreenSkinViewer.animation = new skinview3d.WalkingAnimation();
            
            setTimeout(() => { canvas.style.opacity = "1"; }, 150);
        } else {
            if (fullscreenSkinViewer.animation) fullscreenSkinViewer.animation.paused = false;

            fullscreenSkinViewer.loadSkin(skinUrl).then(() => {
                canvas.style.opacity = "1";
            });
        }
        
        if (acc.type === "microsoft" && acc.uuid) {
            getMojangCapeUrl(acc.uuid).then(mojangCapeUrl => {
                if (mojangCapeUrl) {
                    fullscreenSkinViewer.loadCape(mojangCapeUrl);
                } else {
                    fullscreenSkinViewer.loadCape(`https://s.optifine.net/capes/${encodeURIComponent(acc.name)}.png?t=${Date.now()}`).catch(() => {
                        fullscreenSkinViewer.loadCape(null);
                    });
                }
            });
        } else {
            fullscreenSkinViewer.loadCape(null);
        }
    };

    window.closeSkinModal = () => {
        document.getElementById("modal-skin").style.display = "none";
        if (fullscreenSkinViewer && fullscreenSkinViewer.animation) {
            fullscreenSkinViewer.animation.paused = true;
        }
    };

    window.previewLocalSkin = (input) => {
        const file = input.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            if (fullscreenSkinViewer) {
                fullscreenSkinViewer.loadSkin(e.target.result);
                window.showToast(t("msg_skin_preview", "Aperçu du skin chargé en 3D !"), "info");
            }
        };
        reader.readAsDataURL(file);
        input.value = ""; 
    };

    window.exportSkin = async () => {
        if (store.uiSelectedAccRow === null) return;
        const acc = store.allAccounts[store.uiSelectedAccRow];
        
        try {
            const res = await fetch(`https://minotar.net/skin/${encodeURIComponent(acc.name)}`);
            if (!res.ok) throw new Error("Impossible de récupérer le skin");
            
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement("a");
            a.href = url;
            a.download = `${acc.name}_skin.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            window.showToast(t("msg_skin_exported", "Skin exporté avec succès !"), "success");
        } catch (e) {
            window.showToast(t("msg_err_skin_export", "Erreur lors de l'exportation du skin."), "error");
        }
    };
}