import { store } from "./store.js";

let _accountSaveTimer = null;
function scheduleSaveAccounts() {
    if (_accountSaveTimer) clearTimeout(_accountSaveTimer);
    _accountSaveTimer = setTimeout(() => {
        _accountSaveTimer = null;
        window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
    }, 300);
}

export function setupAccountUI() {
    const skinCacheFile = window.api.path.join(window.api.appData, 'GensLauncher', 'skin-cache.json');
    let _skinCache = null;

    function getSkinCache() {
        if (_skinCache !== null) return _skinCache;
        try {
            const raw = window.api.fs.readFileSync(skinCacheFile, 'utf8');
            _skinCache = JSON.parse(raw);
        } catch(e) { _skinCache = {}; }
        return _skinCache;
    }

    function saveSkin(name, b64) {
        const cache = getSkinCache();
        cache[name] = b64;
        window.safeWriteJSON(skinCacheFile, cache);
    }

    function getCachedSkin(name) {
        return getSkinCache()[name] || null;
    }

    (function migrateSkins() {
        let changed = false;
        store.allAccounts.forEach(acc => {
            if (acc.skinBase64) {
                saveSkin(acc.name, acc.skinBase64);
                delete acc.skinBase64;
                changed = true;
            }
        });
        if (changed) {
            window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
        }
    })();
    
async function fetchSkinBase64(acc) {
        try {
            const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : acc.name;
            const url = `https://mc-heads.net/avatar/${encodeURIComponent(id)}/32`;
                
            const res = await fetch(url);
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
            list.innerHTML = `<div style="padding: 20px; color: #aaa; text-align: center;">${t("msg_no_acc", "Aucun profil")}</div>`; 
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

const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : acc.name;
            const fallbackUrl = `https://mc-heads.net/avatar/${encodeURIComponent(id)}/32`;
            
            const cachedSkin = getCachedSkin(acc.name);
            const imgSrc = cachedSkin || fallbackUrl;

            if (!cachedSkin && !acc._fetchingSkin && window.navigator.onLine) {
                acc._fetchingSkin = true;
                fetchSkinBase64(acc).then(b64 => {
                    acc._fetchingSkin = false;
                    if (b64) {
                        saveSkin(acc.name, b64);
                        const imgEl = document.getElementById(`acc-img-${i}`);
                        if (imgEl) imgEl.src = b64;
                    }
                });
            }

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
            window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
            
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
                
                window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                
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
        
        const encoder = new TextEncoder();
        const dataToHash = encoder.encode("OfflinePlayer:" + name);
        const md5Hex = window.api.tools.hashBuffer(dataToHash, "md5");
        
        const offlineUuid = md5Hex.substring(0, 12) + "3" + md5Hex.substring(13, 16) + 
                            (parseInt(md5Hex.substring(16, 17), 16) & 0x3 | 0x8).toString(16) + md5Hex.substring(17, 32);

        store.allAccounts.push({
            type: "offline",
            name: name,
            uuid: offlineUuid
        });
        store.selectedAccountIdx = store.allAccounts.length - 1;
        
        window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
        
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
            dropdown.innerHTML = `<option value="">${t("msg_no_acc", "Aucun profil")}</option>`; 
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
            const id = (activeAcc.type === "microsoft" && activeAcc.uuid) ? activeAcc.uuid : activeAcc.name;
            const fallbackUrl = `https://mc-heads.net/avatar/${encodeURIComponent(id)}/32`;

            const activeSkin = getCachedSkin(activeAcc.name);
            
            if (!activeSkin && !activeAcc._fetchingSkin && window.navigator.onLine) {
                activeAcc._fetchingSkin = true;
                fetchSkinBase64(activeAcc).then(b64 => {
                    activeAcc._fetchingSkin = false;
                    if (b64) {
                        saveSkin(activeAcc.name, b64);
                        skinImg.src = b64;
                    }
                });
            }
            skinImg.src = activeSkin || fallbackUrl;
            skinImg.style.display = "block";
        }else if (skinImg) {
            skinImg.style.display = "none";
        }
        if (window.updateLaunchButton) window.updateLaunchButton();
    };

    window.changeAccount = () => {
        const dropdown = document.getElementById("account-dropdown");
        const newIdx = parseInt(dropdown.value);
        if (!isNaN(newIdx)) {
            store.selectedAccountIdx = newIdx;
            window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
            window.updateAccountDropdown(); 
            if (window.renderUI) window.renderUI();
            if (window.renderAccountManager) window.renderAccountManager();
        }
    };

    let fullscreenSkinViewer = null;

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

        const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : null;

        async function loadSkinFromMojang(uuid) {
            const profileRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
            if (!profileRes.ok) throw new Error("profile not found");
            const profile = await profileRes.json();
            const encoded = profile.properties?.find(p => p.name === "textures")?.value;
            if (!encoded) throw new Error("no textures");
            const textures = JSON.parse(atob(encoded)).textures;
            const skinObj = textures?.SKIN;
            const capeObj = textures?.CAPE;
            return { skinUrl: skinObj?.url || null, capeUrl: capeObj?.url || null };
        }

        const STEVE_URL = "https://assets.mojang.com/SkinTemplates/steve.png";

        async function applyTextures() {
            let skinUrl = STEVE_URL;
            let capeUrl = null;

            if (id) {
                try {
                    const data = await loadSkinFromMojang(id);
                    if (data.skinUrl) skinUrl = data.skinUrl;
                    capeUrl = data.capeUrl;
                } catch(e) {
                }
            }

            if (!fullscreenSkinViewer) {
                fullscreenSkinViewer = new skinview3d.SkinViewer({
                    canvas: canvas,
                    width: 200,
                    height: 300,
                });
                fullscreenSkinViewer.controls.enableRotate = true;
                fullscreenSkinViewer.controls.enableZoom = true;
                fullscreenSkinViewer.animation = new skinview3d.WalkingAnimation();
            } else {
                if (fullscreenSkinViewer.animation) fullscreenSkinViewer.animation.paused = false;
            }

            try {
                await fullscreenSkinViewer.loadSkin(skinUrl);
            } catch(e) {
                try { await fullscreenSkinViewer.loadSkin(STEVE_URL); } catch(_) {}
            }

            try {
                if (capeUrl) {
                    await fullscreenSkinViewer.loadCape(capeUrl);
                } else {
                    await fullscreenSkinViewer.loadCape(null);
                }
            } catch(_) {
                try { fullscreenSkinViewer.loadCape(null); } catch(_) {}
            }

            canvas.style.opacity = "1";
        }

        applyTextures();
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
            const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : encodeURIComponent(acc.name);
            const res = await fetch(`https://api.mineatar.io/skin/${id}`);
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