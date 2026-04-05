const { ipcRenderer } = require("electron");
const { Client } = require("minecraft-launcher-core");
const { shell, clipboard } = require("electron");
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

window.openSystemPath = (p) => {
    if (p.startsWith("http")) {
        shell.openExternal(p); 
    } else if (process.platform === "win32") {
        exec(`explorer "${p}"`); 
    } else {
        shell.openPath(p); 
    }
};
const launcher = new Client();
const discordClientId = "1223633633633633633";

let rpc = new DiscordRPC.Client({ transport: "ipc" });
let rpcReady = false;
let pingInterval = null;
let collapsedGroups = {};
let maxSafeRam = 4096;
let skinViewer = null;
let activeAccountViewerIndex = null;
let pendingUpdateInfo = null;
let dragCounter = 0;

rpc
  .login({ clientId: discordClientId })
  .then(() => {
    rpcReady = true;
  })
  .catch(() => {});

function updateRPC(inst) {
  if (!rpcReady || !inst) return;
  try {
    let stateText = t("lbl_discord_solo", "En jeu");
    
    if (inst.autoConnect) {
        stateText = `${t("lbl_discord_playing", "Joue sur")} ${inst.autoConnect.split(':')[0]}`;
    } else {
        const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
        if (fs.existsSync(modsPath)) {
            const modCount = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar")).length;
            if (modCount > 0) stateText = `${modCount} mods`;
        }
    }

    rpc.setActivity({
      details: inst.name,
      state: stateText,
      startTimestamp: new Date(),
      largeImageKey: "logo",
      largeImageText: "Gens Launcher",
      buttons: [
          { label: t("btn_discord_download", "Télécharger Gens Launcher"), url: "https://github.com/WilliamBossard/Gens-Launcher" }
      ]
    });
  } catch (e) {}
}

function clearRPC() {
  if (!rpcReady) return;
  try {
    rpc.clearActivity();
  } catch (e) {}
}

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

window.copyMsDeviceCode = () => {
  const code = _msDeviceUserCode;
  if (!code) return;
  try {
    clipboard.writeText(code);
    showToast(t("ms_device_copied", "Code copié."), "success");
  } catch {
    showToast(t("msg_err_sys", "Erreur : ") + "clipboard", "error");
  }
};

window.openMsDevicePage = () => {
  const uri = _msDeviceVerificationUri;
  const code = _msDeviceUserCode;
  if (uri && /^https?:\/\//i.test(uri)) shell.openExternal(uri);
  else if (code)
    shell.openExternal(`https://www.microsoft.com/link?otc=${encodeURIComponent(code)}`);
};

window.cancelMsDeviceLogin = () => {
  ipcRenderer.send("cancel-login-microsoft");
  closeMicrosoftDeviceModal();
};

function openMicrosoftDeviceModal(data) {
  _msDeviceVerificationUri = data.verification_uri || "";
  _msDeviceUserCode = data.user_code || "";
  applyMsDeviceModalI18n();
  document.getElementById("ms-device-help").textContent = t(
    "ms_device_help",
    "Copie le code…"
  );
  document.getElementById("ms-device-code-display").textContent = _msDeviceUserCode;
  document.getElementById("ms-device-status").textContent = t(
    "ms_device_status_1",
    "En attente…"
  );
  document.getElementById("ms-device-footer-note").textContent = t(
    "ms_device_footer",
    ""
  );
  document.getElementById("modal-ms-device").style.display = "flex";
  if (_msDeviceFinalizeHintTimer) clearTimeout(_msDeviceFinalizeHintTimer);
  _msDeviceFinalizeHintTimer = setTimeout(() => {
    const modal = document.getElementById("modal-ms-device");
    const statusEl = document.getElementById("ms-device-status");
    if (modal && modal.style.display === "flex" && statusEl) {
      statusEl.textContent = t("ms_device_status_2", "Finalisation…");
    }
  }, 7000);
}

function closeMicrosoftDeviceModal() {
  document.getElementById("modal-ms-device").style.display = "none";
  if (_msDeviceFinalizeHintTimer) {
    clearTimeout(_msDeviceFinalizeHintTimer);
    _msDeviceFinalizeHintTimer = null;
  }
  _msDeviceVerificationUri = "";
  _msDeviceUserCode = "";
}

ipcRenderer.on("microsoft-device-code", (_event, data) => {
  if (!window._msLoginSessionActive) return;
  openMicrosoftDeviceModal(data);
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

window.showLoading = (text, percent = null) => {
    document.getElementById("loading-text").innerText = text;
    const pctEl = document.getElementById("loading-percent");
    pctEl.innerText = percent !== null ? percent + "%" : "";
    document.getElementById("loading-overlay").style.display = "flex";
};

window.updateLoadingPercent = (percent, text = null) => {
    const pctEl = document.getElementById("loading-percent");
    if (percent !== null) pctEl.innerText = percent + "%";
    if (text !== null) document.getElementById("loading-text").innerText = text;
};

window.hideLoading = () => {
    document.getElementById("loading-overlay").style.display = "none";
};

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
  `launcher_${new Date().toISOString().replace(/[:\.]/g, "-")}.log`
);
fs.writeFileSync(
  currentLogFile,
  `=== Gens Launcher Log - ${new Date().toLocaleString()} ===\n`
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
        "success"
      )
    );
};

document.getElementById("console-filter").addEventListener("input", (e) => {
    const filter = e.target.value.toLowerCase();
    const lines = document.querySelectorAll(".log-line");
    lines.forEach(line => {
        const text = line.innerText.toLowerCase();
        line.style.display = text.includes(filter) ? "block" : "none";
    });
});

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
  tab_updates: "Mises à jour",
  btn_check_launcher_updates: "Vérifier les mises à jour",
  msg_up_to_date: "Le launcher est à jour.",
  msg_update_found: "Une mise à jour a été trouvée",
  msg_download_update: "Voulez-vous la télécharger en arrière-plan ?",
  lbl_backup_mode: "Sauvegarde Automatique des Mondes",
  lbl_backup_limit: "Nombre de sauvegardes à conserver :",
  opt_none: "Désactivé",
  opt_launch: "Au lancement du jeu",
  opt_close: "A la fermeture du jeu",
  txt_backup_desc: "Le launcher conservera automatiquement vos sauvegardes dans le dossier 'backups'.",
  btn_open_backups: "Ouvrir le dossier des sauvegardes",
  lbl_lang: "Langue du Launcher",
  lbl_ram: "Mémoire RAM (Mo) :",
  lbl_java: "Chemin Java par défaut",
  btn_scan: "Scanner",
  lbl_fav_server: "Serveur favori",
  lbl_beta: "Afficher les Bêtas",
  lbl_loader: "Type de chargeur",
  lbl_loader_version: "Version du chargeur",
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
  lbl_panel_opacity: "Opacité de l'interface (Panneaux)",
  lbl_group: "Dossier / Catégorie de l'instance",
  msg_mod_added: "Ajouté à l'instance avec succès !",
  msg_select_inst: "Sélectionnez une instance d'abord !",
  msg_search_java: "Recherche de Java...",
  msg_java_found: "version(s) de Java trouvée(s).",
  msg_extract_java: "Extraction de Java...",
  msg_err_java: "Erreur Java",
  msg_backup: "Création de la sauvegarde...",
  msg_no_screen: "Aucune capture d'écran.",
  msg_launching: "Lancement de ",
  msg_check_java: "Vérification de Java...",
  msg_sync_servers: "Synchronisation des serveurs...",
  msg_install_fabric: "Installation de Fabric...",
  msg_prep_files: "Préparation des fichiers...",
  msg_dl: "Téléchargement : ",
  msg_game_stop: "Le jeu s'est arrêté",
  msg_conn_ms: "Connexion...",
  ms_device_title: "Connexion Microsoft",
  ms_device_help: "Copie le code ci-dessous, ouvre la page Microsoft, puis saisis le code quand le site le demande.",
  ms_device_copy: "Copier le code",
  ms_device_open: "Ouvrir la page Microsoft",
  ms_device_copied: "Code copié dans le presse-papiers.",
  ms_device_status_1: "En attente : valide le code sur le site Microsoft.",
  ms_device_status_2: "Finalisation côté launcher (serveurs Xbox / Mojang)… Peut prendre une dizaine de secondes.",
  ms_device_footer: "Tu peux fermer l’onglet du navigateur une fois la connexion acceptée ; cette fenêtre se fermera quand le compte sera enregistré.",
  ms_device_cancel: "Annuler",
  ms_device_cancelled: "Connexion Microsoft annulée.",
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
  msg_err_mrpack_invalid: "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant).",
  msg_err_mrpack: "Erreur Modpack : ",
  btn_copy_logs: "Copier",
  modal_confirm: "Confirmation",
  btn_yes: "Oui",
  btn_no: "Non",
  msg_err_cf: "Les modpacks CurseForge (.zip) sont bloqués par Overwolf. Cherchez la version Modrinth (.mrpack) dans le catalogue !",
  msg_err_path: "Erreur : Chemin introuvable (Lancez l'app via npm start !)",
  msg_err_format: "Format non supporté ! (.mrpack, .zip, .jar, .png)",
  modal_worlds_title: "Gestion des Mondes",
  msg_no_worlds: "Aucun monde trouvé.",
  btn_world_backup: "Sauvegarder",
  btn_world_copy: "Copier",
  msg_copy_world_loading: "Copie du monde en cours...",
  msg_world_copied: "Monde copié avec succès !",
  msg_delete_world_confirm: "Voulez-vous vraiment supprimer ce monde définitivement ?",
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
  btn_auto_ram: "Optimiser",
  tt_auto_ram: "Analyse votre PC et vos mods pour allouer la RAM parfaite (Min 4Go).",
  msg_ram_optimized: "RAM optimisée à ",
  modal_updates_title: "Mises à jour disponibles",
  msg_updates_available: "Les mods suivants vont être mis à jour :",
  btn_update_all: "Tout installer",
  msg_no_updates: "Tous vos mods sont à jour !",
  lbl_options_profile: "Profil d'Options (options.txt)",
  txt_options_desc: "Sélectionnez une instance pour que ses touches deviennent celles par défaut.",
  btn_save_options: "Définir comme défaut",
  msg_options_saved: "Profil d'options sauvegardé !",
  msg_no_options_found: "Aucun options.txt trouvé. Lancez le jeu au moins une fois sur cette instance !",
  msg_drop_mod: "Relâcher pour installer le mod",
  msg_drop_shader: "Relâcher pour installer le shader",
  msg_drop_rp: "Relâcher pour installer le pack",
  msg_files_added: "fichier(s) ajouté(s) !",
  modal_import_mc: "Importer un monde officiel",
  btn_import_official_world: "Importer depuis .minecraft",
  msg_no_mc_worlds: "Aucun monde trouvé dans .minecraft",
  msg_world_imported: "Monde importé avec succès !",
  lbl_sync_options: "Touches & Options",
  txt_sync_options: "Écrase les paramètres avec votre profil par défaut.",
  btn_sync_now: "Injecter",
  msg_force_sync_success: "Touches synchronisées avec succès !",
  msg_force_sync_error: "Aucun profil par défaut défini dans les Paramètres Globaux.",
  lbl_visibility: "Comportement au lancement",
  opt_keep: "Garder le launcher ouvert",
  opt_hide: "Cacher le launcher (Mode Fantôme)",
  btn_auto_connect: "Auto",
  msg_warn_deps: "Dépendance manquante potentielle : ",
  btn_show: "Afficher",
  btn_hide: "Masquer",
  lbl_news: "Actualités Minecraft",
  msg_server_search: "Recherche du serveur",
  msg_server_offline_desc: "Le serveur est actuellement hors-ligne ou injoignable.",
  msg_server_error: "Erreur de connexion à",
  lbl_players: "joueurs",
  modal_export_zip: "Export Complet (.zip)",
  txt_export_zip_desc: "Contient absolument tous vos mods et mondes (Fichier lourd).",
  modal_export_mrpack: "Export Léger (.mrpack)",
  txt_export_mrpack_desc: "Génère un fichier de quelques Ko idéal pour partager avec vos amis.",
  lbl_live_stats: "Monitoring Système",
  lbl_live_ram: "RAM Globale :",
  lbl_live_cpu: "Charge CPU :",
  msg_mrpack_analyze: "Analyse des mods et génération du .mrpack...",
  msg_mrpack_success: "Export .mrpack réussi !",
  msg_mrpack_error: "Erreur lors de l'export .mrpack",
  lbl_discord_playing: "Joue sur",
  lbl_discord_solo: "En jeu",
  btn_discord_download: "Télécharger Gens Launcher",
  msg_dl_browser: "Lien de téléchargement sécurisé... Ouverture du navigateur.",
  msg_cf_api_req: "CurseForge nécessite une clef API.\nAjoutez-la dans les Paramètres Globaux du launcher.",
  msg_cf_api_invalid: "Clef API CurseForge invalide ou erreur réseau.",
  lbl_warning: "[!]",
  lbl_accounts_title: "Comptes",
  lbl_add_microsoft: "Ajouter Microsoft",
  lbl_add_offline: "Ajouter Hors-Ligne",
  lbl_use_account: "Utiliser le compte",
  lbl_skin_cape: "Skin & Cape",
  lbl_active_acc: "Actif",
  modal_skin_title: "Visionneuse 3D de Skin",
  btn_test_skin: "Tester un Skin (Aperçu)",
  btn_export_skin: "Exporter le Skin actuel",
  btn_change_mojang: "Changer sur Minecraft.net",
  tip_skin_3d: "💡 Astuce : Cliquez et glissez pour pivoter. Molette pour zoomer.",
  btn_dl_shaders: "Télécharger de nouveaux shaders",
  btn_dl_rps: "Télécharger de nouveaux packs",
  ph_java_local: "Laisser vide pour utiliser le global",
  lbl_group_general: "Général",
  lbl_current_version: "Version actuelle :",
  ph_inst_name: "Ma Survie",
  ph_filter_logs: "Filtrer les logs...",
  msg_calc: "Calcul...",
  lbl_gb: "Go",
  msg_open_mp: "Ouverture de la page du modpack...",
  msg_dl_mp: "Téléchargement du modpack...",
  msg_install_mp: "Installation du modpack...",
  msg_patch_notes: "Correction de bugs et améliorations.",
  msg_update_ready: "Téléchargement terminé ! Voulez-vous redémarrer le launcher pour installer la mise à jour ?",
  lbl_cf_api: "Clé API CurseForge (Optionnel)",
  txt_cf_api_desc: "Nécessaire uniquement pour utiliser le catalogue CurseForge. Obtenez une clé gratuite sur EternalDeveloper.",
  msg_err_name_req: "Le nom de l'instance est obligatoire !",
  msg_profile_disabled: "Profil par défaut désactivé.",
  msg_err_install_loader: "Impossible d'installer le chargeur pour cette version.",
  msg_force_stop_sent: "Tentative d'arrêt forcé envoyée."
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
  tab_updates: "Updates",
  btn_check_launcher_updates: "Check for updates",
  msg_up_to_date: "The launcher is up to date.",
  msg_update_found: "An update was found",
  msg_download_update: "Do you want to download it in the background?",
  lbl_backup_mode: "World Auto-Backups",
  lbl_backup_limit: "Number of backups to keep:",
  opt_none: "Disabled",
  opt_launch: "On game launch",
  opt_close: "On game close",
  txt_backup_desc: "The launcher will automatically keep your latest backups in the 'backups' folder.",
  btn_open_backups: "Open Backups Folder",
  lbl_lang: "Launcher Language",
  lbl_ram: "Allocated RAM (MB):",
  lbl_java: "Default Java Path",
  btn_scan: "Scan",
  lbl_fav_server: "Favorite Server",
  lbl_beta: "Show Betas",
  lbl_loader: "Loader Type",
  lbl_loader_version: "Loader Version",
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
  lbl_panel_opacity: "Interface Opacity (Panels)",
  lbl_group: "Instance Folder / Category",
  msg_mod_added: "Successfully added to the instance!",
  msg_select_inst: "Please select an instance first!",
  msg_search_java: "Searching for Java...",
  msg_java_found: "Java version(s) found.",
  msg_extract_java: "Extracting Java...",
  msg_err_java: "Java Error",
  msg_backup: "Creating backup...",
  msg_no_screen: "No screenshots.",
  msg_launching: "Launching ",
  msg_check_java: "Verifying Java...",
  msg_sync_servers: "Synchronizing servers...",
  msg_install_fabric: "Installing Fabric...",
  msg_prep_files: "Preparing files...",
  msg_dl: "Downloading: ",
  msg_game_stop: "Game stopped",
  msg_conn_ms: "Logging in...",
  ms_device_title: "Microsoft sign-in",
  ms_device_help: "Copy the code below, open the Microsoft page, then enter the code when the site asks for it.",
  ms_device_copy: "Copy code",
  ms_device_open: "Open Microsoft page",
  ms_device_copied: "Code copied to clipboard.",
  ms_device_status_1: "Waiting: confirm the code on the Microsoft website.",
  ms_device_status_2: "Finishing in the launcher (Xbox / Mojang servers)… This can take around 10 seconds.",
  ms_device_footer: "You can close the browser tab after sign-in is accepted ; this window closes when the account is saved.",
  ms_device_cancel: "Cancel",
  ms_device_cancelled: "Microsoft sign-in cancelled.",
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
  msg_err_cf: "CurseForge (.zip) modpacks are blocked by Overwolf restrictions. Use Modrinth (.mrpack) instead!",
  msg_err_path: "Error: Path not found (Run the app via npm start!)",
  msg_err_format: "Unsupported format! (.mrpack, .zip, .jar, .png)",
  modal_worlds_title: "Worlds Manager",
  msg_no_worlds: "No worlds found.",
  btn_world_backup: "Backup",
  btn_world_copy: "Copy",
  msg_copy_world_loading: "Copying world...",
  msg_world_copied: "World copied successfully!",
  msg_delete_world_confirm: "Are you sure you want to permanently delete this world?",
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
  btn_auto_ram: "Optimize",
  tt_auto_ram: "Analyzes your PC and mods to allocate perfect RAM (Min 4GB).",
  msg_ram_optimized: "RAM optimized to ",
  modal_updates_title: "Updates Available",
  msg_updates_available: "The following mods will be updated:",
  btn_update_all: "Install All",
  msg_no_updates: "All mods are up to date!",
  lbl_options_profile: "Options Profile (options.txt)",
  txt_options_desc: "Set an instance's options as default for future instances.",
  btn_save_options: "Set as default",
  msg_options_saved: "Options profile saved!",
  msg_no_options_found: "No options.txt found. Launch the game at least once on this instance!",
  msg_drop_mod: "Drop to install mod",
  msg_drop_shader: "Drop to install shader",
  msg_drop_rp: "Drop to install pack",
  msg_files_added: "file(s) added!",
  modal_import_mc: "Import Official World",
  btn_import_official_world: "Import from .minecraft",
  msg_no_mc_worlds: "No worlds found in .minecraft",
  msg_world_imported: "World imported successfully!",
  lbl_sync_options: "Keybinds & Options",
  txt_sync_options: "Overwrite settings with your default profile.",
  btn_sync_now: "Inject",
  msg_force_sync_success: "Options synced successfully!",
  msg_force_sync_error: "No default profile set in Global Settings.",
  lbl_visibility: "Launcher behavior on launch",
  opt_keep: "Keep open",
  opt_hide: "Hide launcher (Ghost Mode)",
  btn_auto_connect: "Auto",
  msg_warn_deps: "Potential missing dependency: ",
  btn_show: "Show",
  btn_hide: "Hide",
  lbl_news: "Minecraft News",
  msg_server_search: "Searching for server",
  msg_server_offline_desc: "The server is currently offline or unreachable.",
  msg_server_error: "Connection error to",
  lbl_players: "players",
  modal_export_zip: "Full Export (.zip)",
  txt_export_zip_desc: "Contains absolutely all your mods and worlds (Large file).",
  modal_export_mrpack: "Light Export (.mrpack)",
  txt_export_mrpack_desc: "Generates a tiny file ideal for sharing with friends.",
  lbl_live_stats: "System Monitoring",
  lbl_live_ram: "Global RAM:",
  lbl_live_cpu: "CPU Load:",
  msg_mrpack_analyze: "Analyzing mods and generating .mrpack...",
  msg_mrpack_success: ".mrpack export successful!",
  msg_mrpack_error: "Error during .mrpack export",
  lbl_discord_playing: "Playing on",
  lbl_discord_solo: "In game",
  btn_discord_download: "Download Gens Launcher",
  msg_dl_browser: "Secure download link... Opening browser.",
  msg_cf_api_req: "CurseForge requires an API Key.\nAdd it in the Launcher Global Settings.",
  msg_cf_api_invalid: "Invalid CurseForge API Key or network error.",
  lbl_warning: "[!]",
  lbl_accounts_title: "Accounts",
  lbl_add_microsoft: "Add Microsoft",
  lbl_add_offline: "Add Offline",
  lbl_use_account: "Use Account",
  lbl_skin_cape: "Skin & Cape",
  lbl_active_acc: "Active",
  modal_skin_title: "3D Skin Viewer",
  btn_test_skin: "Test a Skin (Preview)",
  btn_export_skin: "Export current Skin",
  btn_change_mojang: "Change on Minecraft.net",
  tip_skin_3d: "💡 Tip: Click and drag to rotate. Scroll to zoom.",
  btn_dl_shaders: "Download new shaders",
  btn_dl_rps: "Download new packs",
  ph_java_local: "Leave empty to use global",
  lbl_group_general: "General",
  lbl_current_version: "Current version:",
  ph_inst_name: "My Survival",
  ph_filter_logs: "Filter logs...",
  msg_calc: "Calculating...",
  lbl_gb: "GB",
  msg_open_mp: "Opening modpack page...",
  msg_dl_mp: "Downloading modpack...",
  msg_install_mp: "Installing modpack...",
  msg_patch_notes: "Bug fixes and improvements.",
  msg_update_ready: "Download complete! Do you want to restart the launcher to install the update?",
  lbl_cf_api: "CurseForge API Key (Optional)",
  txt_cf_api_desc: "Required only to use the CurseForge catalog. Get a free key on EternalDeveloper.",
  msg_err_name_req: "Instance name is required!",
  msg_profile_disabled: "Default profile disabled.",
  msg_err_install_loader: "Cannot install loader for this version.",
  msg_force_stop_sent: "Force stop request sent."
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

window.applyTranslations = () => {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (currentLangObj[key]) {
      if (el.tagName === "INPUT" && el.type === "text")
        el.placeholder = currentLangObj[key];
      else el.innerText = currentLangObj[key];
    }
  });
  
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (currentLangObj[key]) {
        el.title = currentLangObj[key];
    }
  });

  document.querySelectorAll("[data-i18n-tooltip]").forEach((el) => {
      const key = el.getAttribute("data-i18n-tooltip");
      if (currentLangObj[key]) {
          el.setAttribute("data-tooltip", currentLangObj[key]);
      }
  });

  const cv = document.getElementById("current-app-version");
  if(cv) cv.innerText = "v" + require("./package.json").version;
  
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
    panelOpacity: 0.6
  };
  root.style.setProperty("--accent", th.accent);

  const op = th.panelOpacity !== undefined ? th.panelOpacity : 0.6;
  const appBg = document.getElementById("app-background");
  
  if (th.bg && fs.existsSync(th.bg)) {
    appBg.style.backgroundImage = `url("file:///${encodeURI(th.bg.replace(/\\/g, "/"))}")`;
    appBg.style.filter = `blur(${th.blur}px) brightness(${1 - th.dim})`;
    
    root.style.setProperty("--bg-main", `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
    root.style.setProperty("--bg-panel", `rgba(45, 45, 48, ${op})`);
    root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
  } else {
    appBg.style.backgroundImage = "none";
    root.style.setProperty("--bg-main", "#1e1e1e");
    root.style.setProperty("--bg-panel", "#2d2d30");
    root.style.setProperty("--bg-toolbar", "#333337");
  }
}

async function loadNews() {
    try {
        const res = await fetch("https://launchercontent.mojang.com/news.json");
        const data = await res.json();
        const container = document.getElementById("news-container");
        
        const isCollapsed = globalSettings.newsCollapsed;
        const toggleText = isCollapsed ? t("btn_show", "Afficher") : t("btn_hide", "Masquer");
        
        let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
            <div style="font-weight: bold; color: var(--text-light);">${t("lbl_news", "Actualités Minecraft")}</div>
            <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="toggleNews()" id="btn-toggle-news">${toggleText}</button>
        </div>
        <div id="news-content-wrapper" style="display: ${isCollapsed ? 'none' : 'block'};">`;
        
        data.entries.slice(0, 6).forEach(news => {
            const imgUrl = `https://launchercontent.mojang.com${news.playPageImage.url}`;
            const link = news.readMoreLink.startsWith("http") ? news.readMoreLink : `https://minecraft.net${news.readMoreLink}`;
            html += `
            <div class="news-card" onclick="openSystemPath('${link}')">
                <img src="${imgUrl}" class="news-img">
                <div class="news-content">
                    <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${news.title}</div>
                    <div style="font-size: 0.7rem; color: var(--accent);">${news.category}</div>
                </div>
            </div>`;
        });
        
        html += `</div>`;
        container.innerHTML = html;
    } catch(e) {
        console.log("Impossible de charger les actualités.");
    }
}

window.toggleNews = () => {
    globalSettings.newsCollapsed = !globalSettings.newsCollapsed;
    fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
    
    const wrapper = document.getElementById("news-content-wrapper");
    const btn = document.getElementById("btn-toggle-news");
    
    if (globalSettings.newsCollapsed) {
        wrapper.style.display = "none";
        btn.innerText = t("btn_show", "Afficher");
    } else {
        wrapper.style.display = "block";
        btn.innerText = t("btn_hide", "Masquer");
    }
    renderUI();
};

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
  const banner = document.getElementById("server-banner-container");

  if (!ip) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  
  if (banner.innerHTML === "") {
      banner.innerHTML = `<div style="text-align:center; width:100%; color:#aaa;">${t("msg_server_search", "Recherche du serveur")} ${ip}...</div>`;
  }

  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${ip}`);
    const data = await res.json();
    
    let iconHtml = data.icon ? `<img src="${data.icon}" style="width: 64px; height: 64px; border-radius: 4px; margin-right: 15px; image-rendering: pixelated;">` : `<div style="width: 64px; height: 64px; background: #000; border-radius: 4px; margin-right: 15px;"></div>`;
    let motdHtml = data.motd && data.motd.html ? data.motd.html.join('<br>') : "Serveur Minecraft";
    
    if (data.online) {
      banner.innerHTML = `
        ${iconHtml}
        <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
            <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${ip}</div>
            <div style="font-size: 0.85rem; color: #aaa; font-family: 'Consolas', monospace; background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px;">${motdHtml}</div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; justify-content: center; min-width: 100px;">
            <div style="color: #17B139; font-weight: bold; font-size: 1.2rem;">[+] ${t("msg_online", "En ligne")}</div>
            <div style="color: var(--text-light);">${data.players.online} / ${data.players.max} ${t("lbl_players", "joueurs")}</div>
        </div>
      `;
    } else {
      banner.innerHTML = `
        <div style="width: 64px; height: 64px; background: #333; border-radius: 4px; margin-right: 15px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold;">[X]</div>
        <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
            <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${ip}</div>
            <div style="font-size: 0.85rem; color: #f87171;">${t("msg_server_offline_desc", "Le serveur est actuellement hors-ligne ou injoignable.")}</div>
        </div>
      `;
    }
  } catch (e) {
     banner.innerHTML = `<div style="color:#f87171; padding: 10px; width:100%; text-align:center;">${t("msg_server_error", "Erreur de connexion à")} ${ip}</div>`;
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
      "mods"
    );
    if (fs.existsSync(modsPath)) {
      totalMods += fs
        .readdirSync(modsPath)
        .filter(
          (f) => f.endsWith(".jar") || f.endsWith(".jar.disabled")
        ).length;
    }
  });

  let h = Math.floor(totalTimeMs / 3600000);
  let m = Math.floor((totalTimeMs % 3600000) / 60000);

  document.getElementById("dashboard-time").innerText = `${h}h ${m}m`;
  document.getElementById("dashboard-instances").innerText = allInstances.length;
  document.getElementById("dashboard-mods").innerText = totalMods;
  document.getElementById("dashboard-fav").innerText = maxTime > 0 ? favInstance : "-";
  document.getElementById("dashboard-disk").innerText = t("msg_calc", "Calcul...");

  const graphDiv = document.getElementById("dashboard-graph");
  if (graphDiv) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const totals = {};
    days.forEach(d => totals[d] = 0);
    allInstances.forEach(inst => {
      (inst.sessionHistory || []).forEach(s => {
        if (totals[s.date] !== undefined) totals[s.date] += s.ms;
      });
    });
    const maxMs = Math.max(...Object.values(totals), 1);
    graphDiv.innerHTML = days.map(d => {
      const ms = totals[d];
      const perc = Math.round((ms / maxMs) * 100);
      const label = d.slice(5); 
      const hh = Math.floor(ms / 3600000);
      const mm = Math.floor((ms % 3600000) / 60000);
      const title = ms > 0 ? `${hh}h ${mm}m` : "0";
      return `<div title="${label} : ${title}" style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; cursor:default;">
        <div style="width:100%; background:var(--accent); border-radius:3px 3px 0 0; opacity:${ms > 0 ? 0.85 : 0.15}; height:${Math.max(perc, ms > 0 ? 4 : 2)}%; transition:height 0.3s;"></div>
        <div style="font-size:0.6rem; color:#aaa; white-space:nowrap;">${label}</div>
      </div>`;
    }).join("");
  }

  document.getElementById("modal-stats").style.display = "flex";

  const sizeBytes = await getDirSizeAsync(dataDir);
  const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
  if (document.getElementById("modal-stats").style.display === "flex") {
    document.getElementById("dashboard-disk").innerText = `${sizeGB} ${t("lbl_gb", "Go")}`;
  }
};

window.closeStatsModal = () => {
  document.getElementById("modal-stats").style.display = "none";
};

window.handleImport = async (input) => {
    const file = input.files[0];
    if (!file) return;
    const p = file.path;
    input.value = ""; 
    
    if (p.endsWith('.zip')) await handleZipImport(p);
    else if (p.endsWith('.mrpack')) await handleMrPackImport(p);
    else showToast(t("msg_err_format", "Format non supporté !"), "error");
};

async function handleZipImport(zipPath) {
    showLoading(t("msg_extract", "Extraction..."));
    await yieldUI();
    try {
        const zip = new AdmZip(zipPath);
        const instanceEntry = zip.getEntry("instance.json");

        if (!instanceEntry) {
            throw new Error("Fichier instance.json introuvable. Ce n'est pas une sauvegarde valide du launcher.");
        }

        const instData = JSON.parse(zip.readAsText(instanceEntry));
        const originalName = instData.name || "Instance Importée";

        let finalName = originalName;
        let counter = 1;
        while (allInstances.some(i => i.name === finalName)) {
            finalName = `${originalName} (${counter})`;
            counter++;
        }

        instData.name = finalName;
        const instDir = path.join(instancesRoot, finalName.replace(/[^a-z0-9]/gi, "_"));
        if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

        zip.getEntries().forEach(entry => {
            if (entry.entryName.startsWith("files/") && entry.entryName !== "files/") {
                const relPath = entry.entryName.substring(6);
                const targetPath = path.join(instDir, relPath);

                if (entry.isDirectory) {
                    if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
                } else {
                    const dir = path.dirname(targetPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(targetPath, zip.readFile(entry));
                }
            }
        });

        allInstances.push(instData);
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));

        showToast(t("msg_install_success", "Installation réussie !"), "success");
    } catch (err) {
        sysLog("Erreur Import ZIP : " + err.message, true);
        showToast("Erreur Import : " + err.message, "error");
    }
    hideLoading();
    renderUI();
}

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
          "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant)."
        ),
        "error"
      );
      return;
    }

    const index = JSON.parse(zip.readAsText(indexEntry));
    const packName = index.name || "Modpack Importé";
    const mcVer = index.dependencies.minecraft;

    let loaderType = "vanilla";
    let loaderVer = "";
    
    if (index.dependencies["fabric-loader"]) {
        loaderType = "fabric";
        loaderVer = index.dependencies["fabric-loader"];
    } else if (index.dependencies.forge) {
        loaderType = "forge";
        loaderVer = index.dependencies.forge;
    } else if (index.dependencies.neoforge) {
        loaderType = "neoforge";
        loaderVer = index.dependencies.neoforge;
    }

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
      loaderVersion: loaderVer,
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
      finalName.replace(/[^a-z0-9]/gi, "_")
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

    const queue = index.files.filter(f => !(f.env && f.env.client === "unsupported"));
    const totalToDownload = queue.length;
    let downloadedCount = 0;

    showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`);
    await yieldUI();

    const concurrencyLimit = 10; 
    
    showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);

    const workers = Array(concurrencyLimit).fill(null).map(async () => {
        while (queue.length > 0) {
            const modFile = queue.shift();
            const modPath = path.join(instDir, modFile.path);
            const dir = path.dirname(modPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            try {
                const res = await fetch(modFile.downloads[0]);
                if (res.ok) {
                    const buffer = await res.arrayBuffer();
                    fs.writeFileSync(modPath, Buffer.from(buffer));
                }
            } catch (e) {
                sysLog(`Erreur téléchargement fichier modpack: ${modFile.downloads[0]} - ${e.message}`, true);
            }
            downloadedCount++;
            
            let pct = Math.round((downloadedCount / totalToDownload) * 100);
            updateLoadingPercent(pct, `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
        }
    });

    await Promise.all(workers);

    const defaultOpt = path.join(dataDir, "default_options.txt");
    if (fs.existsSync(defaultOpt)) {
        try { fs.copyFileSync(defaultOpt, path.join(instDir, "options.txt")); } catch(e) {}
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
  vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
  forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
  fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E",
  quilt: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%237c3aed'/%3E%3Crect x='0' y='0' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='3' y='3' width='2' height='2' fill='%23fff'/%3E%3Crect x='11' y='11' width='2' height='2' fill='%23fff'/%3E%3C/svg%3E",
  neoforge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23f48a21'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%23ffffff'/%3E%3C/svg%3E"
};

let allInstances = [],
  allAccounts = [],
  rawVersions = [];
let globalSettings = {
  defaultRam: 4096,
  defaultJavaPath: "",
  cfApiKey: "", 
  serverIp: "",
  language: null,
  theme: { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 },
  launcherVisibility: "keep",
  newsCollapsed: false
};
let selectedInstanceIdx = null,
  selectedAccountIdx = null;
let isGameRunning = false;
let sessionStartTime = 0;

document.addEventListener("DOMContentLoaded", () => {
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
  loadNews(); 

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
  updateLoaderVersions();
};

window.updateLoaderVersions = async () => {
    const mcVer = document.getElementById("new-version").value;
    const loader = document.getElementById("new-loader").value;
    const container = document.getElementById("loader-version-container");
    const select = document.getElementById("new-loader-version");
    
    select.innerHTML = "<option>Chargement...</option>";
    
    if (loader === "vanilla") {
        container.style.display = "none";
        return;
    }
    
    container.style.display = "block";
    try {
        let versions = [];
        
        if (loader === "fabric") {
            const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVer}`);
            const data = await res.json();
            versions = data.map(d => d.loader.version);
            
        } else if (loader === "quilt") {
            const res = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${mcVer}`);
            const data = await res.json();
            versions = data.map(d => d.loader.version);
            
        } else if (loader === "forge") {
            const res = await fetch(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVer}`);
            const data = await res.json();
            versions = data.map(d => d.version);
            
        } else if (loader === "neoforge") {
            const parts = mcVer.split('.');
            const prefix = parts[1] + "." + (parts[2] || "0") + "."; 
            const neoRes = await fetch("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
            const neoXml = await neoRes.text();
            const neoDoc = new DOMParser().parseFromString(neoXml, "text/xml");
            const allVers = Array.from(neoDoc.querySelectorAll("version")).map(v => v.textContent).reverse();
            versions = allVers.filter(v => v.startsWith(prefix));
        }
        
        select.innerHTML = "";
        if (versions.length === 0) {
            select.innerHTML = `<option value="">Incompatible avec la ${mcVer}</option>`;
        } else {
            versions.forEach(v => {
                const opt = document.createElement("option");
                opt.value = v;
                opt.innerText = v;
                select.appendChild(opt);
            });
        }
    } catch(e) {
        select.innerHTML = `<option value="">Incompatible</option>`;
    }
};

function loadStorage() {
  if (fs.existsSync(settingsFile)) {
    globalSettings = Object.assign(
      globalSettings,
      JSON.parse(fs.readFileSync(settingsFile)),
    );
    if (globalSettings.defaultRam > maxSafeRam)
      globalSettings.defaultRam = maxSafeRam;
    if (globalSettings.newsCollapsed === undefined) 
      globalSettings.newsCollapsed = false;
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

  setTimeout(async () => {
      for (let i = 0; i < allAccounts.length; i++) {
          const acc = allAccounts[i];
          if (acc.type === "microsoft" && acc.mclcAuth?.meta?.msaCacheKey) {
              try {
                  const refreshed = await ipcRenderer.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
                  if (refreshed.success) {
                      allAccounts[i].mclcAuth.access_token = refreshed.access_token;
                      sysLog(`Token Microsoft rafraîchi au démarrage pour : ${acc.name}`);
                  } else {
                      sysLog(`Refresh échoué pour ${acc.name} : ${refreshed.error}`, true);
                  }
              } catch(e) {
                  sysLog(`Erreur refresh démarrage ${acc.name}: ${e}`, true);
              }
          }
      }
      if (allAccounts.some(a => a.type === "microsoft")) {
          fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
      }
  }, 2000);
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

  const newsContainer = document.getElementById("news-container");
  if (search === "") {
      newsContainer.style.display = "block";
  } else {
      newsContainer.style.display = "none";
  }

  let displayList = allInstances.map((inst, i) => ({
    ...inst,
    originalIndex: i,
  }));
  displayList = displayList.filter((inst) =>
    inst.name.toLowerCase().includes(search)
  );
  displayList.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "lastPlayed") return (b.lastPlayed || 0) - (a.lastPlayed || 0);
    if (sort === "playTime") return (b.playTime || 0) - (a.playTime || 0);
  });

  const groups = {};
  const groupSet = new Set();
  displayList.forEach((inst) => {
    const g = inst.group && inst.group.trim() !== "" ? inst.group : t("lbl_group_general", "Général");
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
    activeSkin.src = `https://mc-heads.net/avatar/${allAccounts[selectedAccountIdx].name}/20?t=${Date.now()}`;
  } else activeSkin.style.display = "none";

  updateLaunchButton();
}

let uiSelectedAccRow = null; 

window.openAccountModal = () => {
    document.getElementById("acc-name").value = "";
    document.getElementById("offline-input-container").style.display = "none";
    document.getElementById("modal-account").style.display = "flex";
    
    uiSelectedAccRow = selectedAccountIdx;
    renderAccountManager();
};

function renderAccountManager() {
    const list = document.getElementById("account-list");
    list.innerHTML = "";
    
    const btnUse = document.getElementById("btn-use-acc");
    const btnDel = document.getElementById("btn-del-acc");
    const btnSkin = document.getElementById("btn-skin-acc");

    if (allAccounts.length === 0) {
        list.innerHTML = `<div style="padding: 20px; color: #aaa; text-align: center;">Aucun profil enregistré.</div>`;
        if (btnUse) btnUse.disabled = true;
        if (btnDel) btnDel.disabled = true;
        if (btnSkin) btnSkin.disabled = true;
        uiSelectedAccRow = null;
        return;
    }

    if (btnUse) btnUse.disabled = (uiSelectedAccRow === null || uiSelectedAccRow === selectedAccountIdx);
    if (btnDel) btnDel.disabled = (uiSelectedAccRow === null);
    if (btnSkin) btnSkin.disabled = (uiSelectedAccRow === null);

    allAccounts.forEach((acc, i) => {
        const isSelected = uiSelectedAccRow === i;
        const isActive = selectedAccountIdx === i;

        const typeText = acc.type === "microsoft" ? "Compte Microsoft" : "Hors-Ligne (Crack)";
        const activeText = isActive ? `✔ ${t("lbl_active_acc", "Actif")}` : "";

list.innerHTML += `
        <div class="mmc-account-item ${isSelected ? 'selected' : ''}" onclick="selectAccountRow(${i})" ondblclick="useSelectedRow()">
            <img src="https://mc-heads.net/avatar/${acc.name}/32?t=${Date.now()}" alt="${acc.name}">
            <div class="mmc-info">
                <div class="mmc-name">${acc.name}</div>
                <div class="mmc-type">${typeText}</div>
            </div>
            <div class="mmc-active-label">${activeText}</div>
        </div>`;
    });
}

window.selectAccountRow = (index) => {
    uiSelectedAccRow = index;
    renderAccountManager();
};

window.useSelectedRow = () => {
    if (uiSelectedAccRow !== null) {
        selectedAccountIdx = uiSelectedAccRow;
        changeAccountFromCode();
        renderAccountManager();
    }
};

window.deleteSelectedRow = async () => {
    if (uiSelectedAccRow === null) return;
    if (await showCustomConfirm(t("msg_remove_acc", "Retirer ce compte ?"), true)) {
        allAccounts.splice(uiSelectedAccRow, 1);
        
        if (selectedAccountIdx === uiSelectedAccRow) {
            selectedAccountIdx = allAccounts.length > 0 ? 0 : null;
        } else if (selectedAccountIdx > uiSelectedAccRow) {
            selectedAccountIdx--;
        }
        
        uiSelectedAccRow = selectedAccountIdx;
        changeAccountFromCode();
        renderAccountManager();
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
    const name = document.getElementById("acc-name").value.trim();
    if (!name) return;
    allAccounts.push({ type: "offline", name });
    selectedAccountIdx = allAccounts.length - 1;
    uiSelectedAccRow = selectedAccountIdx; 
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    
    document.getElementById("acc-name").value = "";
    document.getElementById("offline-input-container").style.display = "none";
    
    renderAccountManager();
    changeAccountFromCode();
};

window.closeAccountModal = () => {
    document.getElementById("modal-account").style.display = "none";
};

window.changeAccountFromCode = () => {
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    renderUI();
};

function getModWarnings(inst) {
    const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
    let provided = new Set(["minecraft", "java", "fabricloader", "forge", "quilt", "quilt_loader", "fabric"]);
    let reqs = {};
    if (!fs.existsSync(modsPath)) return {};
    
    const files = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
    
    files.forEach(f => {
        try {
            const zip = new AdmZip(path.join(modsPath, f));
            let entry = zip.getEntry("fabric.mod.json") || zip.getEntry("quilt.mod.json");
            if (entry) {
                const json = JSON.parse(zip.readAsText(entry));
                if (json.id) provided.add(json.id);
                if (json.provides) json.provides.forEach(p => provided.add(p));
                if (json.depends) {
                    reqs[f] = Object.keys(json.depends);
                }
            } else {
                let forgeEntry = zip.getEntry("META-INF/mods.toml");
                if (forgeEntry) {
                    const text = zip.readAsText(forgeEntry);
                    const idMatch = text.match(/modId\s*=\s*"([^"]+)"/);
                    if (idMatch) provided.add(idMatch[1]);
                    
                    const blockRegex = /\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*"([^"]+)"/g;
                    let m;
                    while ((m = blockRegex.exec(text)) !== null) {
                        if (!reqs[f]) reqs[f] = [];
                        reqs[f].push(m[1]);
                    }
                }
            }
        } catch(e) {}
    });

    let warnings = {};
    for (let f in reqs) {
        reqs[f].forEach(reqId => {
            if (!provided.has(reqId) && !reqId.includes("forge")) {
                if (!warnings[f]) warnings[f] = [];
                warnings[f].push(reqId);
            }
        });
    }
    return warnings;
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
  
  const warnings = getModWarnings(inst);
  let hasMods = false;
  
  fs.readdirSync(modsPath).forEach((file) => {
    if (file.endsWith(".jar") || file.endsWith(".jar.disabled")) {
      hasMods = true;
      const isEnabled = !file.endsWith(".disabled");
      const displayName = file.replace(".jar.disabled", ".jar");
      const color = isEnabled ? "var(--text-light)" : "#666";
      const decoration = isEnabled ? "none" : "line-through";
      
      let warningHtml = "";
      if (warnings[file]) {
          warningHtml = `<span class="custom-tooltip-trigger" data-tooltip="${t("msg_warn_deps", "Dépendance manquante potentielle : ")}${warnings[file].join(', ')}" style="margin-left:6px; color:#f87171; font-size:0.9rem; font-weight:bold;">${t("lbl_warning", "[!]")}</span>`;
      }
      
      modsListDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration}; display:flex; align-items:center;">${displayName}${warningHtml}</span><input type="checkbox" ${isEnabled ? "checked" : ""} onchange="toggleMod('${file}', this.checked)"></div>`;
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
    "mods"
  );
  fs.renameSync(
    path.join(modsPath, filename),
    path.join(
      modsPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled"
    )
  );
  renderModsManager();
};

window.toggleShader = (filename, isEnabled) => {
  const inst = allInstances[selectedInstanceIdx];
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "shaderpacks"
  );
  fs.renameSync(
    path.join(targetPath, filename),
    path.join(
      targetPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled"
    )
  );
  renderShadersManager();
};

window.toggleResourcePack = (filename, isEnabled) => {
  const inst = allInstances[selectedInstanceIdx];
  const targetPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "resourcepacks"
  );
  fs.renameSync(
    path.join(targetPath, filename),
    path.join(
      targetPath,
      isEnabled ? filename.replace(".disabled", "") : filename + ".disabled"
    )
  );
  renderResourcePacksManager();
};

let pendingUpdates = [];

window.checkModUpdates = async () => {
  const inst = allInstances[selectedInstanceIdx];
  if (!inst) return;
  const modsPath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "mods"
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
      }
    );
    const data = await res.json();
    
    pendingUpdates = [];
    let listHTML = "";

    for (let oldHash in data) {
      const newFileObj =
        data[oldHash].files.find((f) => f.primary) || data[oldHash].files[0];
      if (newFileObj.filename !== hashes[oldHash]) {
          pendingUpdates.push({
              oldFile: hashes[oldHash],
              newFileObj: newFileObj
          });
          listHTML += `<div style="margin-bottom: 5px;">- <span style="color:#f87171; text-decoration:line-through;">${hashes[oldHash]}</span> -> <span style="color:#17B139;">${newFileObj.filename}</span></div>`;
      }
    }
    hideLoading();
    
    if (pendingUpdates.length > 0) {
        document.getElementById("updates-list").innerHTML = listHTML;
        document.getElementById("modal-updates").style.display = "flex";
        
        document.getElementById("btn-confirm-updates").onclick = async () => {
            document.getElementById("modal-updates").style.display = "none";
            await executeModUpdates();
        };
    } else {
        showToast(t("msg_no_updates", "Aucune mise à jour trouvée."), 'info');
    }
  } catch (e) {
    hideLoading();
    showToast(t("msg_err_dl", "Erreur."), "error");
  }
};

async function executeModUpdates() {
    const inst = allInstances[selectedInstanceIdx];
    const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
    
    let updatedCount = 0;
    const total = pendingUpdates.length;

    showLoading(`${t("msg_updating", "Mise à jour...")}`, 0);

    for (let update of pendingUpdates) {
        updateLoadingPercent(Math.round((updatedCount / total) * 100), `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`);
        await yieldUI();
        
        try {
            const buffer = await (await fetch(update.newFileObj.url)).arrayBuffer();
            fs.writeFileSync(path.join(modsPath, update.newFileObj.filename), Buffer.from(buffer));
            fs.unlinkSync(path.join(modsPath, update.oldFile));
            updatedCount++;
        } catch(e) {}
    }
    
    hideLoading();
    showToast(`${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`, 'success');
    renderModsManager();
}

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
  const source = document.getElementById("catalog-source").value;
  const query = document.getElementById("catalog-search").value;
  const loader = document.getElementById("catalog-loader").value;
  const version = document.getElementById("catalog-version").value;
  const type = document.getElementById("catalog-type").value;
  const resDiv = document.getElementById("catalog-results");
  
  resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_search_java", "Recherche...")}</div>`;

  try {
    if (source === "modrinth") {
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
                            <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 5px;">${mod.author || "Auteur"} - ${downloads} (Modrinth)</div>
                            <div style="font-size: 0.8rem; color: var(--text-main);">${mod.description}</div>
                        </div>
                        <button class="btn-primary" onclick="installGlobalMod('${mod.project_id}', false, '${type}', 'modrinth')">${t("btn_install", "Installer")}</button>
                    </div>`;
        });
    } 
    else if (source === "curseforge") {
        const apiKey = globalSettings.cfApiKey;
        if (!apiKey) {
            resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>${t("msg_cf_api_req")}</div>`;
            return;
        }

        let cfClassId = 6; 
        if (type === "modpack") cfClassId = 4471;
        if (type === "resourcepack") cfClassId = 12;
        if (type === "shader") cfClassId = 6552;

        let modLoaderType = 0; 
        if (loader === "forge") modLoaderType = 1;
        if (loader === "fabric") modLoaderType = 4;
        if (loader === "neoforge") modLoaderType = 6;

        const url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=${cfClassId}&searchFilter=${encodeURIComponent(query)}&gameVersion=${version}&modLoaderType=${modLoaderType}&sortField=2&sortOrder=desc&pageSize=20`;
        
        const res = await fetch(url, { headers: { "x-api-key": apiKey } });
        if (!res.ok) throw new Error(t("msg_cf_api_invalid"));
        const data = await res.json();

        resDiv.innerHTML = "";
        if (data.data.length === 0) {
          resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_no_compat", "Aucun résultat.")}</div>`;
          return;
        }

        data.data.forEach((mod) => {
          const downloads = (mod.downloadCount / 1000000).toFixed(1) + "M DLs";
          const icon = mod.logo ? mod.logo.thumbnailUrl : "";
          const author = mod.authors.length > 0 ? mod.authors[0].name : "Auteur";
          
          resDiv.innerHTML += `
                    <div class="catalog-card">
                        <img src="${icon}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                        <div style="flex-grow: 1; display: flex; flex-direction: column;">
                            <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${mod.name}</div>
                            <div style="font-size: 0.75rem; color: #f48a21; margin-bottom: 5px;">${author} - ${downloads} (CurseForge)</div>
                            <div style="font-size: 0.8rem; color: var(--text-main);">${mod.summary}</div>
                        </div>
                        <button class="btn-primary" onclick="installGlobalMod('${mod.id}', false, '${type}', 'curseforge')" style="background:#f48a21; border-color:#f48a21;">${t("btn_install", "Installer")}</button>
                    </div>`;
        });
    }
  } catch (e) {
    resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>Erreur de recherche. ${e.message || ""}</div>`;
  }
};

window.installGlobalMod = async (projectId, isDependency = false, projType = "mod", source = "modrinth") => {
  if (projType !== "modpack" && selectedInstanceIdx === null) {
    showToast(t("msg_select_inst", "Sélectionnez une instance d'abord !"), "error");
    return;
  }

  const statusText = document.getElementById("catalog-status");
  let loader, version;

  if (projType !== "modpack") {
    const inst = allInstances[selectedInstanceIdx];
    loader = document.getElementById("catalog-loader") ? document.getElementById("catalog-loader").value : (inst.loader === "forge" ? "forge" : "fabric");
    version = document.getElementById("catalog-version") ? document.getElementById("catalog-version").value : inst.version;
  } else {
    version = document.getElementById("catalog-version").value;
  }

  try {
    if (!isDependency) statusText.innerText = t("msg_dl_mod", "Téléchargement en cours...");

    if (source === "modrinth") {
        let url = `https://api.modrinth.com/v2/project/${projectId}/version`;
        let params = [];
        if (version) params.push(`game_versions=["${version}"]`);
        if (projType === "mod") params.push(`loaders=["${loader}"]`);
        if (projType === "modpack") params.push(`loaders=["fabric","forge","quilt","neoforge"]`);
        if (params.length > 0) url += "?" + params.join("&");

        const versions = await (await fetch(url)).json();
        if (versions.length === 0) {
          if (!isDependency) statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
          return;
        }

        const fileData = versions[0];
        let file = fileData.files.find((f) => f.primary) || fileData.files[0];

        if (projType === "modpack") {
          const mrpackFile = fileData.files.find((f) => f.filename.endsWith(".mrpack"));
          if (mrpackFile) file = mrpackFile;

          statusText.innerText = t("msg_dl_mp", "Téléchargement du modpack...");
          const tempPath = path.join(dataDir, file.filename);
          const buffer = await (await fetch(file.url)).arrayBuffer();
          fs.writeFileSync(tempPath, Buffer.from(buffer));

          statusText.innerText = t("msg_install_mp", "Installation du modpack...");
          closeCatalogModal();
          await handleMrPackImport(tempPath);
          fs.unlinkSync(tempPath);
          return;
        }

        let targetFolder = "mods";
        if (projType === "shader") targetFolder = "shaderpacks";
        if (projType === "resourcepack") targetFolder = "resourcepacks";

        const inst = allInstances[selectedInstanceIdx];
        const destPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        const filePath = path.join(destPath, file.filename);

        if (!fs.existsSync(filePath)) {
          const buffer = await (await fetch(file.url)).arrayBuffer();
          fs.writeFileSync(filePath, Buffer.from(buffer));
        }

        if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
          for (let dep of fileData.dependencies) {
            if (dep.dependency_type === "required") {
              let depId = dep.project_id || dep.version_id;
              if (depId) {
                statusText.innerText = t("msg_deps", "Dépendances...");
                await installGlobalMod(depId, true, "mod", "modrinth");
              }
            }
          }
        }
    } 
    else if (source === "curseforge") {
        const apiKey = globalSettings.cfApiKey;
        let modLoaderType = 0;
        if (loader === "forge") modLoaderType = 1;
        if (loader === "fabric") modLoaderType = 4;
        if (loader === "neoforge") modLoaderType = 6;

        const url = `https://api.curseforge.com/v1/mods/${projectId}/files?gameVersion=${version}&modLoaderType=${modLoaderType}`;
        const res = await fetch(url, { headers: { "x-api-key": apiKey } });
        const data = await res.json();

        if (!data.data || data.data.length === 0) {
            if (!isDependency) statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
            return;
        }

        const fileData = data.data[0]; 
        if (projType === "modpack") {
            statusText.innerText = t("msg_open_mp", "Ouverture de la page du modpack...");
            openSystemPath(`https://www.curseforge.com/minecraft/modpacks/${projectId}`);
            return;
        }

        let downloadUrl = fileData.downloadUrl;
        if (!downloadUrl) {
            statusText.innerText = t("msg_dl_browser", "Lien de téléchargement sécurisé... Ouverture du navigateur.");
            openSystemPath(`https://www.curseforge.com/minecraft/mc-mods/${projectId}`);
            return;
        }

        let targetFolder = "mods";
        if (projType === "shader") targetFolder = "shaderpacks";
        if (projType === "resourcepack") targetFolder = "resourcepacks";

        const inst = allInstances[selectedInstanceIdx];
        const destPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        const filePath = path.join(destPath, fileData.fileName);

        if (!fs.existsSync(filePath)) {
          const buffer = await (await fetch(downloadUrl)).arrayBuffer();
          fs.writeFileSync(filePath, Buffer.from(buffer));
        }

        if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
          for (let dep of fileData.dependencies) {
            if (dep.relationType === 3) { 
              statusText.innerText = t("msg_deps", "Dépendances...");
              await installGlobalMod(dep.modId, true, "mod", "curseforge");
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

window.setAutoConnect = (ip) => {
    const inst = allInstances[selectedInstanceIdx];
    if (inst.autoConnect === ip) {
        inst.autoConnect = null; 
    } else {
        inst.autoConnect = ip;
    }
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
    const isAuto = inst.autoConnect === ip;
    list.innerHTML += `
            <div style="background: rgba(0,0,0,0.2); border: 1px solid ${isAuto ? 'var(--accent)' : 'var(--border)'}; border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-weight: bold; color: var(--text-light);">${ip}</span>
                    <div id="srv-ping-${i}" style="font-size: 0.75rem; color: #aaa;">- ${t("msg_ping", "Ping...")}</div>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn-secondary" style="color: ${isAuto ? 'var(--accent)' : '#aaa'}; border-color: ${isAuto ? 'var(--accent)' : 'var(--border)'}; padding: 4px 8px; font-size: 0.75rem;" onclick="setAutoConnect('${ip}')" title="Quick-Connect">>> ${t("btn_auto_connect", "Auto")}</button>
                    <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;" onclick="removeServer(${i})">${t("btn_delete", "Supprimer")}</button>
                </div>
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
        statusDiv.innerHTML = `<span style="color:#17B139; font-weight:bold;">[+] ${t("msg_online", "En ligne")}</span> <span style="color:#aaa;">- ${formatNum(data.players.online)}/${formatNum(data.players.max)}</span>`;
      else
        statusDiv.innerHTML = `<span style="color:#f87171; font-weight:bold;">[x] ${t("msg_offline", "Hors-ligne")}</span>`;
    } catch (e) {
      statusDiv.innerHTML = `<span style="color:#f87171;">[x] ${t("msg_err_ping", "Erreur")}</span>`;
    }
  }
};

window.scanJavaVersions = () => {
  document.getElementById("status-text").innerText = t(
    "msg_search_java",
    "Recherche de Java..."
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
    "info"
  );
};

async function downloadJavaAuto(version = 21) {
  showLoading(`Téléchargement de Java ${version}...`);
  await yieldUI();
  const javaDir = path.join(dataDir, "java");
  if (!fs.existsSync(javaDir)) fs.mkdirSync(javaDir, { recursive: true });
  const zipPath = path.join(javaDir, `jre${version}.zip`);

  try {
    let url = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse";
    if (version === 17) url = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse";
    if (version === 8)  url = "https://api.adoptium.net/v3/binary/latest/8/ga/windows/x64/jre/hotspot/normal/eclipse";

    const res = await fetch(url);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    showLoading(t("msg_extract_java", "Extraction de Java..."));
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

window.openImportMCWorldsModal = () => {
    const mcDir = path.join(process.env.APPDATA, ".minecraft", "saves");
    const listDiv = document.getElementById("mc-worlds-list");
    listDiv.innerHTML = "";
    document.getElementById("modal-import-mc").style.display = "flex";

    if (!fs.existsSync(mcDir)) {
        listDiv.innerHTML = `<div style="text-align:center; color:#888; padding: 20px;">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
        return;
    }
    const folders = fs.readdirSync(mcDir).filter(f => fs.statSync(path.join(mcDir, f)).isDirectory());
    if (folders.length === 0) {
        listDiv.innerHTML = `<div style="text-align:center; color:#888; padding: 20px;">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
        return;
    }

    let html = "";
    folders.forEach(f => {
        html += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border);">
            <div style="font-weight: bold; color: var(--text-light);">${f}</div>
            <button class="btn-primary" style="padding: 4px 10px; font-size: 0.8rem;" onclick="importOfficialWorld('${f.replace(/'/g, "\\'")}')">${t("toolbar_import", "Importer")}</button>
        </div>`;
    });
    listDiv.innerHTML = html;
};

window.importOfficialWorld = async (folderName) => {
    const inst = allInstances[selectedInstanceIdx];
    if (!inst) return;
    const mcDir = path.join(process.env.APPDATA, ".minecraft", "saves", folderName);
    const targetDir = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves", folderName);

    showLoading(t("msg_copy", "Copie en cours..."));
    await yieldUI();
    try {
        if (!fs.existsSync(path.dirname(targetDir))) fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await fs.promises.cp(mcDir, targetDir, { recursive: true });
        showToast(t("msg_world_imported", "Monde importé avec succès !"), "success");
        document.getElementById("modal-import-mc").style.display = "none";
        openWorldsModal();
    } catch (e) {
        showToast("Error: " + e.message, "error");
    }
    hideLoading();
};

window.openWorldsModal = async () => {
  if (selectedInstanceIdx === null) return;
  const inst = allInstances[selectedInstanceIdx];
  const savesDir = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_"),
    "saves"
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
    "saves"
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
      t("msg_delete_world_confirm", "Voulez-vous vraiment supprimer ce monde définitivement ?"),
      true
    )
  ) {
    const inst = allInstances[selectedInstanceIdx];
    const savesDir = path.join(
      instancesRoot,
      inst.name.replace(/[^a-z0-9]/gi, "_"),
      "saves"
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
    inst.name.replace(/[^a-z0-9]/gi, "_")
  );
  const savesDir = path.join(instDir, "saves");
  const backupDir = path.join(instDir, "backups");
  const src = path.join(savesDir, folderName);

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const zipPath = path.join(
    backupDir,
    `${folderName}_backup_${new Date().toISOString().replace(/[:\.]/g, "-")}.zip`
  );

  showLoading(t("msg_backup", "Création de la sauvegarde..."));
  await yieldUI();
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(src, folderName);
    await new Promise((res, rej) =>
      zip.writeZip(zipPath, (err) => (err ? rej(err) : res()))
    );
    showToast(
      t("msg_world_backedup", "Sauvegarde créée dans le dossier 'backups' !"),
      "success"
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
    "screenshots"
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
                        <img src="file:///${encodeURI(fullPath)}" style="width: 100%; height: 100%; object-fit: cover;">
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
    
  const appBg = document.getElementById("app-background");
  const root = document.documentElement; 
  const screensDir = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "screenshots");
  let bgSet = false;
  
  if (fs.existsSync(screensDir)) {
      const files = fs.readdirSync(screensDir).filter(f => f.endsWith(".png") || f.endsWith(".jpg"));
      if (files.length > 0) {
          const randomFile = files[Math.floor(Math.random() * files.length)];
          const imgPath = path.join(screensDir, randomFile).replace(/\\/g, "/");
          
          const th = globalSettings.theme || { dim: 0.5, blur: 5, panelOpacity: 0.6 };
          const op = th.panelOpacity !== undefined ? th.panelOpacity : 0.6;
          
          appBg.style.backgroundImage = `url("file:///${encodeURI(imgPath)}")`;
          appBg.style.filter = `blur(${th.blur}px) brightness(${1 - th.dim})`;
          
          root.style.setProperty("--bg-main", `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
          root.style.setProperty("--bg-panel", `rgba(45, 45, 48, ${op})`);
          root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
          
          bgSet = true;
      }
  }
  
  if (!bgSet) applyTheme();

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
      2
    )
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
    (id) => (document.getElementById(id).disabled = running)
  );
  updateLaunchButton();
}

let monitorInterval;
let lastCpuTimes = os.cpus().map(c => c.times);

function updateLiveStats() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const ramPerc = Math.round((used / total) * 100);

    document.getElementById("live-ram").innerText = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.width = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.background = ramPerc > 85 ? "#f87171" : "var(--accent)";

    let current = os.cpus().map(c => c.times);
    let idle = 0, cpuTotal = 0;
    for(let i = 0; i < current.length; i++) {
        let t1 = lastCpuTimes[i], t2 = current[i];
        idle += (t2.idle - t1.idle);
        cpuTotal += ((t2.user + t2.nice + t2.sys + t2.idle + t2.irq) - (t1.user + t1.nice + t1.sys + t1.idle + t1.irq));
    }
    lastCpuTimes = current;
    
    let cpuPerc = cpuTotal === 0 ? 0 : Math.round((1 - (idle / cpuTotal)) * 100);
    document.getElementById("live-cpu").innerText = `${cpuPerc}%`;
    document.getElementById("live-cpu-bar").style.width = `${cpuPerc}%`;
    document.getElementById("live-cpu-bar").style.background = cpuPerc > 85 ? "#f87171" : "#17B139";
}

function getRequiredJavaVersion(mcVersion) {
    if (!mcVersion) return 21;
    const parts = mcVersion.split('.');
    const minor = parseInt(parts[1]) || 0;
    if (minor >= 21) return 21; 
    if (minor >= 17) return 17; 
    return 8;                   
}

document.getElementById("launch-btn").addEventListener("click", async () => {
  if (isGameRunning) {
      try {
          if (process.platform === 'win32') {
              exec('taskkill /F /IM java.exe /IM javaw.exe /T');
          } else {
              exec('killall -9 java');
          }
          showToast(t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
      } catch(e) {
          console.error(e);
      }
      return;
  }

  const inst = allInstances[selectedInstanceIdx];
  const acc = allAccounts[selectedAccountIdx];
  const instancePath = path.join(
    instancesRoot,
    inst.name.replace(/[^a-z0-9]/gi, "_")
  );
  const progBar = document.getElementById("progress-bar");
  const logOutput = document.getElementById("log-output");

  document.getElementById("console-container").style.display = "block";
  logOutput.innerHTML = "";
  sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
  logOutput.innerHTML += `<div class="log-line" style="color:#007acc">[SYSTEM] ${t("msg_launching", "Lancement de ")}${inst.name}...</div>`;

  if (inst.backupMode === "on_launch") await createBackup(inst);

  const destOpt = path.join(instancePath, "options.txt");
  const defaultOpt = path.join(dataDir, "default_options.txt");
  if (!fs.existsSync(destOpt) && fs.existsSync(defaultOpt)) {
      try {
          fs.copyFileSync(defaultOpt, destOpt);
          sysLog("Injection du profil options.txt par défaut avant le lancement.");
      } catch(e) {}
  }

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

  const requiredJava = getRequiredJavaVersion(inst.version);
  sysLog(`Version de Minecraft: ${inst.version} -> Java requis: Java ${requiredJava}`);

  document.getElementById("status-text").innerText = t(
    "msg_check_java",
    "Vérification de Java..."
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
        `Java introuvable ou incorrect ! Voulez-vous installer automatiquement Java ${requiredJava} ?`
      )
    ) {
      const newJava = await downloadJavaAuto(requiredJava);
      if (newJava) jPath = newJava;
      else {
        document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
        setUIState(false);
        return;
      }
    } else {
      document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
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

  if (inst.autoConnect) {
      const parts = inst.autoConnect.split(":");
      const srvHost = parts[0];
      const srvPort = parts[1] ? parts[1] : "25565";

      opts.server = {
          host: srvHost,
          port: srvPort
      };
      opts.quickPlay = {
          type: "multiplayer",
          identifier: `${srvHost}:${srvPort}`
      };
  }

  if (inst.loader === "fabric") {
    try {
      document.getElementById("status-text").innerText = t("msg_install_fabric", "Installation de Fabric...");
      
      let loaderVer = inst.loaderVersion;
      if (!loaderVer) {
          const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
          const fbData = await fbRes.json();
          loaderVer = fbData[0].loader.version;
      }
      
      if (loaderVer) {
        const customVerName = `fabric-loader-${loaderVer}-${inst.version}`;
        opts.version.custom = customVerName;
        const vPath = path.join(instancePath, "versions", customVerName);
        if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
        const jsonPath = path.join(vPath, `${customVerName}.json`);
        if (!fs.existsSync(jsonPath)) {
          const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}/${loaderVer}/profile/json`);
          fs.writeFileSync(jsonPath, await response.text());
        }
      }
    } catch (e) {
      sysLog("Erreur Fabric: " + e, true);
      return;
    }
  }
  else if (inst.loader === "quilt") {
    try {
      document.getElementById("status-text").innerText = "Installation de Quilt...";
      let loaderVer = inst.loaderVersion;
      if (!loaderVer) {
          const qRes = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${inst.version}`);
          const qData = await qRes.json();
          loaderVer = qData[0].loader.version;
      }
      if (loaderVer) {
        const customVerName = `quilt-loader-${loaderVer}-${inst.version}`;
        opts.version.custom = customVerName;
        const vPath = path.join(instancePath, "versions", customVerName);
        if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
        const jsonPath = path.join(vPath, `${customVerName}.json`);
        if (!fs.existsSync(jsonPath)) {
          const response = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${inst.version}/${loaderVer}/profile/json`);
          fs.writeFileSync(jsonPath, await response.text());
        }
      }
    } catch (e) {
      sysLog("Erreur Quilt: " + e, true);
      return;
    }
  } 
  else if (inst.loader === "forge" || inst.loader === "neoforge") {
    document.getElementById("status-text").innerText = `Préparation de ${inst.loader}...`;
    sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
    
    if (!inst.loaderVersion) {
        showToast(`Impossible de lancer : Version exacte de ${inst.loader} manquante.`, "error");
        setUIState(false);
        return;
    }
    
    const installersDir = path.join(dataDir, "installers");
    if (!fs.existsSync(installersDir)) fs.mkdirSync(installersDir, { recursive: true });
    
    const installerName = `${inst.loader}-${inst.loaderVersion}-installer.jar`;
    const installerPath = path.join(installersDir, installerName);
    
    if (!fs.existsSync(installerPath)) {
        try {
            document.getElementById("status-text").innerText = `Téléchargement de ${inst.loader} (Patientez)...`;
            await yieldUI();
let downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar`;
            
            if (inst.loader === "neoforge") {
                downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;
            }

            sysLog(`Téléchargement de l'installeur depuis : ${downloadUrl}`);
            let res = await fetch(downloadUrl);
            
            // Si le lien officiel échoue (très vieilles versions), on tente le miroir
            if (!res.ok && inst.loader === "forge") {
                sysLog("Lien officiel échoué, essai du miroir secondaire...");
                downloadUrl = `https://bmclapi2.bangbang93.com/forge/download?mcversion=${inst.version}&version=${inst.loaderVersion}&category=installer&format=jar`;
                res = await fetch(downloadUrl);
            }

            if (!res.ok) throw new Error(`Impossible de télécharger l'installeur (Code HTTP: ${res.status})`);

if (!res.ok) throw new Error(`Impossible de télécharger l'installeur (Code HTTP: ${res.status})`);

            let fakePerc = 0;
            const fakeProgress = setInterval(() => {
                if (fakePerc < 95) fakePerc += Math.floor(Math.random() * 5) + 2; 
                if (fakePerc > 95) fakePerc = 95;
                document.getElementById("progress-bar").style.width = fakePerc + "%";
                document.getElementById("status-text").innerText = `Téléchargement de ${inst.loader} : ${fakePerc}%`;
            }, 400);

            try {
                const buffer = await res.arrayBuffer();
                fs.writeFileSync(installerPath, Buffer.from(buffer));
                
                document.getElementById("progress-bar").style.width = "100%";
                document.getElementById("status-text").innerText = `Téléchargement terminé !`;
            } finally {
                clearInterval(fakeProgress); 
            }
            
            sysLog(`Installeur ${inst.loader} téléchargé avec succès.`);
            
} catch (err) {
            sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
            showToast(t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
            document.getElementById("status-text").innerText = t("status_ready", "Prêt");
            setUIState(false);
            return;
        }
    }

    let needsInstall = true;
    const versionsDir = path.join(instancePath, "versions");
    if (fs.existsSync(versionsDir)) {
        const subDirs = fs.readdirSync(versionsDir);
        const forgeDir = subDirs.find(d => d.toLowerCase().includes(inst.loader));
        if (forgeDir) {
            needsInstall = false;
            opts.version.custom = forgeDir; 
        }
    }

    if (needsInstall) {
        opts.forge = installerPath;
    }
  }

  document.getElementById("status-text").innerText = t(
    "msg_prep_files",
    "Préparation des fichiers..."
  );
  
  setUIState(true);
  sessionStartTime = Date.now();
  updateRPC(inst); 
  
  document.getElementById("live-stats").style.display = "block";
  lastCpuTimes = os.cpus().map(c => c.times); 
  monitorInterval = setInterval(updateLiveStats, 1500);

  sysLog("Démarrage du processus MCLC...");
  launcher.launch(opts);

  let lastLogPerc = -1;
  launcher.on("progress", (e) => {
    let perc = 0;
    if (e.total > 0) perc = Math.round((e.task / e.total) * 100);
    progBar.style.width = perc + "%";
    document.getElementById("status-text").innerText = `${t("msg_dl", "Téléchargement :")} ${perc}%`;

    if (perc % 10 === 0 && perc !== lastLogPerc) {
        lastLogPerc = perc;
        logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:#aaa;">[SYSTEM] ${t("msg_dl", "Téléchargement :")} ${perc}%</div>`);
        if (logOutput.selectionStart === undefined) logOutput.scrollTop = logOutput.scrollHeight;
    }
  });

let windowHidden = false;
  launcher.on("data", (data) => {
    if (globalSettings.launcherVisibility === "hide" && !windowHidden) {
        ipcRenderer.send("hide-window");
        windowHidden = true;
    }
    const dStr = data.toString().trim();
    if (!dStr) return;
    
    sysLog("GAME: " + dStr);

    let color = "#d4d4d4"; 
    if (dStr.includes("WARN")) color = "#ffaa00"; 
    if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171"; 

    logOutput.insertAdjacentHTML(
      "beforeend",
      `<div class="log-line" style="color:${color}">[GAME] ${dStr}</div>`
    );
    
    const filter = document.getElementById("console-filter").value.toLowerCase();
    if (filter && !dStr.toLowerCase().includes(filter)) {
        logOutput.lastElementChild.style.display = "none";
    }

    if (logOutput.selectionStart === undefined) {
        logOutput.scrollTop = logOutput.scrollHeight;
    }
  });

  launcher.on("close", async (code) => {
    sysLog(`Le jeu s'est arrêté avec le code ${code}`, code !== 0);
    logOutput.insertAdjacentHTML(
      "beforeend",
      `<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`
    );

    if (code !== 0)
      document.getElementById("console-container").style.display = "block";

    if (selectedInstanceIdx !== null) {
      const currentInst = allInstances[selectedInstanceIdx];
      if (currentInst.backupMode === "on_close")
        await createBackup(currentInst);

      const sessionDuration = Date.now() - sessionStartTime;
      currentInst.playTime = (currentInst.playTime || 0) + sessionDuration;
      currentInst.lastPlayed = Date.now();

      if (!currentInst.sessionHistory) currentInst.sessionHistory = [];
      const today = new Date().toISOString().slice(0, 10);
      const existing = currentInst.sessionHistory.find(s => s.date === today);
      if (existing) existing.ms += sessionDuration;
      else currentInst.sessionHistory.push({ date: today, ms: sessionDuration });
      currentInst.sessionHistory = currentInst.sessionHistory.slice(-30);

      fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
      selectInstance(selectedInstanceIdx);
    }
    
    if (globalSettings.launcherVisibility === "hide") {
        ipcRenderer.send("show-window");
    }
    
    clearInterval(monitorInterval);
    document.getElementById("live-stats").style.display = "none";

    try {
        const notif = new Notification("Gens Launcher", {
            body: code === 0
                ? `${allInstances[selectedInstanceIdx]?.name || "Minecraft"} s'est fermé normalement.`
                : `Le jeu s'est arrêté avec une erreur (code ${code}).`,
            silent: true
        });
        notif.onclick = () => { ipcRenderer.send("show-window"); };
    } catch(e) {}

    document.getElementById("status-text").innerText = t("status_ready", "Prêt");
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
    "tab-btn-" + tabId.replace("tab-", "")
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
    "tab-btn-" + tabId.replace("tab-", "")
  );
  if (tabBtn) tabBtn.classList.add("active");
  const tabContent = document.getElementById(tabId);
  if (tabContent) tabContent.classList.add("active");
};

window.autoOptimizeRAM = () => {
    const inst = allInstances[selectedInstanceIdx];
    if(!inst) return;
    const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
    
    let modCount = 0;
    if (fs.existsSync(modsPath)) {
        modCount = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled")).length;
    }

    let idealRam = 2048; 
    if (inst.loader !== "vanilla") {
        idealRam = 4096; 
        if (modCount > 50) idealRam = 6144;
        if (modCount > 100) idealRam = 8192;
    }

    if (idealRam > maxSafeRam) idealRam = maxSafeRam;
    
    const totalSysRam = Math.floor(os.totalmem() / (1024 * 1024));
    if (idealRam < 4096 && totalSysRam >= 6144) {
        idealRam = 4096;
    }

    document.getElementById("edit-ram-input").value = idealRam;
    document.getElementById("edit-ram-slider").value = idealRam;
    showToast(`${t("msg_ram_optimized", "RAM optimisée à ")}${idealRam} Mo`, "success");
};

window.openGlobalSettings = () => {
  document.getElementById("global-ram-input").value = globalSettings.defaultRam;
  document.getElementById("global-ram-slider").value = globalSettings.defaultRam;
  document.getElementById("global-java").value = globalSettings.defaultJavaPath;
  document.getElementById("global-cf-api").value = globalSettings.cfApiKey || ""; 
  document.getElementById("global-server-ip").value = globalSettings.serverIp || "";
  document.getElementById("global-accent").value = globalSettings.theme?.accent || "#007acc";
  document.getElementById("global-bg-path").value = globalSettings.theme?.bg || "";
  document.getElementById("global-bg-dim").value = globalSettings.theme?.dim || 0.5;
  document.getElementById("global-bg-blur").value = globalSettings.theme?.blur || 5;
  document.getElementById("global-panel-opacity").value = globalSettings.theme?.panelOpacity !== undefined ? globalSettings.theme.panelOpacity : 0.6;
  document.getElementById("global-visibility").value = globalSettings.launcherVisibility || "keep";

const optSelect = document.getElementById("global-options-source");
  optSelect.innerHTML = "<option value='none'>-- Aucun (Désactiver) --</option>";
  allInstances.forEach((inst, i) => {
      const isSelected = (inst.name === globalSettings.defaultOptionsInstance) ? "selected" : "";
      optSelect.innerHTML += `<option value="${i}" ${isSelected}>${inst.name}</option>`;
  });

  switchTabGlob("tab-glob-gen");
  document.getElementById("modal-settings").style.display = "flex";
};

window.closeGlobalSettings = () =>
  (document.getElementById("modal-settings").style.display = "none");

window.saveGlobalSettings = () => {
  globalSettings.defaultRam = parseInt(document.getElementById("global-ram-input").value);
  globalSettings.defaultJavaPath = document.getElementById("global-java").value;
  globalSettings.cfApiKey = document.getElementById("global-cf-api").value.trim(); 
  globalSettings.serverIp = document.getElementById("global-server-ip").value.trim();
  globalSettings.launcherVisibility = document.getElementById("global-visibility").value;

  globalSettings.theme = {
    accent: document.getElementById("global-accent").value,
    bg: document.getElementById("global-bg-path").value,
    dim: parseFloat(document.getElementById("global-bg-dim").value),
    blur: parseInt(document.getElementById("global-bg-blur").value),
    panelOpacity: parseFloat(document.getElementById("global-panel-opacity").value),
  };

  fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
  
  if(selectedInstanceIdx !== null) selectInstance(selectedInstanceIdx);
  else applyTheme();
  
  closeGlobalSettings();
  checkServerStatus();
};

window.saveDefaultOptions = () => {
    const idx = document.getElementById("global-options-source").value;
    
    if (idx === "none") {
        const defaultOpt = path.join(dataDir, "default_options.txt");
        if (fs.existsSync(defaultOpt)) fs.unlinkSync(defaultOpt);
        globalSettings.defaultOptionsInstance = null;
        fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
        showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
        return;
    }
    
    if (idx === "") return;
    const inst = allInstances[idx];
    const sourceOpt = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "options.txt");
if (fs.existsSync(sourceOpt)) {
        fs.copyFileSync(sourceOpt, path.join(dataDir, "default_options.txt"));
        globalSettings.defaultOptionsInstance = inst.name;
        fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
        showToast(t("msg_options_saved", "Profil d'options sauvegardé !"), "success");
    } else {
        showToast(t("msg_no_options_found", "Aucun options.txt trouvé. Lancez le jeu au moins une fois sur cette instance !"), "error");
    }
};

window.forceInjectOptions = () => {
    const inst = allInstances[selectedInstanceIdx];
    if (!inst) return;
    const destOpt = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "options.txt");
    const defaultOpt = path.join(dataDir, "default_options.txt");
    
    if (!fs.existsSync(defaultOpt)) {
        showToast(t("msg_force_sync_error", "Aucun profil par défaut défini dans les Paramètres Globaux."), "error");
        return;
    }
    
    try {
        fs.copyFileSync(defaultOpt, destOpt);
        showToast(t("msg_force_sync_success", "Touches synchronisées avec succès !"), "success");
    } catch(e) {
        showToast("Erreur de synchronisation.", "error");
    }
};

window.openInstanceModal = () => {
  document.getElementById("new-ram-input").value = globalSettings.defaultRam;
  document.getElementById("new-ram-slider").value = globalSettings.defaultRam;
  document.getElementById("modal-instance").style.display = "flex";
  updateLoaderVersions();
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
  pendingIconPath = null;
};

window.saveInstance = () => {
  const nameInput = document.getElementById("new-name");
  const name = nameInput.value.trim();
  if (!name) {
      nameInput.style.borderColor = "#f87171";
      showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
      return;
  }
  allInstances.push({
    name,
    version: document.getElementById("new-version").value,
    loader: document.getElementById("new-loader").value,
    loaderVersion: document.getElementById("new-loader-version").value, 
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

  const destFolder = path.join(instancesRoot, name.replace(/[^a-z0-9]/gi, "_"));
  fs.mkdirSync(destFolder, { recursive: true });
  const defaultOpt = path.join(dataDir, "default_options.txt");
  if (fs.existsSync(defaultOpt)) {
      try { fs.copyFileSync(defaultOpt, path.join(destFolder, "options.txt")); } catch(e) {}
  }

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
  inst.backupLimit = parseInt(document.getElementById("edit-backup-limit").value) || 5;

  if (pendingIconPath && fs.existsSync(pendingIconPath)) {
      const instFolder = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
      if (!fs.existsSync(instFolder)) fs.mkdirSync(instFolder, { recursive: true });
      
      const ext = path.extname(pendingIconPath);
      const newIconPath = path.join(instFolder, "icon" + ext);
      
      try {
          fs.copyFileSync(pendingIconPath, newIconPath);
          inst.icon = "file:///" + encodeURI(newIconPath.replace(/\\/g, "/"));
      } catch(e) {
          console.error("Erreur lors de la copie de l'image", e);
      }
      pendingIconPath = null;
  } else {
      const iconSrc = document.getElementById("edit-icon-preview").src;
      if (!iconSrc.includes("svg+xml")) inst.icon = iconSrc;
  }

  fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
  
  selectInstance(selectedInstanceIdx);
  renderUI();
  closeEditModal();
};

window.loginMicrosoft = async () => {
  const btn = document.getElementById("btn-ms-login");
  const originalText = btn.innerText;
  btn.innerText = t("msg_conn_ms", "Connexion...");
  btn.disabled = true;
  window._msLoginSessionActive = true;

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
      uiSelectedAccRow = selectedAccountIdx;
      fs.writeFileSync(
        accountFile,
        JSON.stringify(
          { list: allAccounts, lastUsed: selectedAccountIdx },
          null,
          2
        )
      );
      renderAccountManager();
      changeAccountFromCode();
      closeAccountModal();
      showToast("Connexion réussie !", "success");
    } else if (result.cancelled) {
      showToast(t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
    } else {
      showToast(t("msg_err_ms", "Erreur Microsoft : ") + result.error, "error");
    }
  } catch (e) {
    showToast(t("msg_err_sys", "Erreur système : ") + e, "error");
  } finally {
    window._msLoginSessionActive = false;
    closeMicrosoftDeviceModal();
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
        2
      )
    );
    renderAccountManager();
    changeAccountFromCode();
  }
};

window.openDir = (f) => {
  const dir = path.join(
    instancesRoot,
    allInstances[selectedInstanceIdx].name.replace(/[^a-z0-9]/gi, "_"),
    f
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  if (process.platform === "win32") {
      exec(`explorer "${dir}"`); 
  } else {
      shell.openPath(dir);
  }
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
      oldInst.name.replace(/[^a-z0-9]/gi, "_")
    );
    if (fs.existsSync(oldPath))
      await fs.promises.cp(
        oldPath,
        path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_")),
        { recursive: true }
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
  if (await showCustomConfirm(t("msg_delete_inst", "Supprimer l'instance ?"), true)) {
    const inst = allInstances[selectedInstanceIdx];
    const instFolder = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
    try {
        if (fs.existsSync(instFolder)) {
            await fs.promises.rm(instFolder, { recursive: true, force: true });
        }
    } catch(e) {
        sysLog("Erreur lors de la suppression du dossier: " + e, true);
    }
    allInstances.splice(selectedInstanceIdx, 1);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    selectedInstanceIdx = null;
    document.getElementById("panel-stats").style.display = "none";
    document.getElementById("action-panel").style.opacity = "0.4";
    document.getElementById("action-panel").style.pointerEvents = "none";
    document.getElementById("panel-title").innerText = t(
      "panel_title",
      "Sélectionnez une instance"
    );
    applyTheme();
    renderUI();
  }
};

window.exportInstance = () => {
  if (selectedInstanceIdx === null) return;
  document.getElementById('modal-export').style.display = 'flex';
};

window.doExport = async (type) => {
  document.getElementById('modal-export').style.display = 'none';
  const inst = allInstances[selectedInstanceIdx];
  const safeName = inst.name.replace(/[^a-z0-9]/gi, "_");
  const sourceFolder = path.join(instancesRoot, safeName);
  const exportDir = path.join(dataDir, "exports");
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  
  if (type === "zip") {
      const zipPath = path.join(exportDir, `${safeName}.zip`);
      showLoading(t("msg_compress", "Compression..."));
      await yieldUI();

      try {
        const zip = new AdmZip();
        if (fs.existsSync(sourceFolder)) zip.addLocalFolder(sourceFolder, "files");
        zip.addFile(
          "instance.json",
          Buffer.from(JSON.stringify(inst, null, 2), "utf8")
        );
        await new Promise((res, rej) =>
          zip.writeZip(zipPath, (err) => (err ? rej(err) : res()))
        );
        if (process.platform === "win32") {
            exec(`explorer /select,"${zipPath}"`);
        } else {
            shell.showItemInFolder(zipPath);
        }
      } catch (e) {
        sysLog("Erreur Export: " + e, true);
      }
      hideLoading();
  } 
  else if (type === "mrpack") {
      const zipPath = path.join(exportDir, `${safeName}.mrpack`);
      showLoading(t("msg_mrpack_analyze", "Analyse des mods et génération du .mrpack..."));
      await yieldUI();

      try {
          const zip = new AdmZip();
          const modsPath = path.join(sourceFolder, "mods");
          
          let filesArray = [];
          if (fs.existsSync(modsPath)) {
              const jarFiles = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar"));
              let hashes = {};
              jarFiles.forEach(f => {
                  const buf = fs.readFileSync(path.join(modsPath, f));
                  const hash = crypto.createHash("sha1").update(buf).digest("hex");
                  const hash512 = crypto.createHash("sha512").update(buf).digest("hex");
                  hashes[hash] = { file: f, sha1: hash, sha512: hash512, size: buf.length };
              });

              const res = await fetch("https://api.modrinth.com/v2/version_files", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ hashes: Object.keys(hashes), algorithm: "sha1" })
              });
              const apiData = await res.json();

              for (let hash in hashes) {
                  if (apiData[hash]) {
                      const versionData = apiData[hash];
                      const fileData = versionData.files.find(f => f.hashes.sha1 === hash) || versionData.files[0];
                      filesArray.push({
                          path: `mods/${hashes[hash].file}`,
                          hashes: { sha1: hashes[hash].sha1, sha512: hashes[hash].sha512 },
                          env: { client: "required", server: "required" },
                          downloads: [fileData.url],
                          fileSize: hashes[hash].size
                      });
                  } else {
                      zip.addFile(`overrides/mods/${hashes[hash].file}`, fs.readFileSync(path.join(modsPath, hashes[hash].file)));
                  }
              }
          }

          if (fs.existsSync(path.join(sourceFolder, "config"))) {
              zip.addLocalFolder(path.join(sourceFolder, "config"), "overrides/config");
          }
          if (fs.existsSync(path.join(sourceFolder, "resourcepacks"))) {
              zip.addLocalFolder(path.join(sourceFolder, "resourcepacks"), "overrides/resourcepacks");
          }
          if (fs.existsSync(path.join(sourceFolder, "options.txt"))) {
              zip.addFile("overrides/options.txt", fs.readFileSync(path.join(sourceFolder, "options.txt")));
          }

          const indexJson = {
              formatVersion: 1,
              game: "minecraft",
              versionId: "1.0.0",
              name: inst.name,
              dependencies: { minecraft: inst.version },
              files: filesArray
          };

          if (inst.loader === "fabric") indexJson.dependencies["fabric-loader"] = inst.loaderVersion || "latest";
          if (inst.loader === "forge") indexJson.dependencies.forge = inst.loaderVersion || "latest";
          if (inst.loader === "neoforge") indexJson.dependencies.neoforge = inst.loaderVersion || "latest";

          zip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(indexJson, null, 2), "utf8"));
          zip.writeZip(zipPath);
          if (process.platform === "win32") {
            exec(`explorer /select,"${zipPath}"`);
        } else {
            shell.showItemInFolder(zipPath);
        }
          showToast(t("msg_mrpack_success", "Export .mrpack réussi !"), "success");
      } catch(e) {
          sysLog("Erreur MrPack export: " + e, true);
          showToast(t("msg_mrpack_error", "Erreur lors de l'export .mrpack"), "error");
      }
      hideLoading();
  }
};

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (document.getElementById("modal-edit").style.display === "flex") {
        const tabMods = document.getElementById("tab-mods").classList.contains("active");
        const tabShaders = document.getElementById("tab-shaders").classList.contains("active");
        const tabRp = document.getElementById("tab-resourcepacks").classList.contains("active");
        
        if (tabMods || tabShaders || tabRp) {
            const overlay = document.getElementById("drop-overlay");
            if (tabMods) overlay.innerText = t("msg_drop_mod", "Relâchez pour installer le mod");
            if (tabShaders) overlay.innerText = t("msg_drop_shader", "Relâchez pour installer le shader");
            if (tabRp) overlay.innerText = t("msg_drop_rp", "Relâchez pour installer le pack");
            overlay.style.display = "flex";
        }
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        document.getElementById("drop-overlay").style.display = "none";
    }
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.getElementById("drop-overlay").style.display = "none";

    if (document.getElementById("modal-edit").style.display !== "flex") return;
    const inst = allInstances[selectedInstanceIdx];
    if (!inst) return;

    const tabMods = document.getElementById("tab-mods").classList.contains("active");
    const tabShaders = document.getElementById("tab-shaders").classList.contains("active");
    const tabRp = document.getElementById("tab-resourcepacks").classList.contains("active");

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    let targetFolder = "";
    let validExt = "";
    let renderFn = null;

    if (tabMods) { targetFolder = "mods"; validExt = ".jar"; renderFn = renderModsManager; }
    else if (tabShaders) { targetFolder = "shaderpacks"; validExt = ".zip"; renderFn = renderShadersManager; }
    else if (tabRp) { targetFolder = "resourcepacks"; validExt = ".zip"; renderFn = renderResourcePacksManager; }
    else return;

    const destDir = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    let copied = 0;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.name.endsWith(validExt)) {
            fs.copyFileSync(f.path, path.join(destDir, f.name));
            copied++;
        }
    }
    if (copied > 0) {
        showToast(`${copied} ${t("msg_files_added", "fichier(s) ajouté(s) !")}`, "success");
        renderFn();
    }
});

window.checkLauncherUpdates = async () => {
    const btn = document.getElementById("btn-check-launcher");
    btn.disabled = true;
    document.getElementById("update-status").innerText = t("msg_check_updates", "Recherche en cours...");
    
    const res = await ipcRenderer.invoke("check-for-updates");
    
    if (!res.success) {
        document.getElementById("update-status").innerText = "Erreur: " + res.error;
    } else {
        const currentVer = require("./package.json").version;
        if (!res.version || res.version === currentVer || res.version === "v" + currentVer) {
            document.getElementById("update-status").innerText = t("msg_up_to_date", "Le launcher est à jour.");
            pendingUpdateInfo = null;
        } else {
            document.getElementById("update-status").innerText = "";
        }
    }
    btn.disabled = false;
};

ipcRenderer.on("update-available-prompt", async (event, info) => {
    pendingUpdateInfo = info;
    const msg = `${t("msg_update_found", "Une mise à jour a été trouvée")} (v${info.version}). ${t("msg_download_update", "Voulez-vous la télécharger en arrière-plan ?")}`;
    
    if(await showCustomConfirm(msg)) {
        startUpdateDownload();
    } else {
        renderUpdateTab(); 
    }
});

window.renderUpdateTab = () => {
    if (pendingUpdateInfo) {
        let patchNotes = pendingUpdateInfo.releaseNotes || t("msg_patch_notes", "Correction de bugs et améliorations.");
        patchNotes = patchNotes.replace(/<[^>]*>?/gm, ''); 

        document.getElementById("update-status").innerHTML = `
            <div style="color: #17B139; font-weight: bold; margin-bottom: 5px;">Nouvelle version en attente : v${pendingUpdateInfo.version}</div>
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); padding: 10px; border-radius: 4px; max-height: 150px; overflow-y: auto; color: #ccc; font-size: 0.8rem; white-space: pre-wrap;">${patchNotes}</div>
            <button class="btn-primary" style="margin-top: 10px; width: 100%;" onclick="startUpdateDownload()">Télécharger l'exécutable</button>
        `;
    }
};

window.startUpdateDownload = () => {
    ipcRenderer.send("download-update");
    document.getElementById("update-status").innerText = t("msg_dl", "Téléchargement en arrière-plan en cours...");
    showToast("Téléchargement de la mise à jour lancé.", "info");
};

ipcRenderer.on("update-downloaded", async () => {
    document.getElementById("update-status").innerText = "Prêt à installer !";
    if(await showCustomConfirm(t("msg_update_ready", "Téléchargement terminé ! Voulez-vous redémarrer le launcher pour installer la mise à jour ?"))) {
        ipcRenderer.send("restart_app");
    }
});

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
    if (uiSelectedAccRow === null) return;
    const acc = allAccounts[uiSelectedAccRow];
    
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

    const skinUrl = `https://minotar.net/skin/${acc.name}?t=${Date.now()}`;

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
        fullscreenSkinViewer.loadSkin(skinUrl).then(() => {
            canvas.style.opacity = "1";
        });
    }
    
    if (acc.type === "microsoft" && acc.uuid) {
        getMojangCapeUrl(acc.uuid).then(mojangCapeUrl => {
            if (mojangCapeUrl) {
                fullscreenSkinViewer.loadCape(mojangCapeUrl);
            } else {
                fullscreenSkinViewer.loadCape(`https://s.optifine.net/capes/${acc.name}.png?t=${Date.now()}`).catch(() => {
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
};

window.previewLocalSkin = (input) => {
    const file = input.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        if (fullscreenSkinViewer) {
            fullscreenSkinViewer.loadSkin(e.target.result);
            showToast("Aperçu du skin chargé en 3D !", "info");
        }
    };
    reader.readAsDataURL(file);
    input.value = ""; 
};

window.exportSkin = async () => {
    if (uiSelectedAccRow === null) return;
    const acc = allAccounts[uiSelectedAccRow];
    
    try {
        const res = await fetch(`https://minotar.net/skin/${acc.name}`);
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
        
        showToast("Skin exporté avec succès !", "success");
    } catch (e) {
        showToast("Erreur lors de l'exportation du skin.", "error");
    }
};

document.addEventListener('mouseover', (e) => {
    const trigger = e.target.closest('.custom-tooltip-trigger');
    if (trigger) {
        let tooltipEl = document.getElementById('global-tooltip');
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'global-tooltip';
            document.body.appendChild(tooltipEl);
        }
        tooltipEl.innerText = trigger.getAttribute('data-tooltip');
        tooltipEl.style.opacity = '1';
    }
});

document.addEventListener('mousemove', (e) => {
    const tooltipEl = document.getElementById('global-tooltip');
    if (tooltipEl && tooltipEl.style.opacity === '1') {
        tooltipEl.style.left = e.clientX + 'px';
        tooltipEl.style.top = (e.clientY - 15) + 'px'; 
    }
});

document.addEventListener('mouseout', (e) => {
    const trigger = e.target.closest('.custom-tooltip-trigger');
    if (trigger) {
        const tooltipEl = document.getElementById('global-tooltip');
        if (tooltipEl) {
            tooltipEl.style.opacity = '0'; 
        }
    }
});

let pendingIconPath = null;

window.previewInstanceIcon = (input) => {
    const file = input.files[0];
    if (file) {
        pendingIconPath = file.path; 
        const localPath = "file:///" + encodeURI(file.path.replace(/\\/g, "/"));
        document.getElementById("edit-icon-preview").src = localPath;
    }
    input.value = ""; 
};