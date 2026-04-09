import { store } from "./store.js";

const ipcRenderer = window.api;
const shell = window.api.shell;
const clipboard = window.api.clipboard;
const fs = window.api.fs;

function t(key, fallback) {
  return store.currentLangObj[key] || fallback;
}

let _msDeviceVerificationUri = "";
let _msDeviceUserCode = "";
let _msDeviceFinalizeHintTimer = null;

function applyMsDeviceModalI18n() {
  const titleEl = document.querySelector("#modal-ms-device .modal-header");
  if (titleEl) titleEl.textContent = t("ms_device_title", "Connexion Microsoft");
  const copyBtn = document.getElementById("ms-device-btn-copy");
  if (copyBtn) copyBtn.textContent = t("ms_device_copy", "Copier le code");
  const openBtn = document.getElementById("ms-device-btn-open");
  if (openBtn) openBtn.textContent = t("ms_device_open", "Ouvrir la page Microsoft");
  const cancelBtn = document.getElementById("ms-device-btn-cancel");
  if (cancelBtn) cancelBtn.textContent = t("ms_device_cancel", "Annuler");
}

function openMicrosoftDeviceModal(data) {
  _msDeviceVerificationUri = data.verification_uri || "";
  _msDeviceUserCode = data.user_code || "";
  
  applyMsDeviceModalI18n();
  const helpEl = document.getElementById("ms-device-help");
  if (helpEl) helpEl.textContent = t("ms_device_help", "Copie le code…");
  
  const codeEl = document.getElementById("ms-device-code-display");
  if (codeEl) codeEl.textContent = _msDeviceUserCode;
  
  const statusEl = document.getElementById("ms-device-status");
  if (statusEl) statusEl.textContent = t("ms_device_status_1", "En attente…");
  
  const footerEl = document.getElementById("ms-device-footer-note");
  if (footerEl) footerEl.textContent = t("ms_device_footer", "");
  
  const modal = document.getElementById("modal-ms-device");
  if (modal) modal.style.display = "flex";
  
  if (_msDeviceFinalizeHintTimer) clearTimeout(_msDeviceFinalizeHintTimer);
  _msDeviceFinalizeHintTimer = setTimeout(() => {
    const modalCheck = document.getElementById("modal-ms-device");
    const statusCheck = document.getElementById("ms-device-status");
    if (modalCheck && modalCheck.style.display === "flex" && statusCheck) {
      statusCheck.textContent = t("ms_device_status_2", "Finalisation…");
    }
  }, 7000);
}

function closeMicrosoftDeviceModal() {
  const modal = document.getElementById("modal-ms-device");
  if (modal) modal.style.display = "none";
  
  if (_msDeviceFinalizeHintTimer) {
    clearTimeout(_msDeviceFinalizeHintTimer);
    _msDeviceFinalizeHintTimer = null;
  }
  _msDeviceVerificationUri = "";
  _msDeviceUserCode = "";
}

export function setupAuth() {
    
    ipcRenderer.on("microsoft-device-code", (data) => {
      if (!window._msLoginSessionActive) return;
      openMicrosoftDeviceModal(data);
    });

    window.copyMsDeviceCode = () => {
      const code = _msDeviceUserCode;
      if (!code) return;
      try {
        clipboard.writeText(code);
        if (window.showToast) window.showToast(t("ms_device_copied", "Code copié."), "success");
      } catch {
        if (window.showToast) window.showToast(t("msg_err_sys", "Erreur : ") + "clipboard", "error");
      }
    };

    window.openMsDevicePage = () => {
      const uri = _msDeviceVerificationUri;
      const code = _msDeviceUserCode;
      if (uri && /^https?:\/\//i.test(uri)) shell.openExternal(uri);
      else if (code) shell.openExternal(`https://www.microsoft.com/link?otc=${encodeURIComponent(code)}`);
    };

    window.cancelMsDeviceLogin = () => {
      ipcRenderer.send("cancel-login-microsoft");
      closeMicrosoftDeviceModal();
    };

    window.loginMicrosoft = async () => {
      const btn = document.getElementById("btn-ms-login");
      if (!btn) return;
      
      const originalText = btn.innerText;
      btn.innerText = t("msg_conn_ms", "Connexion...");
      btn.disabled = true;
      window._msLoginSessionActive = true;

      // AUCUNE BARRE DE CHARGEMENT APPELÉE ICI. EXACTEMENT COMME LA VERSION FONCTIONNELLE.

      try {
        const result = await ipcRenderer.invoke("login-microsoft");

        if (result.success) {
          store.allAccounts.push({
            type: "microsoft",
            name: result.auth.name,
            uuid: result.auth.uuid,
            mclcAuth: result.auth,
          });
          store.selectedAccountIdx = store.allAccounts.length - 1;
          store.uiSelectedAccRow = store.selectedAccountIdx;
          
          fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
          
          if(window.renderAccountManager) window.renderAccountManager();
          if(window.changeAccountFromCode) window.changeAccountFromCode();
          if(window.closeAccountModal) window.closeAccountModal();
          if(window.updateAccountDropdown) window.updateAccountDropdown(); 
          
          if(window.showToast) window.showToast(t("msg_login_success", "Connexion réussie !"), "success");
        } else if (result.cancelled) {
          if(window.showToast) window.showToast(t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
        } else {
          if(window.showToast) window.showToast(t("msg_err_ms", "Erreur Microsoft : ") + result.error, "error");
        }
      } catch (e) {
        if (window.showToast) window.showToast(t("msg_err_sys", "Erreur système : ") + e, "error");
      } finally {
        window._msLoginSessionActive = false;
        closeMicrosoftDeviceModal();
        btn.innerText = originalText;
        btn.disabled = false;
      }
    };

    window.deleteAccount = async (index) => {
      if (await window.showCustomConfirm(t("msg_remove_acc", "Retirer ce compte ?"), true)) {
        store.allAccounts.splice(index, 1);
        if (store.selectedAccountIdx === index)
          store.selectedAccountIdx = store.allAccounts.length > 0 ? 0 : null;
        else if (store.selectedAccountIdx > index) store.selectedAccountIdx--;
        
        fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
        
        if(window.renderAccountManager) window.renderAccountManager();
        if(window.changeAccountFromCode) window.changeAccountFromCode();
        if(window.updateAccountDropdown) window.updateAccountDropdown(); 
      }
    };
}