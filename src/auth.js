import { store } from "./store.js";
const ipcRenderer = window.api;
const shell = window.api.shell;
const clipboard = window.api.clipboard;
let isLoginSessionActive = false;
let _msDeviceVerificationUri = "";
let _msDeviceUserCode = "";
let _msDeviceFinalizeHintTimer = null;
function openMicrosoftDeviceModal(data) {
  _msDeviceVerificationUri = data.verification_uri || data.verificationUri || "https://microsoft.com/link";
  _msDeviceUserCode = data.user_code || data.userCode || "";
  const helpEl = document.getElementById("ms-device-help");
  if (helpEl) helpEl.textContent = t("ms_device_help", "Copie le code ci-dessous, ouvre la page Microsoft, puis saisis le code quand le site le demande.");
  const codeEl = document.getElementById("ms-device-code-display");
  if (codeEl) codeEl.textContent = _msDeviceUserCode;
  const statusEl = document.getElementById("ms-device-status");
  if (statusEl) statusEl.textContent = t("ms_device_status_1", "En attente...");
  const footerEl = document.getElementById("ms-device-footer-note");
  if (footerEl) footerEl.textContent = t("ms_device_footer", "");
  const modal = document.getElementById("modal-ms-device");
  if (modal) modal.style.display = "flex";
  if (_msDeviceFinalizeHintTimer) clearTimeout(_msDeviceFinalizeHintTimer);
  _msDeviceFinalizeHintTimer = setTimeout(() => {
    const modalCheck = document.getElementById("modal-ms-device");
    const statusCheck = document.getElementById("ms-device-status");
    if (modalCheck && modalCheck.style.display === "flex" && statusCheck) {
      statusCheck.textContent = t("ms_device_status_2", "Finalisation...");
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
      if (!isLoginSessionActive && !window._msLoginSessionActive) return;
      openMicrosoftDeviceModal(data);
    });
    window.copyMsDeviceCode = () => {
      const code = _msDeviceUserCode;
      if (!code) return;
      try {
        clipboard.writeText(code);
        if (window.showToast) window.showToast(t("ms_device_copied", "Code copié dans le presse-papiers."), "success");
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
      window.api.send("cancel-login-microsoft");
      closeMicrosoftDeviceModal();
    };
window.loginMicrosoft = async () => {
      const btn = document.getElementById("btn-ms-login");
      if (!btn) return;
      const originalText = btn.innerText;
      btn.innerText = t("msg_conn_ms", "Connexion...");
      btn.disabled = true;
      isLoginSessionActive = true;
const msModal = document.getElementById("modal-ms-device");
      if (msModal) {
          document.getElementById("ms-device-code-display").innerHTML = `<span style="color: #aaa; font-size: 1rem; letter-spacing: normal; font-weight: normal;">${t("msg_ms_generating_code", "⏳ Génération du code...")}</span>`;
          document.getElementById("ms-device-status").innerText = t("msg_conn_ms", "Connexion...");
          msModal.style.display = "flex";
      }
      try {
        const result = await ipcRenderer.invoke("login-microsoft");
if (result.success) {
          const existingIdx = store.allAccounts.findIndex(a => a.uuid === result.auth.uuid);
          if (existingIdx !== -1) {
              store.allAccounts[existingIdx].mclcAuth = result.auth;
              store.allAccounts[existingIdx].name = result.auth.name;
              store.selectedAccountIdx = existingIdx;
          } else {
              store.allAccounts.push({
                type: "microsoft",
                name: result.auth.name,
                uuid: result.auth.uuid,
                mclcAuth: result.auth,
              });
              store.selectedAccountIdx = store.allAccounts.length - 1;
          }
          store.uiSelectedAccRow = store.selectedAccountIdx;
          await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
          if(window.renderAccountManager) window.renderAccountManager();
          if(window.updateAccountDropdown) window.updateAccountDropdown(); 
          if(window.closeAccountModal) window.closeAccountModal();
          if(window.showToast) window.showToast(t("msg_login_success", "Connexion réussie !"), "success");
          if(window.checkAchievement) window.checkAchievement("vip");
        } else if (result.cancelled) {
          if(window.showToast) window.showToast(t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
        } else {
          let errMsg = result.error || "";
          if (result.errorCode === "ERR_AUTH_RUNNING") {
            errMsg = t("msg_err_auth_running", "Une connexion Microsoft est déjà en cours.");
          } else if (result.errorCode === "ERR_NO_MC_TOKEN") {
            errMsg = t("msg_err_no_mc_token", "Jeton Minecraft introuvable. Vérifiez que le compte possède Minecraft Java.");
          } else if (result.errorCode === "ERR_NO_MC_PROFILE") {
            errMsg = t("msg_err_no_mc_profile", "Aucun profil Minecraft trouvé sur ce compte. Lancez le launcher officiel au moins une fois.");
          }
          if(window.showToast) window.showToast(t("msg_err_ms", "Erreur Microsoft : ") + errMsg, "error");
        }
} catch (e) {
        if (window.showToast) window.showToast(t("msg_err_sys", "Erreur système : ") + e, "error");
      } finally {
        isLoginSessionActive = false;
        closeMicrosoftDeviceModal();
        btn.innerText = originalText;
        btn.disabled = false;
      }
    };
}