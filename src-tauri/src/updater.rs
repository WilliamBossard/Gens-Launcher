//! Native Rust auto-updater 100% compatible with electron-updater manifests
//! (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) and Linux APT `.deb` updates.
//! Enables seamless Electron -> Rust upgrades and Rust -> Rust updates with SHA-512 verification.

use crate::encoding::base64_encode;
use crate::game_validation::{assert_allowed_https_url, ALLOWED_DOWNLOAD_DOMAINS};
use crate::horizon::is_semver_newer;
use crate::sandbox::{rename_with_retry, safe_data_dir};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use sha2::Sha256;
use sha2::{Digest, Sha512};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

const REPO_BASE: &str = "https://github.com/WilliamBossard/Gens-Launcher/releases/latest/download";
const API_LATEST: &str = "https://api.github.com/repos/WilliamBossard/Gens-Launcher/releases/latest";
#[cfg(target_os = "linux")]
const APT_KEY_SHA256: &str = "9d9f654a0455664fdd3ce1b4fcdccf424fe3bd17614cc9c5ba5133710a7d8cd0";
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB max

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElectronYmlInfo {
    pub version: String,
    pub path: String,
    pub sha512: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
struct PendingUpdate {
    version: String,
    download_url: String,
    file_name: String,
    expected_sha512_b64: String,
    expected_size: u64,
}

pub struct UpdateManager {
    auto_download: AtomicBool,
    user_confirmed: AtomicBool,
    #[cfg(target_os = "linux")]
    deb_already_installed: AtomicBool,
    pending: Mutex<Option<PendingUpdate>>,
    downloaded_path: Mutex<Option<PathBuf>>,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            auto_download: AtomicBool::new(false),
            user_confirmed: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            deb_already_installed: AtomicBool::new(false),
            pending: Mutex::new(None),
            downloaded_path: Mutex::new(None),
        }
    }

    pub fn set_auto_download(&self, enabled: bool) {
        self.auto_download.store(enabled, Ordering::SeqCst);
    }

    pub fn confirm_update(&self) {
        self.user_confirmed.store(true, Ordering::SeqCst);
    }

    pub fn is_deb_package_installation() -> bool {
        #[cfg(target_os = "linux")]
        {
            if std::env::var("APPIMAGE").is_ok()
                || std::env::var("FLATPAK_ID").is_ok()
                || std::env::var("SNAP").is_ok()
            {
                return false;
            }
            if cfg!(debug_assertions) {
                return false;
            }
            for marker in [
                "/var/lib/dpkg/info/gens-launcher.list",
                "/var/lib/dpkg/info/gens-launcher:amd64.list",
                "/var/lib/dpkg/info/gens-launcher:arm64.list",
                "/usr/share/doc/gens-launcher",
                "/etc/apt/sources.list.d/gens-launcher.list",
            ] {
                if std::path::Path::new(marker).exists() {
                    return true;
                }
            }
            false
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    pub async fn check_for_updates(
        &self,
        app: &AppHandle,
        http: &Client,
        is_manual: bool,
    ) -> Value {
        let current = env!("CARGO_PKG_VERSION");

        // Linux .deb path: check GitHub release tag only (download handled by APT)
        if Self::is_deb_package_installation() {
            match http
                .get(API_LATEST)
                .timeout(Duration::from_secs(10))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(rel) = resp.json::<Value>().await {
                        let latest = rel
                            .get("tag_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim_start_matches('v')
                            .to_string();
                        if !latest.is_empty() && is_semver_newer(&latest, current) {
                            let _ = app.emit(
                                "update-available-prompt",
                                json!({ "version": latest }),
                            );
                            return json!({ "success": true, "version": latest, "updateAvailable": true });
                        }
                        if is_manual {
                            let _ = app.emit(
                                "update-msg",
                                json!({ "key": "msg_up_to_date", "text": "Gens Launcher est à jour !", "type": "success" }),
                            );
                        }
                        return json!({ "success": true, "version": Value::Null, "updateAvailable": false });
                    }
                }
                _ => {}
            }
            if is_manual {
                let _ = app.emit(
                    "update-msg",
                    json!({ "key": "msg_update_error", "text": "Erreur lors de la vérification des mises à jour.", "type": "error" }),
                );
            }
            return json!({ "success": false, "error": "Impossible de vérifier les mises à jour." });
        }

        // Standard Windows / Linux AppImage / macOS path via electron-updater YAML manifest
        let yml_name = if cfg!(target_os = "windows") {
            "latest.yml"
        } else if cfg!(target_os = "macos") {
            "latest-mac.yml"
        } else {
            "latest-linux.yml"
        };
        let yml_url = format!("{}/{}", REPO_BASE, yml_name);

        let resp = match http
            .get(&yml_url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => {
                // Fallback to GitHub Releases API if latest.yml is not present yet
                return self.check_via_github_api_fallback(app, http, is_manual).await;
            }
        };

        let yml_text = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                if is_manual {
                    let _ = app.emit(
                        "update-msg",
                        json!({ "key": "msg_update_error", "text": "Erreur lecture manifeste de mise à jour.", "type": "error" }),
                    );
                }
                return json!({ "success": false, "error": e.to_string() });
            }
        };

        let Some(info) = parse_electron_yml(&yml_text) else {
            return self.check_via_github_api_fallback(app, http, is_manual).await;
        };

        if is_semver_newer(&info.version, current) {
            let safe_file_name = std::path::Path::new(&info.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&info.path)
                .to_string();
            let download_url = if info.path.starts_with("https://") {
                info.path.clone()
            } else {
                format!("{}/{}", REPO_BASE, info.path.trim_start_matches('/'))
            };
            if let Ok(mut guard) = self.pending.lock() {
                *guard = Some(PendingUpdate {
                    version: info.version.clone(),
                    download_url,
                    file_name: safe_file_name,
                    expected_sha512_b64: info.sha512.clone(),
                    expected_size: info.size,
                });
            }
            let _ = app.emit(
                "update-available-prompt",
                json!({ "version": info.version }),
            );
            return json!({
                "success": true,
                "version": info.version,
                "latestVersion": format!("v{}", info.version),
                "updateAvailable": true
            });
        }

        if is_manual {
            let _ = app.emit(
                "update-msg",
                json!({ "key": "msg_up_to_date", "text": "Gens Launcher est à jour !", "type": "success" }),
            );
        }
        json!({
            "success": true,
            "version": Value::Null,
            "latestVersion": format!("v{}", info.version),
            "updateAvailable": false
        })
    }

    async fn check_via_github_api_fallback(
        &self,
        app: &AppHandle,
        http: &Client,
        is_manual: bool,
    ) -> Value {
        let current = env!("CARGO_PKG_VERSION");
        match http
            .get(API_LATEST)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                if let Ok(v) = r.json::<Value>().await {
                    let tag = v
                        .get("tag_name")
                        .and_then(|t| t.as_str())
                        .unwrap_or(current);
                    let clean = tag.trim_start_matches('v');
                    let newer = is_semver_newer(clean, current);
                    if newer {
                        let _ = app.emit("update-available-prompt", json!({ "version": clean }));
                    } else if is_manual {
                        let _ = app.emit(
                            "update-msg",
                            json!({ "key": "msg_up_to_date", "text": "Gens Launcher est à jour !", "type": "success" }),
                        );
                    }
                    return json!({
                        "success": true,
                        "version": if newer { json!(clean) } else { Value::Null },
                        "latestVersion": tag,
                        "updateAvailable": newer
                    });
                }
            }
            _ => {}
        }
        if is_manual {
            let _ = app.emit(
                "update-msg",
                json!({ "key": "msg_update_error", "text": "Erreur lors de la vérification des mises à jour.", "type": "error" }),
            );
        }
        json!({ "success": false })
    }

    pub async fn download_update(&self, app: &AppHandle, http: &Client) {
        if Self::is_deb_package_installation() {
            return;
        }
        let pending = self.pending.lock().ok().and_then(|g| g.clone());
        let Some(upd) = pending else {
            let _ = app.opener().open_url(
                "https://github.com/WilliamBossard/Gens-Launcher/releases/latest",
                None::<&str>,
            );
            return;
        };

        if let Err(err) = self.download_update_inner(app, http, &upd).await {
            let _ = app.emit(
                "update-msg",
                json!({
                    "key": "msg_update_dl_error",
                    "text": format!("Erreur téléchargement mise à jour : {}", err),
                    "type": "error"
                }),
            );
        }
    }

    async fn download_update_inner(
        &self,
        app: &AppHandle,
        http: &Client,
        upd: &PendingUpdate,
    ) -> Result<(), String> {
        assert_allowed_https_url(&upd.download_url, "updater", ALLOWED_DOWNLOAD_DOMAINS)?;
        if upd.expected_sha512_b64.is_empty() {
            return Err("Empreinte SHA-512 manquante dans le manifeste de mise à jour.".into());
        }

        let updates_dir = safe_data_dir().join("updates");
        fs::create_dir_all(&updates_dir).map_err(|e| e.to_string())?;
        let dest_path = updates_dir.join(&upd.file_name);
        let tmp_path = dest_path.with_extension(format!("tmp.{}", std::process::id()));

        let resp = http
            .get(&upd.download_url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(upd.expected_size);
        if total > MAX_UPDATE_BYTES {
            return Err("Fichier de mise à jour trop volumineux.".into());
        }

        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        let mut hasher = Sha512::new();
        let mut received: u64 = 0;
        let mut last_emit = Instant::now();
        let mut stream = resp.bytes_stream();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                e.to_string()
            })?;
            received = received.saturating_add(chunk.len() as u64);
            if received > MAX_UPDATE_BYTES {
                drop(file);
                let _ = fs::remove_file(&tmp_path);
                return Err("Taille maximale dépassée.".into());
            }
            file.write_all(&chunk).map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                e.to_string()
            })?;
            hasher.update(&chunk);
            if last_emit.elapsed() >= Duration::from_millis(120) {
                last_emit = Instant::now();
                let pct = if total > 0 {
                    ((received as f64 / total as f64) * 100.0).min(100.0).round() as u64
                } else {
                    0
                };
                let _ = app.emit("update-progress", pct);
            }
        }
        drop(file);

        let actual_b64 = base64_encode(&hasher.finalize());
        if actual_b64 != upd.expected_sha512_b64.trim() {
            let _ = fs::remove_file(&tmp_path);
            return Err("Échec de vérification SHA-512 de la mise à jour !".into());
        }

        rename_with_retry(&tmp_path, &dest_path)?;
        if let Ok(mut guard) = self.downloaded_path.lock() {
            *guard = Some(dest_path);
        }
        let _ = app.emit("update-progress", 100);
        let _ = app.emit("update-downloaded", json!({ "version": upd.version }));
        Ok(())
    }

    pub fn restart_and_install(&self, app: &AppHandle) {
        if !self.user_confirmed.swap(false, Ordering::SeqCst) {
            return;
        }

        #[cfg(target_os = "linux")]
        {
            if self.deb_already_installed.swap(false, Ordering::SeqCst) {
                app.restart();
            }
            if let Ok(appimage_path) = std::env::var("APPIMAGE") {
                if let Some(downloaded) = self.downloaded_path.lock().ok().and_then(|g| g.clone()) {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&downloaded, fs::Permissions::from_mode(0o755));
                    let target = PathBuf::from(&appimage_path);
                    let replaced = fs::rename(&downloaded, &target)
                        .or_else(|_| {
                            fs::copy(&downloaded, &target)?;
                            let _ = fs::remove_file(&downloaded);
                            Ok::<_, std::io::Error>(())
                        })
                        .is_ok();
                    if replaced {
                        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
                        let _ = std::process::Command::new(&target).spawn();
                        app.exit(0);
                    }
                }
            }
            app.restart();
        }

        #[cfg(target_os = "windows")]
        {
            if let Some(installer) = self.downloaded_path.lock().ok().and_then(|g| g.clone())
                && installer.is_file() {
                    let _ = std::process::Command::new(&installer).spawn();
                    app.exit(0);
                }
            app.restart();
        }

        #[cfg(target_os = "macos")]
        {
            if let Some(pkg) = self.downloaded_path.lock().ok().and_then(|g| g.clone()) {
                if pkg.is_file() {
                    let _ = app
                        .opener()
                        .open_path(pkg.to_string_lossy().to_string(), None::<&str>);
                    app.exit(0);
                }
            }
            app.restart();
        }
    }

    pub async fn do_deb_update(&self, app: &AppHandle, http: &Client) -> Result<Value, String> {
        #[cfg(target_os = "linux")]
        {
            if !Self::is_deb_package_installation() {
                return Ok(json!({ "success": false, "errorCode": "NOT_DEB", "error": "Not a .deb installation" }));
            }
            let key_path = "/usr/share/keyrings/gens-launcher-keyring.gpg";
            let sources_path = "/etc/apt/sources.list.d/gens-launcher.list";
            let has_key = std::path::Path::new(key_path).exists();
            let has_sources = std::path::Path::new(sources_path).exists();

            let mut tmp_key_file: Option<PathBuf> = None;
            let pkexec_args: Vec<String> = if !has_key || !has_sources {
                let _ = app.emit(
                    "update-msg",
                    json!({ "key": "msg_apt_setup", "text": "Configuration du dépôt APT...", "type": "info" }),
                );
                let mut parts: Vec<String> = Vec::new();
                if !has_key {
                    let key_bytes = http
                        .get("https://williambossard.github.io/Gens-Launcher/public.key")
                        .timeout(Duration::from_secs(15))
                        .send()
                        .await
                        .map_err(|e| e.to_string())?
                        .bytes()
                        .await
                        .map_err(|e| e.to_string())?;
                    let mut h = Sha256::new();
                    h.update(&key_bytes);
                    let actual = crate::encoding::hex_encode(&h.finalize());
                    if actual != APT_KEY_SHA256 {
                        return Ok(json!({ "success": false, "error": format!("Empreinte SHA-256 invalide pour public.key ({})", actual) }));
                    }
                    let tmp = std::env::temp_dir().join(format!("gens-apt-key-{}.asc", std::process::id()));
                    fs::write(&tmp, &key_bytes).map_err(|e| e.to_string())?;
                    tmp_key_file = Some(tmp);
                    parts.push("gpg --batch --yes --dearmor -o \"$1\" \"$2\"".into());
                }
                if !has_sources {
                    parts.push("printf \"%s\\n\" \"$3\" > \"$4\"".into());
                }
                parts.push("apt-get update -qq".into());
                parts.push("apt-get install -y gens-launcher".into());
                let repo_line = format!(
                    "deb [signed-by={}] https://williambossard.github.io/Gens-Launcher ./",
                    key_path
                );
                vec![
                    "sh".into(),
                    "-c".into(),
                    parts.join(" && "),
                    "_".into(),
                    key_path.into(),
                    tmp_key_file
                        .as_ref()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    repo_line,
                    sources_path.into(),
                ]
            } else {
                vec![
                    "sh".into(),
                    "-c".into(),
                    "apt-get update -qq && apt-get install -y gens-launcher".into(),
                ]
            };

            let _ = app.emit(
                "update-msg",
                json!({ "key": "msg_apt_installing", "text": "Installation en cours...", "type": "info" }),
            );
            let out = tokio::process::Command::new("pkexec")
                .args(&pkexec_args)
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if let Some(tmp) = tmp_key_file {
                let _ = fs::remove_file(tmp);
            }
            if out.status.success() {
                self.deb_already_installed.store(true, Ordering::SeqCst);
                Ok(json!({ "success": true }))
            } else {
                let msg = String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .next()
                    .unwrap_or("APT update failed")
                    .to_string();
                Ok(json!({ "success": false, "error": msg }))
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (app, http);
            Ok(json!({ "success": false, "errorCode": "NOT_DEB", "error": "Not a .deb installation" }))
        }
    }
}

/// Parse an `electron-updater` YAML manifest (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`).
pub fn parse_electron_yml(content: &str) -> Option<ElectronYmlInfo> {
    let mut version = String::new();
    let mut path = String::new();
    let mut sha512 = String::new();
    let mut size: u64 = 0;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let clean_val = |v: &str| v.trim().trim_matches(|c| c == '\'' || c == '"').to_string();
        if let Some(v) = line.strip_prefix("version:") {
            version = clean_val(v);
        } else if let Some(v) = line.strip_prefix("path:") {
            path = clean_val(v);
        } else if let Some(v) = line.strip_prefix("- url:") {
            if path.is_empty() {
                path = clean_val(v);
            }
        } else if let Some(v) = line.strip_prefix("sha512:") {
            if sha512.is_empty() || !raw_line.starts_with(' ') {
                sha512 = clean_val(v);
            }
        } else if let Some(v) = line.strip_prefix("size:")
            && let Ok(n) = clean_val(v).parse::<u64>() {
                size = n;
            }
    }

    if version.is_empty() || path.is_empty() {
        return None;
    }
    Some(ElectronYmlInfo {
        version,
        path,
        sha512,
        size,
    })
}
