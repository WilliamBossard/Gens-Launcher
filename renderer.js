const { ipcRenderer } = require("electron");
const { Client } = require("minecraft-launcher-core");
const { shell } = require("electron");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");
const DiscordRPC = require("discord-rpc");
const crypto = require("crypto");
const nbt = require("prismarine-nbt");
const util = require("util");
const parseNbt = util.promisify(nbt.parse);

window.openSystemPath = (p) => shell.openPath(p);
const launcher = new Client();
const discordClientId = "1223633633633633633";

let rpc = new DiscordRPC.Client({ transport: "ipc" });
let rpcReady = false;
let pingInterval = null;
let collapsedGroups = {};
let maxSafeRam = 4096;

rpc
  .login({ clientId: discordClientId })
  .then(() => {
    rpcReady = true;
  })
  .catch(() => {});

function updateRPC(details, state) {
  if (!rpcReady) return;
  try {
    rpc.setActivity({
      details,
      state,
      startTimestamp: new Date(),
      largeImageKey: "logo",
      largeImageText: "Gens Launcher",
      instance: false,
    });
  } catch (e) {}
}
function clearRPC() {
  if (!rpcReady) return;
  try {
    rpc.clearActivity();
  } catch (e) {}
}

// --- SYSTEME DE TOASTS ---
window.showToast = (msg, type = "info") => {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
};

ipcRenderer.on("update-msg", (event, data) => {
  showToast(data.text, data.type);
});

ipcRenderer.on("update-downloaded", async () => {
  if (
    await showCustomConfirm(
      t(
        "msg_update_ready",
        "Une nouvelle mise à jour est prête ! Voulez-vous redémarrer le launcher pour l'installer maintenant ?",
      ),
      false,
    )
  ) {
    ipcRenderer.send("restart_app");
  }
});

window.showCustomConfirm = (msg, isDestructive = false) => {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-confirm");
    document.getElementById("confirm-message").innerText = msg;
    const yesBtn = document.getElementById("confirm-yes");
    yesBtn.style.background = isDestructive ? "#f87171" : "var(--accent)";
    yesBtn.style.borderColor = isDestructive ? "#f87171" : "var(--accent)";
    modal.style.display = "flex";

    const newYes = yesBtn.cloneNode(true);
    const newNo = document.getElementById("confirm-no").cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    document
      .getElementById("confirm-no")
      .parentNode.replaceChild(newNo, document.getElementById("confirm-no"));

    newYes.addEventListener("click", () => {
      modal.style.display = "none";
      resolve(true);
    });
    newNo.addEventListener("click", () => {
      modal.style.display = "none";
      resolve(false);
    });
  });
};

function showLoading(text) {
  document.getElementById("loading-text").innerText = text;
  document.getElementById("loading-overlay").style.display = "flex";
}
function hideLoading() {
  document.getElementById("loading-overlay").style.display = "none";
}
const yieldUI = () => new Promise((resolve) => setTimeout(resolve, 50));

const dataDir = path.join(process.env.APPDATA, "GensLauncher");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const logsDir = path.join(dataDir, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const oldLogs = fs
  .readdirSync(logsDir)
  .filter((f) => f.endsWith(".log"))
  .map((f) => ({
    file: f,
    time: fs.statSync(path.join(logsDir, f)).mtime.getTime(),
  }))
  .sort((a, b) => b.time - a.time);
if (oldLogs.length > 4) {
  for (let i = 4; i < oldLogs.length; i++)
    fs.unlinkSync(path.join(logsDir, oldLogs[i].file));
}
const currentLogFile = path.join(
  logsDir,
  `launcher_${new Date().toISOString().replace(/[:\.]/g, "-")}.log`,
);
fs.writeFileSync(
  currentLogFile,
  `=== Gens Launcher Log - ${new Date().toLocaleString()} ===\n`,
);

function sysLog(msg, isError = false) {
  const line = `[${new Date().toLocaleTimeString()}] ${isError ? "ERROR" : "INFO"}: ${msg}\n`;
  fs.appendFileSync(currentLogFile, line);
}

window.copyLogs = () => {
  const text = document.getElementById("log-output").innerText;
  navigator.clipboard
    .writeText(text)
    .then(() =>
      showToast(
        t("msg_logs_copied", "Logs copiés dans le presse-papier !"),
        "success",
      ),
    );
};

const instanceFile = path.join(dataDir, "instances.json");
const accountFile = path.join(dataDir, "accounts.json");
const settingsFile = path.join(dataDir, "settings.json");
const instancesRoot = path.join(dataDir, "instances");
if (!fs.existsSync(instancesRoot))
  fs.mkdirSync(instancesRoot, { recursive: true });

const langDir = path.join(dataDir, "lang");
if (!fs.existsSync(langDir)) fs.mkdirSync(langDir, { recursive: true });

const defaultFr = {
  toolbar_add: "Ajouter une instance",
  toolbar_import: "Importer",
  toolbar_catalog: "Catalogue de Contenu",
  toolbar_settings: "Paramètres Globaux",
  toolbar_logs: "Afficher les logs",
  toolbar_manage: "Gérer",
  toolbar_stats: "Statistiques",
  search_inst: "Rechercher une instance...",
  sort_name: "Trier par Nom",
  sort_last: "Dernière utilisation",
  sort_time: "Temps de jeu",
  panel_title: "Sélectionnez une instance",
  panel_time: "Temps :",
  panel_last: "Dernier :",
  btn_launch: "Lancer",
  btn_stop: "Forcer l'arrêt",
  btn_offline: "Lancer en hors ligne",
  btn_settings: "Paramètres de l'instance",
  btn_mods: "Gestionnaire de Mods",
  btn_saves: "Voir les mondes",
  btn_gallery: "Galerie de Captures",
  btn_folder: "Dossier de l'instance",
  btn_delete: "Supprimer",
  btn_copy: "Copier l'instance",
  btn_export: "Exporter l'instance",
  status_ready: "Prêt",
  modal_cancel: "Annuler",
  modal_save: "Sauvegarder",
  modal_close: "Fermer",
  modal_apply: "Appliquer",
  modal_create: "Créer",
  modal_add: "Ajouter",
  btn_search: "Chercher",
  tab_gen: "Général",
  tab_mods: "Mods",
  tab_shaders: "Shaders",
  tab_resourcepacks: "Packs de Textures",
  tab_servers: "Serveurs",
  tab_backups: "Sauvegardes",
  tab_java: "Configuration",
  tab_notes: "Notes",
  lbl_backup_mode: "Sauvegarde Automatique des Mondes",
  lbl_backup_limit: "Nombre de sauvegardes à conserver :",
  opt_none: "Désactivé",
  opt_launch: "Au lancement du jeu",
  opt_close: "À la fermeture du jeu",
  txt_backup_desc:
    "Le launcher conservera automatiquement vos sauvegardes dans le dossier 'backups'.",
  btn_open_backups: "Ouvrir le dossier des sauvegardes",
  lbl_lang: "Langue du Launcher",
  lbl_ram: "Mémoire RAM (Mo) :",
  lbl_java: "Chemin Java par défaut",
  btn_scan: "Scanner",
  lbl_fav_server: "Serveur favori",
  lbl_beta: "Afficher les Bêtas",
  lbl_loader: "Type de chargeur",
  lbl_inst_name: "Nom de l'instance",
  lbl_installed_mods: "Vos Mods Installés",
  lbl_installed_shaders: "Vos Shaders",
  lbl_installed_rps: "Vos Packs de Textures",
  btn_check_updates: "Vérifier les MAJ",
  btn_dl_mods: "Télécharger de nouveaux mods",
  lbl_width: "Largeur",
  lbl_height: "Hauteur",
  lbl_jvm: "Arguments JVM",
  lbl_offline: "Ajouter un profil Hors-Ligne",
  tab_appearance: "Apparence",
  lbl_accent: "Couleur Principale",
  lbl_bg: "Image de fond",
  btn_browse: "Parcourir",
  btn_clear: "Effacer",
  lbl_blur: "Flou du fond",
  lbl_darkness: "Assombrissement du fond",
  lbl_group: "Dossier / Catégorie de l'instance",
  msg_mod_added: "Ajouté à l'instance avec succès !",
  msg_select_inst: "Sélectionnez une instance d'abord !",
  msg_search_java: "Recherche de Java...",
  msg_java_found: "version(s) de Java trouvée(s).",
  msg_dl_java: "Téléchargement de Java 21...",
  msg_extract_java: "Extraction de Java 21...",
  msg_err_java: "Erreur Java",
  msg_backup: "Création de la sauvegarde...",
  msg_no_screen: "Aucune capture d'écran.",
  msg_launching: "Lancement de ",
  msg_check_java: "Vérification de Java...",
  msg_java_not_found:
    "Java introuvable ! Voulez-vous installer automatiquement Java 21 ?",
  msg_sync_servers: "Synchronisation des serveurs...",
  msg_install_fabric: "Installation de Fabric...",
  msg_prep_files: "Préparation des fichiers...",
  msg_dl: "Téléchargement : ",
  msg_game_stop: "Le jeu s'est arrêté",
  msg_conn_ms: "Connexion...",
  msg_err_ms: "Erreur Microsoft : ",
  msg_err_sys: "Erreur système : ",
  msg_remove_acc: "Retirer ce compte ?",
  msg_copy: "Copie en cours...",
  msg_delete_inst: "Supprimer l'instance ?",
  msg_compress: "Compression...",
  msg_extract: "Extraction...",
  msg_check_updates: "Vérification des mises à jour...",
  msg_updating: "Mise à jour : ",
  msg_mods_updated: "mod(s) mis à jour !",
  msg_mods_uptodate: "Mods déjà à jour !",
  msg_dl_mod: "Téléchargement en cours...",
  msg_no_compat: "Aucun fichier compatible.",
  msg_deps: "Téléchargement des dépendances...",
  msg_install_success: "Installation réussie !",
  msg_err_dl: "Erreur lors du téléchargement.",
  msg_ping: "Ping...",
  msg_online: "En ligne",
  msg_offline: "Hors-ligne",
  msg_err_ping: "Erreur",
  msg_no_mods: "Aucun mod local installé.",
  msg_no_shaders: "Aucun shader installé.",
  msg_no_rps: "Aucun pack de textures installé.",
  msg_no_servers: "Aucun serveur enregistré.",
  msg_no_acc: "Aucun profil enregistré.",
  opt_modpack: "Modpacks",
  btn_install: "Installer",
  msg_dl_mods_pack: "Téléchargement des mods",
  msg_logs_copied: "Logs copiés dans le presse-papier !",
  msg_err_mrpack_invalid:
    "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant).",
  msg_err_mrpack: "Erreur Modpack : ",
  btn_copy_logs: "Copier",
  modal_confirm: "Confirmation",
  btn_yes: "Oui",
  btn_no: "Non",
  msg_err_cf:
    "Les modpacks CurseForge (.zip) sont bloqués par Overwolf. Cherchez la version Modrinth (.mrpack) dans le catalogue !",
  msg_err_path: "Erreur : Chemin introuvable (Lancez l'app via npm start !)",
  msg_err_format: "Format non supporté ! (.mrpack, .zip, .jar, .png)",
  modal_worlds_title: "Gestion des Mondes",
  msg_no_worlds: "Aucun monde trouvé.",
  btn_world_backup: "Sauvegarder",
  btn_world_copy: "Copier",
  msg_copy_world_loading: "Copie du monde en cours...",
  msg_world_copied: "Monde copié avec succès !",
  msg_delete_world_confirm:
    "Voulez-vous vraiment supprimer ce monde définitivement ?",
  msg_world_deleted: "Monde supprimé !",
  msg_world_backedup: "Sauvegarde créée dans le dossier 'backups' !",
  lbl_folder: "Dossier : ",
  lbl_created: "Créé le : ",
  lbl_played: "Joué le : ",
  modal_stats_title: "Tableau de Bord",
  stat_total_time: "Temps de jeu total",
  stat_total_instances: "Instances créées",
  stat_total_mods: "Mods installés",
  stat_fav_instance: "Instance favorite : ",
  stat_disk_usage: "Espace disque utilisé",
  txt_players: "Joueurs",
  msg_update_ready:
    "Une nouvelle mise à jour est prête ! Voulez-vous redémarrer le launcher pour l'installer maintenant ?",
};

const defaultEn = {
  toolbar_add: "Add Instance",
  toolbar_import: "Import",
  toolbar_catalog: "Content Catalog",
  toolbar_settings: "Global Settings",
  toolbar_logs: "Show Logs",
  toolbar_manage: "Manage",
  toolbar_stats: "Statistics",
  search_inst: "Search instance...",
  sort_name: "Sort by Name",
  sort_last: "Last Played",
  sort_time: "Play Time",
  panel_title: "Select an instance",
  panel_time: "Time:",
  panel_last: "Last:",
  btn_launch: "Play",
  btn_stop: "Force Stop",
  btn_offline: "Play Offline",
  btn_settings: "Instance Settings",
  btn_mods: "Mods Manager",
  btn_saves: "View Worlds",
  btn_gallery: "Screenshots Gallery",
  btn_folder: "Instance Folder",
  btn_delete: "Delete",
  btn_copy: "Copy Instance",
  btn_export: "Export Instance",
  status_ready: "Ready",
  modal_cancel: "Cancel",
  modal_save: "Save",
  modal_close: "Close",
  modal_apply: "Apply",
  modal_create: "Create",
  modal_add: "Add",
  btn_search: "Search",
  tab_gen: "General",
  tab_mods: "Mods",
  tab_shaders: "Shaders",
  tab_resourcepacks: "Resource Packs",
  tab_servers: "Servers",
  tab_backups: "Backups",
  tab_java: "Configuration",
  tab_notes: "Notes",
  lbl_backup_mode: "World Auto-Backups",
  lbl_backup_limit: "Number of backups to keep:",
  opt_none: "Disabled",
  opt_launch: "On game launch",
  opt_close: "On game close",
  txt_backup_desc:
    "The launcher will automatically keep your latest backups in the 'backups' folder.",
  btn_open_backups: "Open Backups Folder",
  lbl_lang: "Launcher Language",
  lbl_ram: "Allocated RAM (MB):",
  lbl_java: "Default Java Path",
  btn_scan: "Scan",
  lbl_fav_server: "Favorite Server",
  lbl_beta: "Show Betas",
  lbl_loader: "Loader Type",
  lbl_inst_name: "Instance Name",
  lbl_installed_mods: "Installed Mods",
  lbl_installed_shaders: "Your Shaders",
  lbl_installed_rps: "Your Resource Packs",
  btn_check_updates: "Check for Updates",
  btn_dl_mods: "Download new mods",
  lbl_width: "Width",
  lbl_height: "Height",
  lbl_jvm: "JVM Arguments",
  lbl_offline: "Add Offline Profile",
  tab_appearance: "Appearance",
  lbl_accent: "Accent Color",
  lbl_bg: "Background Image",
  btn_browse: "Browse",
  btn_clear: "Clear",
  lbl_blur: "Background Blur",
  lbl_darkness: "Background Darkness",
  lbl_group: "Instance Folder / Category",
  msg_mod_added: "Successfully added to the instance!",
  msg_select_inst: "Please select an instance first!",
  msg_search_java: "Searching for Java...",
  msg_java_found: "Java version(s) found.",
  msg_dl_java: "Downloading Java 21...",
  msg_extract_java: "Extracting Java 21...",
  msg_err_java: "Java Error",
  msg_backup: "Creating backup...",
  msg_no_screen: "No screenshots.",
  msg_launching: "Launching ",
  msg_check_java: "Verifying Java...",
  msg_java_not_found:
    "Java not found! Do you want to automatically install Java 21?",
  msg_sync_servers: "Synchronizing servers...",
  msg_install_fabric: "Installing Fabric...",
  msg_prep_files: "Preparing files...",
  msg_dl: "Downloading: ",
  msg_game_stop: "Game stopped",
  msg_conn_ms: "Logging in...",
  msg_err_ms: "Microsoft Error: ",
  msg_err_sys: "System Error: ",
  msg_remove_acc: "Remove this account?",
  msg_copy: "Copying...",
  msg_delete_inst: "Delete instance?",
  msg_compress: "Compressing...",
  msg_extract: "Extracting...",
  msg_check_updates: "Checking for updates...",
  msg_updating: "Updating: ",
  msg_mods_updated: "mod(s) updated!",
  msg_mods_uptodate: "Mods already up to date!",
  msg_dl_mod: "Downloading...",
  msg_no_compat: "No compatible file.",
  msg_deps: "Downloading dependencies...",
  msg_install_success: "Installation successful!",
  msg_err_dl: "Download error.",
  msg_ping: "Ping...",
  msg_online: "Online",
  msg_offline: "Offline",
  msg_err_ping: "Error",
  msg_no_mods: "No local mods installed.",
  msg_no_shaders: "No shaders installed.",
  msg_no_rps: "No resource packs installed.",
  msg_no_servers: "No saved servers.",
  msg_no_acc: "No profiles saved.",
  opt_modpack: "Modpacks",
  btn_install: "Install",
  msg_dl_mods_pack: "Downloading mods",
  msg_logs_copied: "Logs copied to clipboard!",
  msg_err_mrpack_invalid: "Not a valid .mrpack file.",
  msg_err_mrpack: "Modpack Error: ",
  btn_copy_logs: "Copy",
  modal_confirm: "Confirmation",
  btn_yes: "Yes",
  btn_no: "No",
  msg_err_cf:
    "CurseForge (.zip) modpacks are blocked by Overwolf restrictions. Use Modrinth (.mrpack) instead!",
  msg_err_path: "Error: Path not found (Run the app via npm start!)",
  msg_err_format: "Unsupported format! (.mrpack, .zip, .jar, .png)",
  modal_worlds_title: "Worlds Manager",
  msg_no_worlds: "No worlds found.",
  btn_world_backup: "Backup",
  btn_world_copy: "Copy",
  msg_copy_world_loading: "Copying world...",
  msg_world_copied: "World copied successfully!",
  msg_delete_world_confirm:
    "Are you sure you want to permanently delete this world?",
  msg_world_deleted: "World deleted!",
  msg_world_backedup: "Backup created in 'backups' folder!",
  lbl_folder: "Folder: ",
  lbl_created: "Created on: ",
  lbl_played: "Last played: ",
  modal_stats_title: "Dashboard",
  stat_total_time: "Total playtime",
  stat_total_instances: "Instances created",
  stat_total_mods: "Mods installed",
  stat_fav_instance: "Favorite instance: ",
  stat_disk_usage: "Disk space used",
  txt_players: "Players",
  msg_update_ready:
    "A new update is ready! Do you want to restart the launcher to install it now?",
};

function syncLangFile(filePath, defaultObj) {
  let current = {};
  if (fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath));
    } catch (e) {}
  }
  let updated = false;
  for (let key in defaultObj) {
    if (current[key] === undefined) {
      current[key] = defaultObj[key];
      updated = true;
    }
  }
  if (updated || !fs.existsSync(filePath))
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
}

syncLangFile(path.join(langDir, "fr.json"), defaultFr);
syncLangFile(path.join(langDir, "en.json"), defaultEn);

let currentLangObj = {};
function t(key, fallback) {
  return currentLangObj[key] || fallback;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (currentLangObj[key]) {
      if (el.tagName === "INPUT" && el.type === "text")
        el.placeholder = currentLangObj[key];
      else el.innerText = currentLangObj[key];
    }
  });
  updateLaunchButton();
}

function loadLanguage(code) {
  const p = path.join(langDir, `${code}.json`);
  if (fs.existsSync(p)) {
    currentLangObj = JSON.parse(fs.readFileSync(p));
    applyTranslations();
  }
}

window.changeLanguage = (code) => {
  globalSettings.language = code;
  fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
  loadLanguage(code);
};

window.saveFirstLaunch = () => {
  const code = document.getElementById("first-launch-lang").value;
  globalSettings.language = code;
  fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
  loadLanguage(code);
  document.getElementById("modal-first-launch").style.display = "none";
};

function populateLangDropdown() {
  const select = document.getElementById("global-lang");
  select.innerHTML = "";
  fs.readdirSync(langDir)
    .filter((f) => f.endsWith(".json"))
    .forEach((f) => {
      const code = f.replace(".json", "");
      const opt = document.createElement("option");
      opt.value = code;
      opt.innerText = code.toUpperCase();
      if (code === globalSettings.language) opt.selected = true;
      select.appendChild(opt);
    });
}

function applyTheme() {
  const root = document.documentElement;
  const th = globalSettings.theme || {
    accent: "#007acc",
    bg: "",
    dim: 0.5,
    blur: 5,
  };
  root.style.setProperty("--accent", th.accent);

  const appBg = document.getElementById("app-background");
  if (th.bg && fs.existsSync(th.bg)) {
    appBg.style.backgroundImage = `url("file:///${th.bg.replace(/\\/g, "/")}")`;
    appBg.style.filter = `blur(${th.blur}px) brightness(${1 - th.dim})`;
    root.style.setProperty("--bg-main", "rgba(30, 30, 30, 0.45)");
    root.style.setProperty("--bg-panel", "rgba(45, 45, 48, 0.65)");
    root.style.setProperty("--bg-toolbar", "rgba(51, 51, 55, 0.7)");
  } else {
    appBg.style.backgroundImage = "none";
    root.style.setProperty("--bg-main", "#1e1e1e");
    root.style.setProperty("--bg-panel", "#2d2d30");
    root.style.setProperty("--bg-toolbar", "#333337");
  }
}

window.toggleServerDropdown = () => {
  const container = document.getElementById("server-dropdown-container");
  container.classList.toggle("active");
};

document.addEventListener("click", (e) => {
  const container = document.getElementById("server-dropdown-container");
  if (container && !container.contains(e.target)) {
    container.classList.remove("active");
  }
});

window.checkServerStatus = async () => {
  const ip = globalSettings.serverIp;
  const container = document.getElementById("server-dropdown-container");
  const content = document.getElementById("server-status-content");
  const btn = document.getElementById("btn-server-indicator");

  if (!ip) {
    container.style.display = "none";
    return;
  }
  container.style.display = "inline-block";

  if (content.innerHTML === "") {
    btn.innerHTML = `📡 <span style="color:#aaa;">${t("msg_ping", "Ping...")}</span>`;
    content.innerHTML = `<div style="text-align:center; color:#aaa;">Recherche...</div>`;
  }

  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${ip}`);
    const data = await res.json();
    const formatNum = (n) =>
      n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n;

    if (data.online) {
      btn.innerHTML = `🟢 <span style="font-weight:bold;">${formatNum(data.players.online)}</span>`;
      content.innerHTML = `
            <div style="font-weight:bold; color:var(--text-light); text-align:center; margin-bottom:5px;">${ip}</div>
            <div style="display:flex; justify-content:space-between; font-size:0.8rem;">
                <span style="color:#aaa;">Statut:</span> <span style="color:#17B139; font-weight:bold;">${t("msg_online", "En ligne")}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.8rem;">
                <span style="color:#aaa;">${t("txt_players", "Joueurs")}:</span> <span style="color:var(--text-light);">${formatNum(data.players.online)} / ${formatNum(data.players.max)}</span>
            </div>
        `;
    } else {
      btn.innerHTML = `🔴 <span style="color:#f87171;">${t("msg_offline", "Hors-ligne")}</span>`;
      content.innerHTML = `<div style="font-weight:bold; color:var(--text-light); text-align:center;">${ip}</div><div style="text-align:center; color:#f87171; font-size:0.8rem; margin-top:5px;">Le serveur est hors-ligne.</div>`;
    }
  } catch (e) {
    btn.innerHTML = `🔴 <span style="color:#f87171;">${t("msg_err_ping", "Erreur")}</span>`;
    content.innerHTML = `<div style="font-weight:bold; color:var(--text-light); text-align:center;">${ip}</div><div style="text-align:center; color:#f87171; font-size:0.8rem; margin-top:5px;">Impossible de joindre le serveur.</div>`;
  }
};

async function getDirSizeAsync(dirPath) {
  let size = 0;
  try {
    const files = await fs.promises.readdir(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) {
        size += await getDirSizeAsync(filePath);
      } else {
        size += stats.size;
      }
    }
  } catch (e) {}
  return size;
}

window.openStatsModal = async () => {
  let totalTimeMs = 0;
  let totalMods = 0;
  let favInstance = "-";
  let maxTime = -1;

  allInstances.forEach((inst) => {
    totalTimeMs += inst.playTime || 0;
    if ((inst.playTime || 0) > maxTime) {
      maxTime = inst.playTime || 0;
      favInstance = inst.name;
    }

    const modsPath = path.join(
      instancesRoot,
      inst.name.replace(/[^a-z0-9]/gi, "_"),
      "mods",
    );
    if (fs.existsSync(modsPath)) {
      totalMods += fs
        .readdirSync(modsPath)
        .filter(
          (f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"),
        ).length;
    }
  });

  let h = Math.floor(totalTimeMs / 3600000);
  let m = Math.floor((totalTimeMs % 3600000) / 60000);

  document.getElementById("dashboard-time").innerText = `${h}h ${m}m`;
  document.getElementById("dashboard-instances").innerText =
    allInstances.length;
  document.getElementById("dashboard-mods").innerText = totalMods;
  document.getElementById("dashboard-fav").innerText =
    maxTime > 0 ? favInstance : "-";
  document.getElementById("dashboard-disk").innerText = "Calcul...";

  document.getElementById("modal-stats").style.display = "flex";

  const sizeBytes = await getDirSizeAsync(dataDir);
  const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
  if (document.getElementById("modal-stats").style.display === "flex") {
    document.getElementById("dashboard-disk").innerText = `${sizeGB} Go`;
  }
};

window.closeStatsModal = () => {
  document.getElementById("modal-stats").style.display = "none";
};

async function handleMrPackImport(packPath) {
  showLoading(t("msg_extract", "Extraction..."));
  await yieldUI();

  try {
    const zip = new AdmZip(packPath);
    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) {
      hideLoading();
      showToast(
        t(
          "msg_err_mrpack_invalid",
          "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant).",
        ),
        "error",
      );
      return;
    }

    const index = JSON.parse(zip.readAsText(indexEntry));
    const packName = index.name || "Modpack Importé";
    const mcVer = index.dependencies.minecraft;

    let loaderType = "vanilla";
    if (index.dependencies["fabric-loader"]) loaderType = "fabric";
    else if (index.dependencies.forge) loaderType = "forge";
    else if (index.dependencies["quilt-loader"]) loaderType = "fabric";

    let finalName = packName;
    let counter = 1;
    while (allInstances.some((i) => i.name === finalName)) {
      finalName = `${packName} (${counter})`;
      counter++;
    }

    const newInst = {
      name: finalName,
      version: mcVer,
      loader: loaderType,
      ram: globalSettings.defaultRam.toString(),
      javaPath: "",
      jvmArgs: "",
      notes: "Modpack: " + packName,
      icon: "",
      resW: "",
      resH: "",
      playTime: 0,
      lastPlayed: 0,
      group: "Modpacks",
      servers: [],
      backupMode: "none",
      backupLimit: 5,
    };

    const instDir = path.join(
      instancesRoot,
      finalName.replace(/[^a-z0-9]/gi, "_"),
    );
    if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

    zip.getEntries().forEach((entry) => {
      if (
        entry.entryName.startsWith("overrides/") &&
        entry.entryName !== "overrides/"
      ) {
        const relPath = entry.entryName.substring(10);
        const targetPath = path.join(instDir, relPath);
        if (entry.isDirectory) {
          if (!fs.existsSync(targetPath))
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
          const dir = path.dirname(targetPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(targetPath, zip.readFile(entry));
        }
      }
      if (
        entry.entryName.startsWith("client-overrides/") &&
        entry.entryName !== "client-overrides/"
      ) {
        const relPath = entry.entryName.substring(17);
        const targetPath = path.join(instDir, relPath);
        if (entry.isDirectory) {
          if (!fs.existsSync(targetPath))
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
          const dir = path.dirname(targetPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(targetPath, zip.readFile(entry));
        }
      }
    });

    const totalFiles = index.files.length;
    for (let i = 0; i < totalFiles; i++) {
      const modFile = index.files[i];
      if (modFile.env && modFile.env.client === "unsupported") continue;

      const modPath = path.join(instDir, modFile.path);
      const dir = path.dirname(modPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      showLoading(
        `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${i + 1}/${totalFiles})...`,
      );
      if (i % 5 === 0) await yieldUI();

      try {
        const res = await fetch(modFile.downloads[0]);
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(modPath, Buffer.from(buffer));
      } catch (e) {
        sysLog(
          `Erreur téléchargement fichier modpack: ${modFile.downloads[0]} - ${e.message}`,
          true,
        );
      }
    }

    allInstances.push(newInst);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    sysLog(`Modpack ${finalName} importé avec succès.`);
    showToast(t("msg_install_success", "Installation réussie !"), "success");
  } catch (err) {
    sysLog("Erreur Modpack : " + err.message, true);
    showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
  }
  hideLoading();
  renderUI();
}

const defaultIcons = {
  vanilla:
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
  forge:
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
  fabric:
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E",
};

let allInstances = [],
  allAccounts = [],
  rawVersions = [];
let globalSettings = {
  defaultRam: 4096,
  defaultJavaPath: "",
  serverIp: "",
  language: null,
  theme: { accent: "#007acc", bg: "", dim: 0.5, blur: 5 },
};
let selectedInstanceIdx = null,
  selectedAccountIdx = null;
let isGameRunning = false;
let sessionStartTime = 0;

document.addEventListener("DOMContentLoaded", () => {
  try {
    document.getElementById("app-version").innerText =
      "v" + require("./package.json").version;
  } catch (e) {}
  init();
});

async function init() {
  const totalRamMB = Math.floor(os.totalmem() / (1024 * 1024));
  maxSafeRam = Math.max(1024, totalRamMB - 2048);
  const ramInputs = [
    "new-ram-input",
    "new-ram-slider",
    "global-ram-input",
    "global-ram-slider",
    "edit-ram-input",
    "edit-ram-slider",
  ];
  ramInputs.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.max = maxSafeRam;
  });

  loadStorage();
  populateLangDropdown();
  applyTheme();

  if (!globalSettings.language)
    document.getElementById("modal-first-launch").style.display = "flex";
  else loadLanguage(globalSettings.language);

  setInterval(checkServerStatus, 60000);
  try {
    const res = await fetch(
      "https://launchermeta.mojang.com/mc/game/version_manifest.json",
    );
    const data = await res.json();
    rawVersions = data.versions;
    updateVersionList(false);
  } catch (e) {}
}

window.updateVersionList = (showSnapshots) => {
  const select1 = document.getElementById("new-version");
  const select2 = document.getElementById("catalog-version");
  select1.innerHTML = "";
  select2.innerHTML = "";
  rawVersions.forEach((v) => {
    if (showSnapshots || v.type === "release") {
      let opt1 = document.createElement("option");
      opt1.value = v.id;
      opt1.innerHTML = v.id;
      select1.appendChild(opt1);
      let opt2 = document.createElement("option");
      opt2.value = v.id;
      opt2.innerHTML = v.id;
      select2.appendChild(opt2);
    }
  });
};

function loadStorage() {
  if (fs.existsSync(settingsFile)) {
    globalSettings = Object.assign(
      globalSettings,
      JSON.parse(fs.readFileSync(settingsFile)),
    );
    if (globalSettings.defaultRam > maxSafeRam)
      globalSettings.defaultRam = maxSafeRam;
  }
  if (fs.existsSync(instanceFile))
    allInstances = JSON.parse(fs.readFileSync(instanceFile));
  if (fs.existsSync(accountFile)) {
    let accData = JSON.parse(fs.readFileSync(accountFile));
    allAccounts = accData.list || [];
    selectedAccountIdx =
      accData.lastUsed !== undefined ? accData.lastUsed : null;
  }
  renderUI();
  checkServerStatus();
}

window.toggleGroup = (group) => {
  collapsedGroups[group] = !collapsedGroups[group];
  renderUI();
};

function renderUI() {
  const container = document.getElementById("instances-container");
  container.innerHTML = "";
  const search = document.getElementById("search-bar").value.toLowerCase();
  const sort = document.getElementById("sort-dropdown").value;

  let displayList = allInstances.map((inst, i) => ({
    ...inst,
    originalIndex: i,
  }));
  displayList = displayList.filter((inst) =>
    inst.name.toLowerCase().includes(search),
  );
  displayList.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "lastPlayed") return (b.lastPlayed || 0) - (a.lastPlayed || 0);
    if (sort === "playTime") return (b.playTime || 0) - (a.playTime || 0);
  });

  const groups = {};
  const groupSet = new Set();
  displayList.forEach((inst) => {
    const g = inst.group && inst.group.trim() !== "" ? inst.group : "Général";
    if (!groups[g]) groups[g] = [];
    groups[g].push(inst);
    groupSet.add(g);
  });

  const datalist = document.getElementById("group-paths-list");
  datalist.innerHTML = "";
  allInstances.forEach((i) => {
    if (i.group && i.group.trim() !== "") groupSet.add(i.group);
  });
  groupSet.forEach((g) => {
    if (g !== "Général") {
      let opt = document.createElement("option");
      opt.value = g;
      datalist.appendChild(opt);
    }
  });

  let html = "";
  Object.keys(groups)
    .sort()
    .forEach((g) => {
      const isCollapsed = collapsedGroups[g];
      const icon = isCollapsed ? "▶" : "▼";
      html += `<div class="category-header" onclick="toggleGroup('${g}')">${icon} ${g} <span style="color:#aaa; font-weight:normal; font-size:0.8rem;">(${groups[g].length})</span></div>`;
      if (!isCollapsed) {
        html += `<div class="instances-grid">`;
        groups[g].forEach((inst) => {
          const active =
            selectedInstanceIdx === inst.originalIndex ? "active" : "";
          let displaySrc =
            inst.icon || defaultIcons[inst.loader] || defaultIcons.vanilla;
          html += `<div class="instance-card ${active}" onclick="selectInstance(${inst.originalIndex})" ondblclick="selectInstance(${inst.originalIndex}); document.getElementById('launch-btn').click()"><img src="${displaySrc}" class="instance-icon"><div class="instance-name">${inst.name}</div><div class="instance-version">${inst.version}</div></div>`;
        });
        html += `</div>`;
      }
    });
  container.innerHTML = html;

  const accDropdown = document.getElementById("account-dropdown");
  accDropdown.innerHTML = `<option value="">-- Aucun --</option>`;
  allAccounts.forEach((acc, i) => {
    const isSelected = selectedAccountIdx === i ? "selected" : "";
    accDropdown.innerHTML += `<option value="${i}" ${isSelected}>${acc.name}</option>`;
  });

  const activeSkin = document.getElementById("active-skin");
  if (selectedAccountIdx !== null && allAccounts[selectedAccountIdx]) {
    activeSkin.style.display = "block";
    activeSkin.src = `https://mc-heads.net/avatar/${allAccounts[selectedAccountIdx].name}/20`;
  } else activeSkin.style.display = "none";

  updateLaunchButton();
  renderAccountManager();
}

function renderAccountManager() {
  const list = document.getElementById("account-list");
  list.innerHTML = "";
  if (allAccounts.length === 0) {
    list.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_acc", "Aucun profil enregistré.")}</div>`;
    return;
  }
  allAccounts.forEach((acc, i) => {
    const typeLabel =
      acc.type === "microsoft"
        ? '<span style="color:#107c10; font-weight:bold;">Microsoft</span>'
        : `<span style="color:#888;">${t("lbl_offline", "Hors-Ligne")}</span>`;
    list.innerHTML += `<div class="account-item"><div style="display: flex; align-items: center; gap: 10px;"><img src="https://mc-heads.net/avatar/${acc.name}/32" class="account-skin"><div><div style="color: white; font-weight: bold;">${acc.name}</div><div style="font-size: 0.7rem;">${typeLabel}</div></div></div><button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px;" onclick="deleteAccount(${i})">${t("btn_delete", "Supprimer")}</button></div>`;
  });
}

function renderModsManager() {
  const modsListDiv = document.getElementById("mods-list");
  modsListDiv.innerHTML = "";
  const inst = allInstances[selectedInstanceIdx];
  if (!inst) return;
  const modsPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "mods",
  );
  if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
  let hasMods = false;
  fs.readdirSync(modsPath).forEach((file) => {
    if (file.endsWith(".jar") || file.endsWith(".jar.disabled")) {
      hasMods = true;
      const isEnabled = !file.endsWith(".disabled");
      const displayName = file.replace(".jar.disabled", ".jar");
      const color = isEnabled ? "var(--text-light)" : "#666";
      const decoration = isEnabled ? "none" : "line-through";
      modsListDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleMod('${file}', this.checked)"></div>`;
    }
  });
  if (!hasMods)
    modsListDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_mods", "Aucun mod local installé.")}</div>`;
}

function renderShadersManager() {
  const listDiv = document.getElementById("shaders-list");
  listDiv.innerHTML = "";
  const inst = allInstances[selectedInstanceIdx];
  if (!inst) return;
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "shaderpacks",
  );
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
  let hasItems = false;
  fs.readdirSync(targetPath).forEach((file) => {
    if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
      hasItems = true;
      const isEnabled = !file.endsWith(".disabled");
      const displayName = file.replace(".zip.disabled", ".zip");
      const color = isEnabled ? "var(--text-light)" : "#666";
      const decoration = isEnabled ? "none" : "line-through";
      listDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleShader('${file}', this.checked)"></div>`;
    }
  });
  if (!hasItems)
    listDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_shaders", "Aucun shader installé.")}</div>`;
}

function renderResourcePacksManager() {
  const listDiv = document.getElementById("resourcepacks-list");
  listDiv.innerHTML = "";
  const inst = allInstances[selectedInstanceIdx];
  if (!inst) return;
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "resourcepacks",
  );
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
  let hasItems = false;
  fs.readdirSync(targetPath).forEach((file) => {
    if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
      hasItems = true;
      const isEnabled = !file.endsWith(".disabled");
      const displayName = file.replace(".zip.disabled", ".zip");
      const color = isEnabled ? "var(--text-light)" : "#666";
      const decoration = isEnabled ? "none" : "line-through";
      listDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleResourcePack('${file}', this.checked)"></div>`;
    }
  });
  if (!hasItems)
    listDiv.innerHTML = `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_rps", "Aucun pack de textures installé.")}</div>`;
}

window.toggleMod = (filename, isEnabled) => {
  const inst = allInstances[selectedInstanceIdx];
  const modsPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "mods",
  );
  fs.renameSync(
    path.join(modsPath, filename),
    path.join(
      modsPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled",
    ),
  );
  renderModsManager();
};

window.toggleShader = (filename, isEnabled) => {
  const inst = allInstances[selectedInstanceIdx];
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "shaderpacks",
  );
  fs.renameSync(
    path.join(targetPath, filename),
    path.join(
      targetPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled",
    ),
  );
  renderShadersManager();
};

window.toggleResourcePack = (filename, isEnabled) => {
  const inst = allInstances[selectedInstanceIdx];
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "resourcepacks",
  );
  fs.renameSync(
    path.join(targetPath, filename),
    path.join(
      targetPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled",
    ),
  );
  renderResourcePacksManager();
};

window.checkModUpdates = async () => {
  const inst = allInstances[selectedInstanceIdx];
  if (!inst) return;
  const modsPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "mods",
  );
  if (!fs.existsSync(modsPath)) return;
  const files = fs.readdirSync(modsPath).filter((f) => f.endsWith(".jar"));
  if (files.length === 0) return;

  let hashes = {};
  for (let f of files) {
    const buf = fs.readFileSync(path.join(modsPath, f));
    hashes[crypto.createHash("sha1").update(buf).digest("hex")] = f;
  }
  const loader = inst.loader === "forge" ? "forge" : "fabric";
  const reqBody = {
    hashes: Object.keys(hashes),
    algorithm: "sha1",
    loaders: [loader],
    game_versions: [inst.version],
  };

  showLoading(t("msg_check_updates", "Vérification des mises à jour..."));
  await yieldUI();
  try {
    const res = await fetch(
      "https://api.modrinth.com/v2/version_files/update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      },
    );
    const data = await res.json();
    let updatedCount = 0;
    for (let oldHash in data) {
      const newFileObj =
        data[oldHash].files.find((f) => f.primary) || data[oldHash].files[0];
      if (newFileObj.filename !== hashes[oldHash]) {
        showLoading(
          `${t("msg_updating", "Mise à jour :")} ${newFileObj.filename}...`,
        );
        await yieldUI();
        const buffer = await (await fetch(newFileObj.url)).arrayBuffer();
        fs.writeFileSync(
          path.join(modsPath, newFileObj.filename),
          Buffer.from(buffer),
        );
        fs.unlinkSync(path.join(modsPath, hashes[oldHash]));
        updatedCount++;
      }
    }
    hideLoading();
    if (updatedCount > 0) {
      showToast(
        `${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`,
        "success",
      );
      renderModsManager();
    } else showToast(t("msg_mods_uptodate", "Mods déjà à jour !"), "info");
  } catch (e) {
    hideLoading();
    showToast(t("msg_err_dl", "Erreur."), "error");
  }
};

window.openCatalogModal = () => {
  document.getElementById("catalog-status").innerText = "";
  if (selectedInstanceIdx !== null) {
    const inst = allInstances[selectedInstanceIdx];
    if (inst.loader !== "vanilla")
      document.getElementById("catalog-loader").value = inst.loader;
    document.getElementById("catalog-version").value = inst.version;
  }
  document.getElementById("modal-catalog").style.display = "flex";
  searchGlobalCatalog();
};
window.closeCatalogModal = () =>
  (document.getElementById("modal-catalog").style.display = "none");

window.searchGlobalCatalog = async () => {
  const query = document.getElementById("catalog-search").value;
  const loader = document.getElementById("catalog-loader").value;
  const version = document.getElementById("catalog-version").value;
  const type = document.getElementById("catalog-type").value;
  const resDiv = document.getElementById("catalog-results");
  resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_search_java", "Recherche...")}</div>`;

  try {
    let facets = `[["project_type:${type}"],["versions:${version}"]]`;
    if (type === "mod")
      facets = `[["project_type:mod"],["categories:${loader}"],["versions:${version}"]]`;
    const sortIndex = query ? "relevance" : "downloads";
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
    const data = await (await fetch(url)).json();

    resDiv.innerHTML = "";
    if (data.hits.length === 0) {
      resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_no_compat", "Aucun résultat.")}</div>`;
      return;
    }

    data.hits.forEach((mod) => {
      const downloads = (mod.downloads / 1000000).toFixed(1) + "M DLs";
      resDiv.innerHTML += `
                <div class="catalog-card">
                    <img src="${mod.icon_url || ""}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${mod.title}</div>
                        <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 5px;">${mod.author || "Auteur"} • ${downloads}</div>
                        <div style="font-size: 0.8rem; color: var(--text-main);">${mod.description}</div>
                    </div>
                    <button class="btn-primary" onclick="installGlobalMod('${mod.project_id}', false, '${type}')">${t("btn_install", "Installer")}</button>
                </div>`;
    });
  } catch (e) {
    resDiv.innerHTML =
      "<div style='text-align:center; padding: 20px; color:#f87171;'>Erreur.</div>";
  }
};

window.installGlobalMod = async (
  projectId,
  isDependency = false,
  projType = "mod",
) => {
  if (projType !== "modpack" && selectedInstanceIdx === null) {
    showToast(
      t("msg_select_inst", "Sélectionnez une instance d'abord !"),
      "error",
    );
    return;
  }

  const statusText = document.getElementById("catalog-status");
  let loader, version;

  if (projType !== "modpack") {
    const inst = allInstances[selectedInstanceIdx];
    loader = document.getElementById("catalog-loader")
      ? document.getElementById("catalog-loader").value
      : inst.loader === "forge"
        ? "forge"
        : "fabric";
    version = document.getElementById("catalog-version")
      ? document.getElementById("catalog-version").value
      : inst.version;
  } else {
    version = document.getElementById("catalog-version").value;
  }

  try {
    if (!isDependency)
      statusText.innerText = t("msg_dl_mod", "Téléchargement en cours...");

    let url = `https://api.modrinth.com/v2/project/${projectId}/version`;
    let params = [];
    if (version) params.push(`game_versions=["${version}"]`);
    if (projType === "mod") params.push(`loaders=["${loader}"]`);
    if (projType === "modpack")
      params.push(`loaders=["fabric","forge","quilt"]`);

    if (params.length > 0) url += "?" + params.join("&");

    const versions = await (await fetch(url)).json();
    if (versions.length === 0) {
      if (!isDependency)
        statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
      return;
    }

    const fileData = versions[0];
    let file = fileData.files.find((f) => f.primary) || fileData.files[0];

    if (projType === "modpack") {
      const mrpackFile = fileData.files.find((f) =>
        f.filename.endsWith(".mrpack"),
      );
      if (mrpackFile) file = mrpackFile;

      statusText.innerText = "Téléchargement du modpack...";
      const tempPath = path.join(dataDir, file.filename);
      const buffer = await (await fetch(file.url)).arrayBuffer();
      fs.writeFileSync(tempPath, Buffer.from(buffer));

      statusText.innerText = "Installation du modpack...";
      closeCatalogModal();
      await handleMrPackImport(tempPath);
      fs.unlinkSync(tempPath);
      return;
    }

    let targetFolder = "mods";
    if (projType === "shader") targetFolder = "shaderpacks";
    if (projType === "resourcepack") targetFolder = "resourcepacks";

    const inst = allInstances[selectedInstanceIdx];
    const destPath = path.join(
      instancesRoot,
      inst.name.replace(/[^a-z0-9]/gi, "_"),
      targetFolder,
    );
    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
    const filePath = path.join(destPath, file.filename);

    if (!fs.existsSync(filePath)) {
      const buffer = await (await fetch(file.url)).arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(buffer));
    }

    if (
      projType === "mod" &&
      fileData.dependencies &&
      fileData.dependencies.length > 0
    ) {
      for (let dep of fileData.dependencies) {
        if (dep.dependency_type === "required") {
          let depId = dep.project_id || dep.version_id;
          if (depId) {
            statusText.innerText = t("msg_deps", "Dépendances...");
            await installGlobalMod(depId, true, "mod");
          }
        }
      }
    }

    if (!isDependency) {
      statusText.innerText = "";
      showToast(t("msg_install_success", "Installation réussie !"), "success");
      if (projType === "mod") renderModsManager();
      if (projType === "shader") renderShadersManager();
      if (projType === "resourcepack") renderResourcePacksManager();
    }
  } catch (e) {
    sysLog("Erreur catalog install: " + e, true);
    if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur.");
  }
};

window.addServer = () => {
  const ip = document.getElementById("new-server-ip").value.trim();
  if (!ip) return;
  const inst = allInstances[selectedInstanceIdx];
  if (!inst.servers) inst.servers = [];
  if (!inst.servers.includes(ip)) {
    inst.servers.push(ip);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  }
  document.getElementById("new-server-ip").value = "";
  renderServersManager();
};

window.removeServer = (index) => {
  allInstances[selectedInstanceIdx].servers.splice(index, 1);
  fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  renderServersManager();
};

window.renderServersManager = () => {
  const list = document.getElementById("server-list");
  list.innerHTML = "";
  const inst = allInstances[selectedInstanceIdx];
  if (!inst.servers || inst.servers.length === 0) {
    list.innerHTML = `<div style='text-align:center; color:#888; padding: 15px;'>${t("msg_no_servers", "Aucun serveur.")}</div>`;
    return;
  }

  inst.servers.forEach((ip, i) => {
    list.innerHTML += `
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-weight: bold; color: var(--text-light);">${ip}</span>
                    <div id="srv-ping-${i}" style="font-size: 0.75rem; color: #aaa;">🔄 ${t("msg_ping", "Ping...")}</div>
                </div>
                <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;" onclick="removeServer(${i})">${t("btn_delete", "Supprimer")}</button>
            </div>`;
  });
  pingServers();
};

window.pingServers = async () => {
  const inst = allInstances[selectedInstanceIdx];
  if (!inst || !inst.servers) return;
  for (let i = 0; i < inst.servers.length; i++) {
    const ip = inst.servers[i];
    const statusDiv = document.getElementById(`srv-ping-${i}`);
    if (!statusDiv) continue;
    try {
      const res = await fetch(`https://api.mcsrvstat.us/3/${ip}`);
      const data = await res.json();
      const formatNum = (n) =>
        n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n;
      if (data.online)
        statusDiv.innerHTML = `<span style="color:#17B139; font-weight:bold;">🟢 ${t("msg_online", "En ligne")}</span> <span style="color:#aaa;">• ${formatNum(data.players.online)}/${formatNum(data.players.max)}</span>`;
      else
        statusDiv.innerHTML = `<span style="color:#f87171; font-weight:bold;">🔴 ${t("msg_offline", "Hors-ligne")}</span>`;
    } catch (e) {
      statusDiv.innerHTML = `<span style="color:#f87171;">🔴 ${t("msg_err_ping", "Erreur")}</span>`;
    }
  }
};

window.scanJavaVersions = () => {
  document.getElementById("status-text").innerText = t(
    "msg_search_java",
    "Recherche de Java...",
  );
  const datalist = document.getElementById("java-paths-list");
  datalist.innerHTML = "";
  const basePaths = [
    "C:\\Program Files\\Java",
    "C:\\Program Files (x86)\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Amazon Corretto",
  ];
  let found = 0;
  for (let bp of basePaths) {
    if (fs.existsSync(bp)) {
      try {
        fs.readdirSync(bp).forEach((d) => {
          const jPath = path.join(bp, d, "bin", "javaw.exe");
          if (fs.existsSync(jPath)) {
            let opt = document.createElement("option");
            opt.value = jPath;
            datalist.appendChild(opt);
            found++;
          }
        });
      } catch (e) {}
    }
  }
  document.getElementById("status-text").innerText = t("status_ready", "Prêt");
  showToast(
    `${found} ${t("msg_java_found", "version(s) de Java trouvée(s).")}`,
    "info",
  );
};

async function downloadJavaAuto() {
  showLoading(t("msg_dl_java", "Téléchargement de Java 21..."));
  await yieldUI();
  const javaDir = path.join(dataDir, "java");
  if (!fs.existsSync(javaDir)) fs.mkdirSync(javaDir, { recursive: true });
  const zipPath = path.join(javaDir, "jre.zip");

  try {
    const url =
      "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse";
    const res = await fetch(url);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    showLoading(t("msg_extract_java", "Extraction de Java 21..."));
    await yieldUI();
    new AdmZip(zipPath).extractAllTo(javaDir, true);
    fs.unlinkSync(zipPath);

    function findJavaExe(dir) {
      for (let file of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          const found = findJavaExe(fullPath);
          if (found) return found;
        } else if (file.toLowerCase() === "javaw.exe") return fullPath;
      }
      return null;
    }
    const javaExePath = findJavaExe(javaDir);
    if (javaExePath) {
      globalSettings.defaultJavaPath = javaExePath;
      fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
      return javaExePath;
    }
    throw new Error("javaw.exe introuvable.");
  } catch (e) {
    sysLog("Erreur Auto-Java : " + e, true);
    showToast(t("msg_err_java", "Erreur Java") + " : " + e, "error");
    return null;
  } finally {
    hideLoading();
  }
}

// --- GESTION DES MONDES (WORLDS MANAGER) ---
window.openWorldsModal = async () => {
  if (selectedInstanceIdx === null) return;
  const inst = allInstances[selectedInstanceIdx];
  const savesDir = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "saves",
  );
  const listDiv = document.getElementById("worlds-list");

  listDiv.innerHTML =
    "<div style='text-align:center; color:#888;'>Chargement...</div>";
  document.getElementById("modal-worlds").style.display = "flex";

  if (!fs.existsSync(savesDir)) {
    listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
    return;
  }

  const folders = fs
    .readdirSync(savesDir)
    .filter((f) => fs.statSync(path.join(savesDir, f)).isDirectory());
  if (folders.length === 0) {
    listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
    return;
  }

  let html = "";
  for (const f of folders) {
    const folderPath = path.join(savesDir, f);
    const stats = fs.statSync(folderPath);
    let worldName = f;

    try {
      const levelDat = path.join(folderPath, "level.dat");
      if (fs.existsSync(levelDat)) {
        const buffer = fs.readFileSync(levelDat);
        const { parsed } = await parseNbt(buffer);
        if (
          parsed &&
          parsed.value &&
          parsed.value.Data &&
          parsed.value.Data.value &&
          parsed.value.Data.value.LevelName
        ) {
          worldName = parsed.value.Data.value.LevelName.value;
        }
      }
    } catch (e) {}

    const created =
      stats.birthtime.toLocaleDateString() +
      " " +
      stats.birthtime.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    const modified =
      stats.mtime.toLocaleDateString() +
      " " +
      stats.mtime.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

    html += `
        <div style="background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-weight: bold; color: var(--text-light); font-size: 1rem;">${worldName}</span>
                <span style="font-size: 0.75rem; color: #aaa;">${t("lbl_folder", "Dossier : ")}${f}</span>
                <span style="font-size: 0.75rem; color: #888;">${t("lbl_created", "Créé le : ")}${created} | ${t("lbl_played", "Joué le : ")}${modified}</span>
            </div>
            <div style="display: flex; gap: 6px;">
                <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="backupSingleWorld('${f}')">${t("btn_world_backup", "Sauvegarder")}</button>
                <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="copySingleWorld('${f}')">${t("btn_world_copy", "Copier")}</button>
                <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;" onclick="deleteSingleWorld('${f}')">${t("btn_delete", "Supprimer")}</button>
            </div>
        </div>`;
  }
  listDiv.innerHTML = html;
};

window.closeWorldsModal = () =>
  (document.getElementById("modal-worlds").style.display = "none");

window.copySingleWorld = async (folderName) => {
  const inst = allInstances[selectedInstanceIdx];
  const savesDir = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "saves",
  );
  const src = path.join(savesDir, folderName);

  let destName = folderName + " - Copie";
  let counter = 2;
  while (fs.existsSync(path.join(savesDir, destName))) {
    destName = `${folderName} - Copie (${counter})`;
    counter++;
  }
  const dest = path.join(savesDir, destName);

  showLoading(t("msg_copy_world_loading", "Copie du monde en cours..."));
  await yieldUI();
  try {
    await fs.promises.cp(src, dest, { recursive: true });
    showToast(t("msg_world_copied", "Monde copié avec succès !"), "success");
  } catch (e) {
    showToast("Erreur: " + e.message, "error");
  }
  hideLoading();
  openWorldsModal();
};

window.deleteSingleWorld = async (folderName) => {
  if (
    await showCustomConfirm(
      t(
        "msg_delete_world_confirm",
        "Voulez-vous vraiment supprimer ce monde définitivement ?",
      ),
      true,
    )
  ) {
    const inst = allInstances[selectedInstanceIdx];
    const savesDir = path.join(
      instancesRoot,
      inst.name.replace(/[^a-z0-9]/gi, "_"),
      "saves",
    );
    const src = path.join(savesDir, folderName);
    try {
      await fs.promises.rm(src, { recursive: true, force: true });
      showToast(t("msg_world_deleted", "Monde supprimé !"), "success");
    } catch (e) {
      showToast("Erreur: " + e.message, "error");
    }
    openWorldsModal();
  }
};

window.backupSingleWorld = async (folderName) => {
  const inst = allInstances[selectedInstanceIdx];
  const instDir = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
  );
  const savesDir = path.join(instDir, "saves");
  const backupDir = path.join(instDir, "backups");
  const src = path.join(savesDir, folderName);

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const zipPath = path.join(
    backupDir,
    `${folderName}_backup_${new Date().toISOString().replace(/[:\.]/g, "-")}.zip`,
  );

  showLoading(t("msg_backup", "Création de la sauvegarde..."));
  await yieldUI();
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(src, folderName);
    await new Promise((res, rej) =>
      zip.writeZip(zipPath, (err) => (err ? rej(err) : res())),
    );
    showToast(
      t("msg_world_backedup", "Sauvegarde créée dans le dossier 'backups' !"),
      "success",
    );
  } catch (e) {
    showToast("Erreur: " + e.message, "error");
  }
  hideLoading();
};

window.openGalleryModal = () => {
  if (selectedInstanceIdx === null) return;
  const inst = allInstances[selectedInstanceIdx];
  const screensDir = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "screenshots",
  );
  const grid = document.getElementById("gallery-grid");
  grid.innerHTML = "";

  if (fs.existsSync(screensDir)) {
    const files = fs
      .readdirSync(screensDir)
      .filter((f) => f.endsWith(".png"))
      .reverse();
    if (files.length === 0)
      grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
    else {
      files.forEach((f) => {
        const fullPath = path.join(screensDir, f).replace(/\\/g, "/");
        const clickPath = path
          .join(screensDir, f)
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'");
        grid.innerHTML += `
                    <div style="position: relative; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; cursor: pointer; aspect-ratio: 16/9; background: #000;" onclick="openSystemPath('${clickPath}')">
                        <img src="file:///${fullPath}" style="width: 100%; height: 100%; object-fit: cover;">
                        <div style="position: absolute; bottom: 0; width: 100%; background: rgba(0,0,0,0.7); font-size: 0.75rem; padding: 4px; box-sizing: border-box; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${f}</div>
                    </div>`;
      });
    }
  } else
    grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
  document.getElementById("modal-gallery").style.display = "flex";
};
window.closeGalleryModal = () =>
  (document.getElementById("modal-gallery").style.display = "none");

document
  .getElementById("edit-icon-upload")
  .addEventListener("change", function () {
    if (this.files && this.files[0]) {
      let r = new FileReader();
      r.onload = (e) =>
        (document.getElementById("edit-icon-preview").src = e.target.result);
      r.readAsDataURL(this.files[0]);
    }
  });

window.selectInstance = (i) => {
  selectedInstanceIdx = i;
  const inst = allInstances[i];
  document.getElementById("action-panel").style.opacity = "1";
  document.getElementById("action-panel").style.pointerEvents = "auto";
  document.getElementById("panel-title").innerText = inst.name;
  document.getElementById("btn-mods").style.display =
    inst.loader === "vanilla" ? "none" : "block";
  document.getElementById("panel-stats").style.display = "block";

  let h = Math.floor((inst.playTime || 0) / 3600000);
  let m = Math.floor(((inst.playTime || 0) % 3600000) / 60000);
  document.getElementById("stat-time").innerText = `${h}h ${m}m`;
  document.getElementById("stat-last").innerText = inst.lastPlayed
    ? new Date(inst.lastPlayed).toLocaleDateString()
    : "Jamais";
  renderUI();
};

window.changeAccount = () => {
  const dropdown = document.getElementById("account-dropdown");
  selectedAccountIdx = dropdown.value === "" ? null : parseInt(dropdown.value);
  fs.writeFileSync(
    accountFile,
    JSON.stringify(
      { list: allAccounts, lastUsed: selectedAccountIdx },
      null,
      2,
    ),
  );
  renderUI();
};

function updateLaunchButton() {
  const btn = document.getElementById("launch-btn");
  if (isGameRunning) {
    btn.innerText = t("btn_stop", "Forcer l'arrêt");
    btn.style.background = "#f87171";
    btn.disabled = false;
    return;
  }
  btn.innerText = t("btn_launch", "Lancer");
  btn.style.background = "var(--accent)";
  btn.disabled = selectedInstanceIdx === null || selectedAccountIdx === null;
}

function setUIState(running) {
  isGameRunning = running;
  document.getElementById("instances-container").style.pointerEvents = running
    ? "none"
    : "auto";
  document.getElementById("instances-container").style.opacity = running
    ? "0.5"
    : "1";
  ["btn-offline", "btn-edit", "btn-delete", "btn-copy", "btn-export"].forEach(
    (id) => (document.getElementById(id).disabled = running),
  );
  updateLaunchButton();
}

document.getElementById("launch-btn").addEventListener("click", async () => {
  if (isGameRunning) {
    if (launcher && launcher.process) launcher.process.kill("SIGKILL");
    return;
  }

  const inst = allInstances[selectedInstanceIdx];
  const acc = allAccounts[selectedAccountIdx];
  const instancePath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
  );
  const progBar = document.getElementById("progress-bar");
  const logOutput = document.getElementById("log-output");

  document.getElementById("console-container").style.display = "block";
  logOutput.innerHTML = "";
  sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
  logOutput.innerHTML += `<span style="color:#007acc">[SYSTEM] ${t("msg_launching", "Lancement de ")}${inst.name}...</span>\n`;

  if (inst.backupMode === "on_launch") await createBackup(inst);

  let ramMB = inst.ram ? parseInt(inst.ram) : globalSettings.defaultRam;
  if (ramMB < 128) ramMB = ramMB * 1024;
  let jPath =
    inst.javaPath && inst.javaPath.trim() !== ""
      ? inst.javaPath
      : globalSettings.defaultJavaPath || "javaw";
  let customArgs =
    inst.jvmArgs && inst.jvmArgs.trim() !== "" ? inst.jvmArgs.split(" ") : [];
  let resW = inst.resW ? parseInt(inst.resW) : 854;
  let resH = inst.resH ? parseInt(inst.resH) : 480;

  document.getElementById("status-text").innerText = t(
    "msg_check_java",
    "Vérification de Java...",
  );
  let javaToTest = jPath === "javaw" ? "java" : jPath;
  if (javaToTest.toLowerCase().endsWith("javaw.exe"))
    javaToTest = javaToTest.substring(0, javaToTest.length - 9) + "java.exe";
  else if (javaToTest.toLowerCase().endsWith("javaw"))
    javaToTest = javaToTest.substring(0, javaToTest.length - 5) + "java";

  const javaExists = await new Promise((resolve) => {
    exec(`"${javaToTest}" -version`, (err, stdout, stderr) => {
      if (err) {
        const errorStr = (err.message + stdout + stderr).toLowerCase();
        if (
          errorStr.includes("not recognized") ||
          errorStr.includes("non reconnu") ||
          errorStr.includes("introuvable") ||
          err.code === "ENOENT"
        )
          resolve(false);
        else resolve(true);
      } else resolve(true);
    });
  });

  if (!javaExists) {
    if (
      await showCustomConfirm(
        t(
          "msg_java_not_found",
          "Java introuvable ! Voulez-vous installer automatiquement Java 21 ?",
        ),
      )
    ) {
      const newJava = await downloadJavaAuto();
      if (newJava) jPath = newJava;
      else {
        document.getElementById("status-text").innerText = t(
          "msg_err_java",
          "Erreur Java",
        );
        setUIState(false);
        return;
      }
    } else {
      document.getElementById("status-text").innerText = t(
        "msg_err_java",
        "Erreur Java",
      );
      setUIState(false);
      return;
    }
  }

  if (inst.servers && inst.servers.length > 0) {
    try {
      const datPath = path.join(instancePath, "servers.dat");
      let parsed = {
        type: "compound",
        name: "",
        value: {
          servers: { type: "list", value: { type: "compound", value: [] } },
        },
      };
      if (fs.existsSync(datPath)) {
        const { parsed: p } = await parseNbt(fs.readFileSync(datPath));
        if (p && p.value) {
          parsed = p;
          if (!parsed.value.servers)
            parsed.value.servers = {
              type: "list",
              value: { type: "compound", value: [] },
            };
          if (!parsed.value.servers.value.value)
            parsed.value.servers.value.value = [];
        }
      }
      let existingIps = parsed.value.servers.value.value.map((s) =>
        s.ip ? s.ip.value : "",
      );
      let changed = false;
      for (let ip of inst.servers) {
        if (!existingIps.includes(ip)) {
          parsed.value.servers.value.value.push({
            name: { type: "string", value: ip },
            ip: { type: "string", value: ip },
          });
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(datPath, nbt.writeUncompressed(parsed));
    } catch (e) {
      sysLog("Erreur de sync serveur: " + e, true);
    }
  }

  let authObj = {
    access_token: "null",
    client_token: "null",
    uuid: "null",
    name: acc.name,
    user_properties: "{}",
  };
  if (acc.type === "microsoft" && acc.mclcAuth) authObj = acc.mclcAuth;

  let opts = {
    authorization: authObj,
    root: instancePath,
    version: { number: inst.version, type: "release" },
    memory: { max: ramMB + "M", min: "1024M" },
    javaPath: jPath,
    customArgs: customArgs,
    window: { width: resW, height: resH },
    spawnOptions: { detached: false, shell: false, windowsHide: true },
  };

  if (inst.loader === "fabric") {
    try {
      document.getElementById("status-text").innerText = t(
        "msg_install_fabric",
        "Installation de Fabric...",
      );
      const fbRes = await fetch(
        `https://meta.fabricmc.net/v2/versions/loader/${inst.version}`,
      );
      const fbData = await fbRes.json();
      if (fbData.length > 0) {
        const customVerName = `fabric-loader-${fbData[0].loader.version}-${inst.version}`;
        opts.version.custom = customVerName;
        const vPath = path.join(instancePath, "versions", customVerName);
        if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
        const jsonPath = path.join(vPath, `${customVerName}.json`);
        if (!fs.existsSync(jsonPath)) {
          const response = await fetch(
            `https://meta.fabricmc.net/v2/versions/loader/${inst.version}/${fbData[0].loader.version}/profile/json`,
          );
          fs.writeFileSync(jsonPath, await response.text());
        }
      } else return;
    } catch (e) {
      sysLog("Erreur Fabric: " + e, true);
      return;
    }
  }

  document.getElementById("status-text").innerText = t(
    "msg_prep_files",
    "Préparation des fichiers...",
  );
  setUIState(true);
  sessionStartTime = Date.now();
  updateRPC(inst.name, "En jeu");

  sysLog("Démarrage du processus MCLC...");
  launcher.launch(opts);
  launcher.on("progress", (e) => {
    let perc = 0;
    if (e.total > 0) perc = Math.round((e.task / e.total) * 100);
    progBar.style.width = perc + "%";
    document.getElementById("status-text").innerText =
      `${t("msg_dl", "Téléchargement :")} ${perc}%`;
  });

  launcher.on("data", (data) => {
    const dStr = data.toString();
    sysLog("GAME: " + dStr);
    logOutput.insertAdjacentHTML(
      "beforeend",
      `<span>[GAME] ${dStr}</span><br>`,
    );
    logOutput.scrollTop = logOutput.scrollHeight;
  });

  launcher.on("close", async (code) => {
    sysLog(`Le jeu s'est arrêté avec le code ${code}`, code !== 0);
    logOutput.insertAdjacentHTML(
      "beforeend",
      `<br><span style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</span><br>`,
    );

    if (code !== 0)
      document.getElementById("console-container").style.display = "block";

    if (selectedInstanceIdx !== null) {
      const currentInst = allInstances[selectedInstanceIdx];
      if (currentInst.backupMode === "on_close")
        await createBackup(currentInst);
      currentInst.playTime =
        (currentInst.playTime || 0) + (Date.now() - sessionStartTime);
      currentInst.lastPlayed = Date.now();
      fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
      selectInstance(selectedInstanceIdx);
    }
    document.getElementById("status-text").innerText = t(
      "status_ready",
      "Prêt",
    );
    progBar.style.width = "0%";
    setUIState(false);
    clearRPC();
  });
});

window.switchTab = (tabId) => {
  document
    .querySelectorAll(".settings-tab")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll(".settings-content")
    .forEach((c) => c.classList.remove("active"));
  const tabBtn = document.getElementById(
    "tab-btn-" + tabId.replace("tab-", ""),
  );
  if (tabBtn) tabBtn.classList.add("active");
  const tabContent = document.getElementById(tabId);
  if (tabContent) tabContent.classList.add("active");

  clearInterval(pingInterval);
  if (tabId === "tab-mods") renderModsManager();
  else if (tabId === "tab-shaders") renderShadersManager();
  else if (tabId === "tab-resourcepacks") renderResourcePacksManager();
  else if (tabId === "tab-servers") {
    renderServersManager();
    pingInterval = setInterval(pingServers, 15000);
  }
};

window.switchTabGlob = (tabId) => {
  document
    .querySelectorAll("#modal-settings .settings-tab")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll("#modal-settings .settings-content")
    .forEach((c) => c.classList.remove("active"));
  const tabBtn = document.getElementById(
    "tab-btn-" + tabId.replace("tab-", ""),
  );
  if (tabBtn) tabBtn.classList.add("active");
  const tabContent = document.getElementById(tabId);
  if (tabContent) tabContent.classList.add("active");
};

window.openGlobalSettings = () => {
  document.getElementById("global-ram-input").value = globalSettings.defaultRam;
  document.getElementById("global-ram-slider").value =
    globalSettings.defaultRam;
  document.getElementById("global-java").value = globalSettings.defaultJavaPath;
  document.getElementById("global-server-ip").value =
    globalSettings.serverIp || "";
  document.getElementById("global-accent").value =
    globalSettings.theme?.accent || "#007acc";
  document.getElementById("global-bg-path").value =
    globalSettings.theme?.bg || "";
  document.getElementById("global-bg-dim").value =
    globalSettings.theme?.dim || 0.5;
  document.getElementById("global-bg-blur").value =
    globalSettings.theme?.blur || 5;

  switchTabGlob("tab-glob-gen");
  document.getElementById("modal-settings").style.display = "flex";
};
window.closeGlobalSettings = () =>
  (document.getElementById("modal-settings").style.display = "none");
window.saveGlobalSettings = () => {
  globalSettings.defaultRam = parseInt(
    document.getElementById("global-ram-input").value,
  );
  globalSettings.defaultJavaPath = document.getElementById("global-java").value;
  globalSettings.serverIp = document
    .getElementById("global-server-ip")
    .value.trim();

  globalSettings.theme = {
    accent: document.getElementById("global-accent").value,
    bg: document.getElementById("global-bg-path").value,
    dim: parseFloat(document.getElementById("global-bg-dim").value),
    blur: parseInt(document.getElementById("global-bg-blur").value),
  };

  fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
  applyTheme();
  closeGlobalSettings();
  checkServerStatus();
};

window.openInstanceModal = () => {
  document.getElementById("new-ram-input").value = globalSettings.defaultRam;
  document.getElementById("new-ram-slider").value = globalSettings.defaultRam;
  document.getElementById("modal-instance").style.display = "flex";
};
window.closeInstanceModal = () =>
  (document.getElementById("modal-instance").style.display = "none");

window.openEditModal = (targetTab = "tab-general") => {
  const inst = allInstances[selectedInstanceIdx];
  let ramMB = inst.ram ? parseInt(inst.ram) : globalSettings.defaultRam;
  if (ramMB < 128) ramMB = ramMB * 1024;

  document.getElementById("edit-modal-title").innerText =
    `${t("btn_settings")} : ${inst.name}`;
  document.getElementById("edit-name").value = inst.name;
  document.getElementById("edit-group").value = inst.group || "";
  document.getElementById("edit-ram-input").value = ramMB;
  document.getElementById("edit-ram-slider").value = ramMB;
  document.getElementById("edit-javapath").value = inst.javaPath || "";
  document.getElementById("edit-res-w").value = inst.resW || "";
  document.getElementById("edit-res-h").value = inst.resH || "";
  document.getElementById("edit-jvmargs").value = inst.jvmArgs || "";
  document.getElementById("edit-notes").value = inst.notes || "";
  document.getElementById("edit-icon-preview").src =
    inst.icon || defaultIcons[inst.loader] || defaultIcons.vanilla;
  document.getElementById("edit-backup-mode").value = inst.backupMode || "none";
  document.getElementById("edit-backup-limit").value = inst.backupLimit || 5;

  const btnModsTab = document.getElementById("tab-btn-mods");
  if (inst.loader === "vanilla") {
    btnModsTab.style.display = "none";
    if (targetTab === "tab-mods") targetTab = "tab-general";
  } else btnModsTab.style.display = "block";

  switchTab(targetTab);
  document.getElementById("modal-edit").style.display = "flex";
};
window.closeEditModal = () => {
  document.getElementById("modal-edit").style.display = "none";
  clearInterval(pingInterval);
};

window.saveInstance = () => {
  const name = document.getElementById("new-name").value;
  if (!name) return;
  allInstances.push({
    name,
    version: document.getElementById("new-version").value,
    loader: document.getElementById("new-loader").value,
    ram: document.getElementById("new-ram-input").value.toString(),
    javaPath: "",
    jvmArgs: "",
    notes: "",
    icon: "",
    resW: "",
    resH: "",
    playTime: 0,
    lastPlayed: 0,
    group: "",
    servers: [],
    backupMode: "none",
    backupLimit: 5,
  });
  fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  renderUI();
  closeInstanceModal();
};

window.saveEdit = () => {
  const inst = allInstances[selectedInstanceIdx];
  inst.name = document.getElementById("edit-name").value;
  inst.ram = document.getElementById("edit-ram-input").value;
  inst.group = document.getElementById("edit-group").value.trim();
  inst.javaPath = document.getElementById("edit-javapath").value;
  inst.resW = document.getElementById("edit-res-w").value;
  inst.resH = document.getElementById("edit-res-h").value;
  inst.jvmArgs = document.getElementById("edit-jvmargs").value;
  inst.notes = document.getElementById("edit-notes").value;
  inst.backupMode = document.getElementById("edit-backup-mode").value;
  inst.backupLimit =
    parseInt(document.getElementById("edit-backup-limit").value) || 5;
  const iconSrc = document.getElementById("edit-icon-preview").src;
  if (!iconSrc.includes("svg+xml")) inst.icon = iconSrc;
  fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  renderUI();
  closeEditModal();
};

window.openAccountModal = () => {
  document.getElementById("acc-name").value = "";
  document.getElementById("modal-account").style.display = "flex";
};
window.closeAccountModal = () =>
  (document.getElementById("modal-account").style.display = "none");

window.saveOfflineAccount = () => {
  const name = document.getElementById("acc-name").value.trim();
  if (!name) return;
  allAccounts.push({ type: "offline", name });
  selectedAccountIdx = allAccounts.length - 1;
  fs.writeFileSync(
    accountFile,
    JSON.stringify(
      { list: allAccounts, lastUsed: selectedAccountIdx },
      null,
      2,
    ),
  );
  document.getElementById("acc-name").value = "";
  renderUI();
};

window.loginMicrosoft = async () => {
  const btn = document.getElementById("btn-ms-login");
  const originalText = btn.innerText;
  btn.innerText = t("msg_conn_ms", "Connexion...");
  btn.disabled = true;
  try {
    const result = await ipcRenderer.invoke("login-microsoft");
    if (result.success) {
      allAccounts.push({
        type: "microsoft",
        name: result.auth.name,
        uuid: result.auth.uuid,
        mclcAuth: result.auth,
      });
      selectedAccountIdx = allAccounts.length - 1;
      fs.writeFileSync(
        accountFile,
        JSON.stringify(
          { list: allAccounts, lastUsed: selectedAccountIdx },
          null,
          2,
        ),
      );
      renderUI();
      closeAccountModal();
    } else
      showToast(t("msg_err_ms", "Erreur Microsoft : ") + result.error, "error");
  } catch (e) {
    showToast(t("msg_err_sys", "Erreur système : ") + e, "error");
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
};

window.deleteAccount = async (index) => {
  if (
    await showCustomConfirm(t("msg_remove_acc", "Retirer ce compte ?"), true)
  ) {
    allAccounts.splice(index, 1);
    if (selectedAccountIdx === index)
      selectedAccountIdx = allAccounts.length > 0 ? 0 : null;
    else if (selectedAccountIdx > index) selectedAccountIdx--;
    fs.writeFileSync(
      accountFile,
      JSON.stringify(
        { list: allAccounts, lastUsed: selectedAccountIdx },
        null,
        2,
      ),
    );
    renderUI();
  }
};

window.openDir = (f) => {
  const dir = path.join(
    instancesRoot,
    allInstances[selectedInstanceIdx].name.replace(/[^a-z0-9]/gi, "_"),
    f,
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
};

window.copyInstance = async () => {
  if (selectedInstanceIdx === null) return;
  const oldInst = allInstances[selectedInstanceIdx];
  let inst = JSON.parse(JSON.stringify(oldInst));
  let newName = inst.name + " - Copie";
  while (allInstances.some((i) => i.name === newName)) newName += " (2)";
  inst.name = newName;
  inst.playTime = 0;
  inst.lastPlayed = 0;

  showLoading(t("msg_copy", "Copie en cours..."));
  await yieldUI();
  try {
    const oldPath = path.join(
      instancesRoot,
      oldInst.name.replace(/[^a-z0-9]/gi, "_"),
    );
    if (fs.existsSync(oldPath))
      await fs.promises.cp(
        oldPath,
        path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_")),
        { recursive: true },
      );
    allInstances.push(inst);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  } catch (e) {
    sysLog("Erreur Copie: " + e, true);
  }
  hideLoading();
  renderUI();
};

window.deleteInstance = async () => {
  if (
    await showCustomConfirm(
      t("msg_delete_inst", "Supprimer l'instance ?"),
      true,
    )
  ) {
    allInstances.splice(selectedInstanceIdx, 1);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    selectedInstanceIdx = null;
    document.getElementById("panel-stats").style.display = "none";
    document.getElementById("action-panel").style.opacity = "0.4";
    document.getElementById("action-panel").style.pointerEvents = "none";
    document.getElementById("panel-title").innerText = t(
      "panel_title",
      "Sélectionnez une instance",
    );
    renderUI();
  }
};

window.exportInstance = async () => {
  if (selectedInstanceIdx === null) return;
  const inst = allInstances[selectedInstanceIdx];
  const safeName = inst.name.replace(/[^a-z0-9]/gi, "_");
  const sourceFolder = path.join(instancesRoot, safeName);
  const exportDir = path.join(dataDir, "exports");
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const zipPath = path.join(exportDir, `${safeName}.zip`);
  showLoading(t("msg_compress", "Compression..."));
  await yieldUI();

  try {
    const zip = new AdmZip();
    if (fs.existsSync(sourceFolder)) zip.addLocalFolder(sourceFolder, "files");
    zip.addFile(
      "instance.json",
      Buffer.from(JSON.stringify(inst, null, 2), "utf8"),
    );
    await new Promise((res, rej) =>
      zip.writeZip(zipPath, (err) => (err ? rej(err) : res())),
    );
    shell.showItemInFolder(zipPath);
  } catch (e) {
    sysLog("Erreur Export: " + e, true);
  }
  hideLoading();
};

async function handleZipImport(zipPath) {
  showLoading(t("msg_extract", "Extraction..."));
  await yieldUI();
  try {
    const zip = new AdmZip(zipPath);
    const metaEntry = zip.getEntry("instance.json");
    const cfEntry = zip.getEntry("manifest.json");

    if (cfEntry && !metaEntry) {
      hideLoading();
      showToast(
        t(
          "msg_err_cf",
          "Les modpacks CurseForge (.zip) sont bloqués par Overwolf. Cherchez la version Modrinth (.mrpack) dans le catalogue !",
        ),
        "error",
      );
      return;
    }

    if (!metaEntry) {
      hideLoading();
      return;
    }
    const meta = JSON.parse(zip.readAsText(metaEntry));
    let newName = meta.name;
    while (allInstances.some((i) => i.name === newName))
      newName += " (Importé)";
    meta.name = newName;
    meta.playTime = 0;
    meta.lastPlayed = 0;
    const destFolder = path.join(
      instancesRoot,
      meta.name.replace(/[^a-z0-9]/gi, "_"),
    );
    if (!fs.existsSync(destFolder))
      fs.mkdirSync(destFolder, { recursive: true });

    zip.getEntries().forEach((entry) => {
      if (
        entry.entryName.startsWith("files/") &&
        entry.entryName !== "files/"
      ) {
        const targetPath = path.join(destFolder, entry.entryName.substring(6));
        if (entry.isDirectory) {
          if (!fs.existsSync(targetPath))
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
          const dir = path.dirname(targetPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(targetPath, zip.readFile(entry));
        }
      }
    });
    allInstances.push(meta);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  } catch (err) {
    sysLog("Erreur Zip Import: " + err, true);
  }
  hideLoading();
  renderUI();
}
