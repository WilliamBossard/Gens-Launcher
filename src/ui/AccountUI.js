import { store } from "../store.js";
let _accountSaveTimer = null;
function scheduleSaveAccounts() {
    if (_accountSaveTimer) clearTimeout(_accountSaveTimer);
    _accountSaveTimer = setTimeout(async () => {
        _accountSaveTimer = null;
        await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
    }, 300);
}
export function setupAccountUI() {
    const skinCacheFile = window.api.path.join(window.api.appData, 'GensLauncher', 'skin-cache.json');
    let _skinCache = null;
    async function getSkinCache() {
        if (_skinCache !== null) return _skinCache;
        try {
            const raw = await window.api.fs.promises.readFile(skinCacheFile, 'utf8');
            _skinCache = JSON.parse(raw);
        } catch (e) { _skinCache = {}; }
        return _skinCache;
    }
    async function saveSkin(name, b64) {
        const cache = await getSkinCache();
        cache[name] = b64;
        window.safeWriteJSONAsync(skinCacheFile, cache);
    }
    async function getCachedSkin(name) {
        const cache = await getSkinCache();
        return cache[name] || null;
    }
    const customSkinCacheFile = window.api.path.join(window.api.appData, 'GensLauncher', 'custom-skins.json');
    let _customSkinCache = null;
    async function getCustomSkinCache() {
        if (_customSkinCache !== null) return _customSkinCache;
        try {
            const raw = await window.api.fs.promises.readFile(customSkinCacheFile, 'utf8');
            _customSkinCache = JSON.parse(raw);
        } catch (e) { _customSkinCache = {}; }
        return _customSkinCache;
    }
    async function saveCustomSkin(name, b64) {
        const cache = await getCustomSkinCache();
        cache[name] = b64;
        window.safeWriteJSONAsync(customSkinCacheFile, cache);
    }
    window.getCustomSkin = async function (name) {
        const cache = await getCustomSkinCache();
        return cache[name] || null;
    };
    (async function migrateSkins() {
        let changed = false;
        store.allAccounts.forEach(acc => {
            if (acc.skinBase64) {
                saveSkin(acc.name, acc.skinBase64);
                delete acc.skinBase64;
                changed = true;
            }
        });
        if (changed) {
            await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
        }
        
        // Cleanup corrupted custom-skins (if they are 32x32 faces instead of 64x64 skins due to a previous bug)
        const customCache = await getCustomSkinCache();
        let customChanged = false;
        for (const [name, b64] of Object.entries(customCache)) {
            if (b64 && b64.startsWith("data:image")) {
                const img = new Image();
                img.onload = () => {
                    if (img.width !== 64) {
                        delete customCache[name];
                        window.safeWriteJSONAsync(customSkinCacheFile, customCache);
                    }
                };
                img.src = b64;
            }
        }
    })();
    async function fetchSkinBase64(acc) {
        try {
            const res = await window.api.invoke("fetch-mojang-raw-skin", {
                name: acc.name,
                uuid: (acc.type === "microsoft") ? acc.uuid : null
            });
            if (!res.success) {
                return null;
            }
            const rawDataUrl = "data:image/png;base64," + res.data;
            saveCustomSkin(acc.name, rawDataUrl);
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = 32;
                    canvas.height = 32;
                    const ctx = canvas.getContext("2d");
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 32, 32);
                    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 32, 32);
                    resolve(canvas.toDataURL("image/png"));
                };
                img.onerror = () => {
                    resolve(null);
                };
                img.src = rawDataUrl;
            });
        } catch (e) {
            return null;
        }
    }
    window.openAccountModal = () => {
        document.getElementById("acc-name").value = "";
        document.getElementById("offline-input-container").style.display = "none";
        document.getElementById("modal-account").style.display = "flex";
        store.uiSelectedAccRow = store.selectedAccountIdx;
        window.renderAccountManager();
    };
    window.renderAccountManager = async function () {
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
        for (let i = 0; i < store.allAccounts.length; i++) {
            const acc = store.allAccounts[i];
            const isSelected = store.uiSelectedAccRow === i;
            const isActive = store.selectedAccountIdx === i;
            const typeText = acc.type === "microsoft" ? t("lbl_ms_account", "Compte Microsoft") : t("lbl_offline_account", "Hors-Ligne (Crack)");
            const activeText = isActive ? `\u2713 ${t("lbl_active_acc", "Actif")}` : "";
            const safeName = window.escapeHTML(acc.name);
            const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : acc.name;
            const fallbackUrl = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAA7EAAAOxAGVKw4bAAABHElEQVRYhWM0VhH8z4AH8LCx4JMmCL78+oPC/4HGZ6LIdCqAUQewfPzyHUWAn4cThY8eh4TSBKnqBzwERh3Aws7GiiKQYW+BwpcQE0XVwMWLwv/z7TMK//vP3yj8jx8/oPBnHjqJwh/wEBh1AOPsZE+UuoCfXwBFASc7ahpBB+hxTgigp4kBD4FRB7Cgx3lo7zIUfrBdFwo/wvQCCh89TrffckDhrz1UhsJfXRyFwh/wEBh1AMFyAB0cOHcdr7yDkSZe+dFyYNA5gOXrt28oAl9+f0Xh7zp+CYWvJ6uK18AZqzei8H0dTVD4n76i1h0DHgKjDmBhYUftGr79jBpHP3/8QuFfenwbrzw7BxsKHz3O+bhR2xcDHgKjDgAAmYhW7ARMCXsAAAAASUVORK5CYII=`;
            const cachedSkin = await getCachedSkin(acc.name);
            const customSkin = await window.getCustomSkin(acc.name);
            const imgSrc = cachedSkin || fallbackUrl;
            if (!cachedSkin && !acc._fetchingSkin && window.isTrulyOnline) {
                acc._fetchingSkin = true;
                fetchSkinBase64(acc).then(b64 => {
                    acc._fetchingSkin = false;
                    if (b64) {
                        saveSkin(acc.name, b64);
                        const imgEl = document.getElementById(`acc-img-${i}`);
                        if (imgEl) {
                            imgEl.src = b64;
                        }
                        if (store.selectedAccountIdx === i) {
                            const activeImg = document.getElementById("active-skin");
                            if (activeImg) activeImg.src = b64;
                        }
                    }
                });
            }
            rowsHtml += `
            <div class="mmc-account-item ${isSelected ? 'selected' : ''}" data-acc-index="${i}">
                <img id="acc-img-${i}" src="${imgSrc}" alt="${safeName}">
                <div class="mmc-info">
                    <div class="mmc-name">${safeName}</div>
                    <div class="mmc-type">${typeText}</div>
                </div>
                <div class="mmc-active-label">${activeText}</div>
            </div>`;
        }
        list.innerHTML = rowsHtml;
        // Délégation d'événements — remplace onclick/ondblclick inline (CSP)
        list.querySelectorAll('.mmc-account-item').forEach(el => {
            const idx = parseInt(el.dataset.accIndex);
            el.addEventListener('click', () => window.selectAccountRow(idx));
            el.addEventListener('dblclick', () => window.useSelectedRow());
        });
    };
    window.selectAccountRow = async (index) => {
        store.uiSelectedAccRow = index;
        window.renderAccountManager();
    };
    window.useSelectedRow = async () => {
        if (store.uiSelectedAccRow !== null) {
            store.selectedAccountIdx = store.uiSelectedAccRow;
            await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
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
                await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
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
    window.saveOfflineAccount = async () => {
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
        await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
        nameInput.value = "";
        document.getElementById("offline-input-container").style.display = "none";
        if (window.renderAccountManager) window.renderAccountManager();
        if (window.updateAccountDropdown) window.updateAccountDropdown();
    };
    window.closeAccountModal = () => {
        document.getElementById("modal-account").style.display = "none";
    };
    window.updateAccountDropdown = async () => {
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
            const fallbackUrl = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAA7EAAAOxAGVKw4bAAABHElEQVRYhWM0VhH8z4AH8LCx4JMmCL78+oPC/4HGZ6LIdCqAUQewfPzyHUWAn4cThY8eh4TSBKnqBzwERh3Aws7GiiKQYW+BwpcQE0XVwMWLwv/z7TMK//vP3yj8jx8/oPBnHjqJwh/wEBh1AOPsZE+UuoCfXwBFASc7ahpBB+hxTgigp4kBD4FRB7Cgx3lo7zIUfrBdFwo/wvQCCh89TrffckDhrz1UhsJfXRyFwh/wEBh1AMFyAB0cOHcdr7yDkSZe+dFyYNA5gOXrt28oAl9+f0Xh7zp+CYWvJ6uK18AZqzei8H0dTVD4n76i1h0DHgKjDmBhYUftGr79jBpHP3/8QuFfenwbrzw7BxsKHz3O+bhR2xcDHgKjDgAAmYhW7ARMCXsAAAAASUVORK5CYII=`;
            const activeSkin = await getCachedSkin(activeAcc.name);
            if (!activeSkin && !activeAcc._fetchingSkin && window.isTrulyOnline) {
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
        } else if (skinImg) {
            skinImg.style.display = "none";
        }
        if (window.updateLaunchButton) window.updateLaunchButton();
    };
    window.changeAccount = async () => {
        const dropdown = document.getElementById("account-dropdown");
        const newIdx = parseInt(dropdown.value);
        if (!isNaN(newIdx)) {
            store.selectedAccountIdx = newIdx;
            await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
            window.updateAccountDropdown();
            if (window.renderUI) window.renderUI();
            if (window.renderAccountManager) window.renderAccountManager();
        }
    };
    let fullscreenSkinViewer = null;
    window.openSkinModal = async () => {
        if (store.uiSelectedAccRow === null) return;
        const acc = store.allAccounts[store.uiSelectedAccRow];
        const btnUpload = document.getElementById("btn-upload-skin");
        const btnLink = document.getElementById("btn-link-ms-skin");
        const divider = document.getElementById("skin-divider");
        const titleName = document.getElementById("skin-modal-name");
        titleName.innerText = acc.name;
        document.getElementById("modal-skin").style.display = "flex";
        const cachedSkin = await getCachedSkin(acc.name);
        if (acc.type === "offline") {
            btnUpload.style.display = "block";
            btnUpload.innerText = t("btn_test_skin", "Charger un Skin Local");
            btnLink.style.display = "none";
            divider.style.display = "none";
        } else {
            btnUpload.style.display = "block";
            btnUpload.innerText = t("btn_test_skin", "Charger un Skin Local");
            btnLink.style.display = "block";
            divider.style.display = "block";
        }
        const canvas = document.getElementById("fullscreen-skin-canvas");
        canvas.style.transition = "opacity 0.2s ease";
        canvas.style.opacity = "0";
        const id = (acc.type === "microsoft" && acc.uuid) ? acc.uuid : null;
        async function loadSkinFromMojang(accParam) {
            const uuid = accParam.uuid;
            let token = null;
            if (accParam.type === "microsoft" && accParam.mclcAuth && accParam.mclcAuth.access_token) {
                try {
                    const refreshRes = await window.api.invoke("refresh-microsoft", accParam.mclcAuth.meta.msaCacheKey);
                    if (refreshRes.success && refreshRes.access_token) {
                        accParam.mclcAuth.access_token = refreshRes.access_token;
                    }
                    token = accParam.mclcAuth.access_token;
                } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in AccountUI.js:", e); }
            }
            
            const res = await window.api.invoke("fetch-mojang-profile", { token, uuid });
            if (res.success && res.data) {
                return res.data;
            }
            throw new Error(res.error || "Profile not found");
        }
        const STEVE_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFDUlEQVR42u2a20sUURzH97G0LKMotPuWbVpslj1olJXdjCgyisowsSjzgrB0gSKyC5UF1ZNQWEEQSBQ9dHsIe+zJ/+nXfM/sb/rN4ZwZ96LOrnPgyxzP/M7Z+X7OZc96JpEISfWrFhK0YcU8knlozeJKunE4HahEqSc2nF6zSEkCgGCyb+82enyqybtCZQWAzdfVVFgBJJNJn1BWFgC49/VpwGVlD0CaxQiA5HSYEwBM5sMAdKTqygcAG9+8coHKY/XXAZhUNgDYuBSPjJL/GkzVVhAEU5tqK5XZ7cnFtHWtq/TahdSw2l0HUisr1UKIWJQBAMehDuqiDdzndsP2EZECAG1ZXaWMwOCODdXqysLf++uXUGv9MhUHIByDOijjdiSAoH3ErANQD73C7TXXuGOsFj1d4YH4OTJAEy8y9Hd0mCaeZ5z8dfp88zw1bVyiYhCLOg1ZeAqC0ybaDttHRGME1DhDeVWV26u17lRAPr2+mj7dvULfHw2q65fhQRrLXKDfIxkau3ZMCTGIRR3URR5toU38HbaPiMwUcKfBAkoun09PzrbQ2KWD1JJaqswjdeweoR93rirzyCMBCmIQizqoizZkm2H7iOgAcHrMHbbV9KijkUYv7qOn55sdc4fo250e+vUg4329/Xk6QB/6DtOws+dHDGJRB3XRBve+XARt+4hIrAF4UAzbnrY0ve07QW8uHfB+0LzqanMM7qVb+3f69LJrD90/1axiEIs6qIs21BTIToewfcSsA+Bfb2x67OoR1aPPzu2i60fSNHRwCw221Suz0O3jO+jh6V1KyCMGse9721XdN5ePutdsewxS30cwuMjtC860T5JUKpXyKbSByUn7psi5l+juDlZYGh9324GcPKbkycaN3jUSAGxb46IAYPNZzW0AzgiQ5tVnzLUpUDCAbakMQXXrOtX1UMtHn+Q9/X5L4wgl7t37r85OSrx+TYl379SCia9KXjxRpiTjIZTBFOvrV1f8ty2eY/T7XJ81FQAwmA8ASH1ob68r5PnBsxA88/xAMh6SpqW4HRnLBrkOA9Xv5wPAZjAUgOkB+SHxgBgR0qSMh0zmZRsmwDJm1gFg2PMDIC8/nAHIMls8x8GgzOsG5WiaqREgYzDvpTwjLDy8NM15LpexDEA3LepjU8Z64my+8PtDCmUyRr+fFwA2J0eAFYA0AxgSgMmYBMZTwFQnO9RNAEaHOj2DXF5UADmvAToA2ftyxZYA5BqgmZZApDkdAK4mAKo8GzPlr8G8AehzMAyA/i1girUA0HtYB2CaIkUBEHQ/cBHSvwF0AKZFS5M0ZwMQtEaEAmhtbSUoDADH9ff3++QZ4o0I957e+zYAMt6wHkhzpjkuAcgpwNcpA7AZDLsvpwiuOkBvxygA6Bsvb0HlaeKIF2EbADZpGiGzBsA0gnwQHGOhW2snRpbpPexbAB2Z1oicAMQpTnGKU5ziFKc4xSlOcYpTnOIUpzgVmgo+XC324WfJAdDO/+ceADkCpuMFiFKbApEHkOv7BfzfXt+5gpT8V7rpfYJcDz+jAsB233r6yyBsJ0mlBCDofuBJkel4vOwBFPv8fyYAFPJ+wbSf/88UANNRVy4Awo6+Ig2gkCmgA5DHWjoA+X7AlM//owLANkX0w0359od++pvX8fdMAcj3/QJ9iJsAFPQCxHSnQt8vMJ3v2wCYpkhkAOR7vG7q4aCXoMoSgG8hFAuc/grMdAD4B/kHl9da7Ne9AAAAAElFTkSuQmCC";
        const customSkin = await window.getCustomSkin(acc.name);
        let currentSkinUrl = customSkin || STEVE_URL;
        async function applyTextures() {
            let capeUrl = null;
            if (id) {
                try {
                    const data = await loadSkinFromMojang(acc);
                    if (data.skinUrl && !customSkin) {
                        currentSkinUrl = data.skinUrl;
                    }
                    capeUrl = data.capeUrl;
                } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in AccountUI.js:", e); }
            }
            if (!fullscreenSkinViewer) {
                try {
                    fullscreenSkinViewer = new skinview3d.SkinViewer({
                        canvas: canvas,
                        width: 200,
                        height: 300,
                    });
                    fullscreenSkinViewer.controls.enableRotate = true;
                    fullscreenSkinViewer.controls.enableZoom = true;
                    fullscreenSkinViewer.animation = new skinview3d.WalkingAnimation();
                    
                    if (fullscreenSkinViewer.scene) {
                        fullscreenSkinViewer.scene.traverse((child) => {
                            if (child.isLight && child.shadow && child.shadow.bias < -16) {
                                child.shadow.bias = -0.001;
                            }
                        });
                    }
                } catch (webglErr) {
                    console.error("WebGL not supported:", webglErr);
                    canvas.style.display = "none";
                    if (!document.getElementById("skin-webgl-error")) {
                        const fallback = document.createElement("div");
                        fallback.id = "skin-webgl-error";
                        fallback.style.color = "#f87171";
                        fallback.style.textAlign = "center";
                        fallback.style.padding = "20px";
                        fallback.style.width = "200px";
                        fallback.innerText = "Aperçu 3D indisponible\n(WebGL non supporté)";
                        canvas.parentElement.appendChild(fallback);
                    }
                    return;
                }
            } else {
                if (fullscreenSkinViewer.animation) fullscreenSkinViewer.animation.paused = false;
            }
            const currentModel = document.getElementById("skin-variant-select") ? document.getElementById("skin-variant-select").value : "classic";
            try {
                window.lastLoadedSkinUrl = currentSkinUrl;
                await fullscreenSkinViewer.loadSkin(currentSkinUrl, { model: currentModel });
            } catch (e) {
                window.lastLoadedSkinUrl = STEVE_URL;
                try { await fullscreenSkinViewer.loadSkin(STEVE_URL, { model: currentModel }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in AccountUI.js:", _); }
            }
            try {
                if (capeUrl) {
                    await fullscreenSkinViewer.loadCape(capeUrl);
                } else {
                    await fullscreenSkinViewer.loadCape(null);
                }
            } catch (_) {
                try { fullscreenSkinViewer.loadCape(null); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in AccountUI.js:", _); }
            }
            canvas.style.opacity = "1";
        }
        applyTextures();
    };
    window.updateSkinVariantPreview = (select) => {
        if (fullscreenSkinViewer && window.lastLoadedSkinUrl) {
            fullscreenSkinViewer.loadSkin(window.lastLoadedSkinUrl, { model: select.value });
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
            const img = new Image();
            img.onload = () => {
                if (img.width !== 64 || (img.height !== 64 && img.height !== 32)) {
                    if (window.showToast) window.showToast("Erreur: Le fichier doit Ãªtre une image de Skin Minecraft valide (64x64 pixels).", "error");
                    return;
                }
                if (fullscreenSkinViewer) {
                    const currentModel = document.getElementById("skin-variant-select") ? document.getElementById("skin-variant-select").value : "classic";
                    window.lastLoadedSkinUrl = e.target.result;
                    fullscreenSkinViewer.loadSkin(e.target.result, { model: currentModel });
                    if (window.showToast) window.showToast(window.t("msg_skin_preview", "Skin chargé dans le visualiseur !"), "info");
                }
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
        input.value = "";
    };
    window.exportSkin = async () => {
        if (store.uiSelectedAccRow === null) return;
        const acc = store.allAccounts[store.uiSelectedAccRow];
        const urlToExport = window.lastLoadedSkinUrl;
        if (!urlToExport) return;
        try {
            let finalUrl = urlToExport;
            if (!urlToExport.startsWith("data:")) {
                const res = await fetch(urlToExport);
                if (!res.ok) throw new Error("Impossible de récupérer le skin");
                const blob = await res.blob();
                finalUrl = URL.createObjectURL(blob);
            }
            const a = document.createElement("a");
            a.href = finalUrl;
            a.download = `${acc.name}_skin.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (!urlToExport.startsWith("data:")) {
                URL.revokeObjectURL(finalUrl);
            }
            if (window.showToast) window.showToast(window.t("msg_skin_exported", "Skin exporté avec succès !"), "success");
        } catch (e) {
            console.error(e);
            if (window.showToast) window.showToast(window.t("msg_err_skin_export", "Erreur lors de l'exportation du skin."), "error");
        }
    };
    window.uploadSkinToMojang = async (input) => {
        const file = input.files[0];
        if (!file) return;
        if (store.uiSelectedAccRow === null) return;
        const acc = store.allAccounts[store.uiSelectedAccRow];
        if (acc.type !== "microsoft" || !acc.mclcAuth) {
            if (window.showToast) window.showToast(window.t("msg_err_invalid_acc", "Compte invalide."), "error");
            return;
        }
        const variant = document.getElementById("skin-variant-select").value || "classic";
        if (window.showToast) window.showToast(window.t("msg_skin_uploading", "Envoi vers Mojang en cours..."), "info");
        try {
            const refreshRes = await window.api.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
            if (refreshRes.success && refreshRes.access_token) {
                acc.mclcAuth.access_token = refreshRes.access_token;
                await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
            }
            const skinData = await file.arrayBuffer();
            const res = await window.api.invoke("upload-mojang-skin", {
                accessToken: acc.mclcAuth.access_token,
                skinData: skinData,
                variant: variant
            });
            if (res.success) {
                if (window.showToast) window.showToast(window.t("msg_skin_uploaded", "Skin mis à jour avec succès sur Mojang !"), "success");
                try {
                const { faceB64, fullSkinB64 } = await new Promise((resolve) => {
                    const img = new Image();
                    let fullSkin = null;
                    img.onload = () => {
                        const canvas = document.createElement("canvas");
                        canvas.width = 32;
                        canvas.height = 32;
                        const ctx = canvas.getContext("2d");
                        ctx.imageSmoothingEnabled = false;
                        ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 32, 32);
                        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 32, 32);
                        resolve({ faceB64: canvas.toDataURL("image/png"), fullSkinB64: fullSkin });
                    };
                    img.onerror = () => resolve({ faceB64: null, fullSkinB64: null });
                    const reader = new FileReader();
                    reader.onload = (e) => { 
                        fullSkin = e.target.result;
                        img.src = fullSkin; 
                    };
                    reader.readAsDataURL(file);
                });
                
                if (fullSkinB64) saveCustomSkin(acc.name, fullSkinB64);
                if (faceB64) saveSkin(acc.name, faceB64);
            } catch (err) { console.warn("Face extraction error:", err); }
                if (window.updateAccountDropdown) window.updateAccountDropdown();
                if (window.renderAccountManager) window.renderAccountManager();
                setTimeout(() => window.openSkinModal(), 1000);
            } else {
                if (window.showToast) window.showToast(t("msg_err_skin_upload", "Erreur: ") + res.error, "error");
            }
        } catch (e) {
            if (window.showToast) window.showToast("Erreur: " + e.message, "error");
        }
        input.value = "";
    };
}