//! Optional external Gens-Horizon Go binary bridge + SHA-256 fail-closed GitHub installer,
//! strict argument whitelist, sequential execution queue, bounded timeouts,
//! semver update check, and structured directory layout (1:1 parity with src/main/ipc-horizon.js).

use crate::crypto::{hash_bytes, hash_file};
use crate::sandbox::{safe_data_dir, write_atomic};
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const ALLOWED_PROVIDERS: &[&str] = &["google", "dropbox", "onedrive"];
const ALLOWED_SYNC_MODES: &[&str] = &["SMART", "FULL"];
const ALLOWED_SELECTIVE_PROFILES: &[&str] = &[
    "",
    "FULL",
    "ESSENTIAL",
    "WORLDS_ONLY",
    "WORLDS_MODS_PACKS",
];

const ALLOWED_PUBLIC_COMMANDS: &[&str] = &[
    "--check",
    "--sync",
    "--upload",
    "--login",
    "--quota",
    "--rollback",
    "--status",
    "--clean",
    "--has-e2e-key",
    "--help",
    "--version",
];

const ALLOWED_INTERNAL_COMMANDS: &[&str] = &["--logout", "--set-e2e-key", "--get-e2e-key"];

const HASH_CACHE_TTL: Duration = Duration::from_secs(2 * 60 * 60); // 2h

struct IntegrityCache {
    expected_sha256: Option<(String, Instant)>,
    local_hash: Option<(String, u128, u64)>, // (hash, mtime_ms, size)
}

fn integrity_cache() -> &'static StdMutex<IntegrityCache> {
    static CACHE: OnceLock<StdMutex<IntegrityCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        StdMutex::new(IntegrityCache {
            expected_sha256: None,
            local_hash: None,
        })
    })
}

fn horizon_queue() -> &'static Mutex<()> {
    static QUEUE: OnceLock<Mutex<()>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(()))
}

pub fn horizon_dir() -> PathBuf {
    safe_data_dir().join("Horizon")
}

pub fn ensure_horizon_dirs() {
    let base = horizon_dir();
    for sub in ["", "auth", "metadata", "manifests", "cache"] {
        let p = if sub.is_empty() {
            base.clone()
        } else {
            base.join(sub)
        };
        let _ = fs::create_dir_all(p);
    }
}

pub fn horizon_exe() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "Horizon.exe"
    } else {
        "Horizon"
    };
    let modern = horizon_dir().join(name);
    if modern.is_file() {
        return modern;
    }
    let legacy = safe_data_dir().join("bin").join(name);
    if legacy.is_file() {
        return legacy;
    }
    modern
}

/// Validate Horizon CLI arguments (strict whitelist + character validation matching ipc-horizon.js).
pub fn validate_horizon_args(args: &[String], allow_internal: bool) -> Result<(), String> {
    if args.is_empty() {
        return Err("Arguments Horizon vides.".into());
    }
    let cmd = args[0].as_str();
    let cmd_ok = ALLOWED_PUBLIC_COMMANDS.contains(&cmd)
        || (allow_internal && ALLOWED_INTERNAL_COMMANDS.contains(&cmd));
    if !cmd_ok {
        return Err(format!("Commande Horizon non autorisée : {}", cmd));
    }

    for arg in &args[1..] {
        if arg.is_empty() || arg.len() > 200 || arg.contains("..") || arg.contains('\0') {
            return Err(format!("Argument Horizon invalide : {}", arg));
        }
        if let Some(flag_rest) = arg.strip_prefix("--") {
            // Matches ^--[a-zA-Z-]+(=[a-zA-Z0-9_.-]+)?$
            let (name, val_opt) = match flag_rest.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (flag_rest, None),
            };
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphabetic() || c == '-') {
                return Err(format!("Flag Horizon non autorisé : {}", arg));
            }
            if let Some(val) = val_opt
                && (val.is_empty()
                    || !val
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
                {
                    return Err(format!("Valeur de flag Horizon non autorisée : {}", arg));
                }
        } else if arg.starts_with('-') {
            return Err(format!("Option courte Horizon non autorisée : {}", arg));
        } else {
            // Positional instance name: unicode letters/digits + safe punctuation, no slashes
            let ok = arg.chars().all(|c| {
                c.is_alphanumeric() || matches!(c, '_' | '-' | ' ' | '\'' | '(' | ')' | '.')
            });
            if !ok {
                return Err(format!("Nom d'instance Horizon non autorisé : {}", arg));
            }
        }
    }
    Ok(())
}

fn is_write_op(args: &[String]) -> bool {
    let Some(cmd) = args.first().map(|s| s.as_str()) else {
        return false;
    };
    if cmd == "--sync" && args.iter().any(|a| a == "--list") {
        return false;
    }
    matches!(
        cmd,
        "--sync" | "--upload" | "--rollback" | "--clean" | "--login" | "--logout" | "--set-e2e-key"
    )
}

/// Returns true strictly if `candidate` is newer than `current` using semver ordering.
pub fn is_semver_newer(candidate: &str, current: &str) -> bool {
    let parse = |raw: &str| -> Option<(u64, u64, u64)> {
        let trimmed = raw.trim().trim_start_matches(['v', 'V']);
        let core = trimmed.split(&['-', '+'][..]).next().unwrap_or("");
        let parts: Vec<&str> = core.split('.').collect();
        if parts.is_empty() || parts.len() > 3 {
            return None;
        }
        let maj = parts[0].parse::<u64>().ok()?;
        let min = parts.get(1).and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        let pat = parts.get(2).and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        Some((maj, min, pat))
    };
    match (parse(candidate), parse(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => candidate.trim() != current.trim(),
    }
}

pub fn get_horizon_settings() -> Value {
    for p in [
        horizon_dir().join("horizon_settings.json"),
        safe_data_dir().join("bin").join("horizon_settings.json"),
    ] {
        if let Ok(txt) = fs::read_to_string(&p)
            && let Ok(v) = serde_json::from_str::<Value>(&txt) {
                return v;
            }
    }
    json!({
        "systemEnabled": true,
        "enabled": false,
        "provider": "google",
        "syncMode": "SMART",
        "autoSync": true,
        "autoUpload": true
    })
}

fn parse_bool_like(v: &Value) -> bool {
    if let Some(b) = v.as_bool() {
        return b;
    }
    if let Some(s) = v.as_str() {
        let low = s.trim().to_lowercase();
        return !matches!(low.as_str(), "false" | "0" | "");
    }
    if let Some(n) = v.as_i64() {
        return n != 0;
    }
    false
}

pub fn save_horizon_settings(settings: &Value) -> Result<Value, String> {
    ensure_horizon_dirs();
    let Some(obj) = settings.as_object() else {
        return Err("Paramètres Horizon invalides.".into());
    };

    let mut normalized = obj.clone();
    if !normalized.contains_key("deltaCleanupThreshold")
        && let Some(dt) = normalized.get("deltaThreshold").cloned() {
            normalized.insert("deltaCleanupThreshold".into(), dt);
        }

    let mut safe = Map::new();
    for (k, v) in &normalized {
        match k.as_str() {
            "provider" => {
                let s = v.as_str().unwrap_or("");
                if !ALLOWED_PROVIDERS.contains(&s) {
                    return Err(format!("Fournisseur cloud Horizon non autorisé : {}", s));
                }
                safe.insert(k.clone(), Value::String(s.to_string()));
            }
            "syncMode" => {
                let s = v.as_str().unwrap_or("");
                if !ALLOWED_SYNC_MODES.contains(&s) {
                    return Err(format!("Mode de synchronisation Horizon non autorisé : {}", s));
                }
                safe.insert(k.clone(), Value::String(s.to_string()));
            }
            "autoSync"
            | "autoUpload"
            | "systemEnabled"
            | "enabled"
            | "verifyIntegrityOnLaunch"
            | "dryRunPreview"
            | "e2eEncryption"
            | "selectiveSync" => {
                safe.insert(k.clone(), Value::Bool(parse_bool_like(v)));
            }
            "selectiveProfiles" => {
                let mut clean_profiles = Map::new();
                if let Some(pmap) = v.as_object() {
                    for (inst_key, prof_val) in pmap {
                        let tk = inst_key.trim();
                        if tk.is_empty() || tk.len() > 100 {
                            continue;
                        }
                        if let Some(pv) = prof_val.as_str()
                            && ALLOWED_SELECTIVE_PROFILES.contains(&pv) && !pv.is_empty() && pv != "FULL" {
                                clean_profiles.insert(tk.to_string(), Value::String(pv.to_string()));
                            }
                    }
                }
                safe.insert(k.clone(), Value::Object(clean_profiles));
            }
            "deltaCleanupThreshold" => {
                let n = v
                    .as_i64()
                    .or_else(|| v.as_f64().map(|f| f as i64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
                    .ok_or("Valeur numérique invalide pour deltaCleanupThreshold (attendu 3..50).")?;
                if !(3..=50).contains(&n) {
                    return Err("Valeur numérique invalide pour deltaCleanupThreshold (attendu 3..50).".into());
                }
                safe.insert(k.clone(), json!(n));
            }
            "maxRetries" => {
                let n = v
                    .as_i64()
                    .or_else(|| v.as_f64().map(|f| f as i64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
                    .ok_or("Valeur numérique invalide pour maxRetries (attendu 0..10).")?;
                if !(0..=10).contains(&n) {
                    return Err("Valeur numérique invalide pour maxRetries (attendu 0..10).".into());
                }
                safe.insert(k.clone(), json!(n));
            }
            "retryBaseDelay" => {
                if let Some(n) = v.as_u64()
                    && n <= 60_000 {
                        safe.insert(k.clone(), json!(n));
                    }
            }
            _ => {}
        }
    }

    // Merge with existing settings instead of overwriting unrelated keys
    let mut merged = get_horizon_settings()
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (k, v) in safe {
        merged.insert(k, v);
    }

    let p = horizon_dir().join("horizon_settings.json");
    let txt = serde_json::to_string_pretty(&Value::Object(merged)).map_err(|e| e.to_string())?;
    write_atomic(&p, txt.as_bytes())?;
    Ok(json!({ "success": true }))
}

pub fn check_horizon_status() -> Value {
    let dir = horizon_dir();
    let legacy_bin = safe_data_dir().join("bin");
    let exe = horizon_exe();
    let installed = exe.is_file();

    let settings = get_horizon_settings();
    let provider = settings
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("google")
        .to_string();

    let token_name = format!("token_{}.json", provider);
    let linked = dir.join("auth").join(&token_name).is_file()
        || dir.join(&token_name).is_file()
        || legacy_bin.join(&token_name).is_file()
        || (provider == "google" && legacy_bin.join("token.json").is_file());

    let mut local_version = "v0.0.0".to_string();
    for vpath in [
        dir.join("horizon_version.json"),
        legacy_bin.join("horizon_version.json"),
    ] {
        if let Ok(txt) = fs::read_to_string(&vpath)
            && let Ok(v) = serde_json::from_str::<Value>(&txt)
                && let Some(ver) = v.get("version").and_then(|s| s.as_str())
                    && !ver.trim().is_empty() {
                        local_version = ver.trim().to_string();
                        break;
                    }
    }

    json!({
        "installed": installed,
        "localVersion": local_version,
        "latestVersion": local_version,
        "needsUpdate": false,
        "linked": linked,
        "provider": provider,
        "path": exe.to_string_lossy()
    })
}

pub async fn check_horizon_status_online(client: &Client, offline: bool) -> Value {
    let mut status = check_horizon_status();
    if offline {
        if let Some(obj) = status.as_object_mut() {
            obj.insert("offline".into(), Value::Bool(true));
        }
        return status;
    }
    let local_ver = status
        .get("localVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("v0.0.0")
        .to_string();
    if let Ok(resp) = client
        .get("https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        && resp.status().is_success()
            && let Ok(rel) = resp.json::<Value>().await
                && let Some(tag) = rel.get("tag_name").and_then(|v| v.as_str()) {
                    let needs_update = is_semver_newer(tag, &local_ver);
                    if let Some(obj) = status.as_object_mut() {
                        obj.insert("latestVersion".into(), Value::String(tag.to_string()));
                        obj.insert("needsUpdate".into(), Value::Bool(needs_update));
                    }
                }
    status
}

fn platform_asset_keywords() -> (&'static str, &'static str, &'static str) {
    let os_kw = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch_kw = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let arch_alt = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    (os_kw, arch_kw, arch_alt)
}

async fn verify_horizon_binary_integrity(client: &Client, exe: &Path) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let meta = fs::metadata(exe).map_err(|e| format!("Impossible de lire Horizon : {}", e))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let size = meta.len();

    let local_sha = {
        let cached = integrity_cache()
            .lock()
            .ok()
            .and_then(|c| c.local_hash.clone());
        if let Some((h, cm, cs)) = cached {
            if cm == mtime_ms && cs == size {
                h
            } else {
                let fresh = hash_file(exe, "sha256")?;
                if let Ok(mut c) = integrity_cache().lock() {
                    c.local_hash = Some((fresh.clone(), mtime_ms, size));
                }
                fresh
            }
        } else {
            let fresh = hash_file(exe, "sha256")?;
            if let Ok(mut c) = integrity_cache().lock() {
                c.local_hash = Some((fresh.clone(), mtime_ms, size));
            }
            fresh
        }
    };

    let expected_opt = {
        integrity_cache()
            .lock()
            .ok()
            .and_then(|c| c.expected_sha256.clone())
            .and_then(|(h, ts)| if ts.elapsed() < HASH_CACHE_TTL { Some(h) } else { None })
    };

    let expected = if let Some(h) = expected_opt {
        h
    } else {
        // Best-effort refresh from GitHub checksums; if offline, allow already-verified binary
        let Ok(resp) = client
            .get("https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest")
            .timeout(Duration::from_secs(6))
            .send()
            .await
        else {
            return Ok(());
        };
        if !resp.status().is_success() {
            return Ok(());
        }
        let Ok(rel) = resp.json::<Value>().await else {
            return Ok(());
        };
        let Some(assets) = rel.get("assets").and_then(|v| v.as_array()) else {
            return Ok(());
        };
        let (os_kw, arch_kw, arch_alt) = platform_asset_keywords();
        let mut bin_name = String::new();
        let mut checksums_url = String::new();
        for a in assets {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let dl = a
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let low = name.to_lowercase();
            if low.contains("checksum") || low.ends_with(".sha256") {
                checksums_url = dl.to_string();
            } else if low.contains(os_kw) && (low.contains(arch_kw) || low.contains(arch_alt)) {
                bin_name = name.to_string();
            }
        }
        if checksums_url.is_empty() || bin_name.is_empty() {
            return Ok(());
        }
        let Ok(chk_resp) = client
            .get(&checksums_url)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        else {
            return Ok(());
        };
        let Ok(chk_txt) = chk_resp.text().await else {
            return Ok(());
        };
        let mut found = None;
        for line in chk_txt.lines() {
            if line.contains(&bin_name)
                && let Some(h) = line.split_whitespace().next() {
                    found = Some(h.to_lowercase());
                    break;
                }
        }
        let Some(h) = found else {
            return Ok(());
        };
        if let Ok(mut c) = integrity_cache().lock() {
            c.expected_sha256 = Some((h.clone(), Instant::now()));
        }
        h
    };

    if !local_sha.eq_ignore_ascii_case(&expected) {
        return Err("SÉCURITÉ CRITIQUE : Empreinte SHA-256 du binaire Horizon invalide !".into());
    }
    Ok(())
}

pub async fn install_horizon(app: &AppHandle, client: &Client) -> Result<Value, String> {
    let _lock = horizon_queue().lock().await;
    ensure_horizon_dirs();
    let _ = app.emit("horizon-install-progress", 10);
    let rel: Value = client
        .get("https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let tag = rel
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("latest")
        .to_string();
    let assets = rel
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or("Assets GitHub introuvables")?;

    let (os_kw, arch_kw, arch_alt) = platform_asset_keywords();
    let mut bin_url = String::new();
    let mut bin_name = String::new();
    let mut checksums_url = String::new();

    for a in assets {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let dl = a
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let low = name.to_lowercase();
        if low.contains("checksum") || low.ends_with(".sha256") {
            checksums_url = dl.to_string();
        } else if low.contains(os_kw) && (low.contains(arch_kw) || low.contains(arch_alt)) {
            bin_url = dl.to_string();
            bin_name = name.to_string();
        }
    }
    if bin_url.is_empty() {
        return Ok(json!({ "success": false, "error": "Binaire Horizon compatible introuvable." }));
    }

    // Fail-closed in release builds: checksums file is mandatory
    if checksums_url.is_empty() && !cfg!(debug_assertions) {
        return Ok(json!({ "success": false, "error": "Fichier checksums SHA-256 Horizon manquant (fail-closed)." }));
    }

    let _ = app.emit("horizon-install-progress", 40);
    let bytes = client
        .get(&bin_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    if !checksums_url.is_empty() {
        let chk_txt = client
            .get(&checksums_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let mut verified = false;
        for line in chk_txt.lines() {
            if line.contains(&bin_name)
                && let Some(expected) = line.split_whitespace().next() {
                    let actual = hash_bytes(&bytes, "sha256")?;
                    if !actual.eq_ignore_ascii_case(expected) {
                        return Ok(json!({ "success": false, "error": "Empreinte SHA-256 Horizon invalide !" }));
                    }
                    verified = true;
                    break;
                }
        }
        if !verified && !cfg!(debug_assertions) {
            return Ok(json!({ "success": false, "error": "Entrée SHA-256 introuvable pour le binaire Horizon." }));
        }
    }

    let name = if cfg!(target_os = "windows") {
        "Horizon.exe"
    } else {
        "Horizon"
    };
    let exe_path = horizon_dir().join(name);
    write_atomic(&exe_path, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&exe_path, fs::Permissions::from_mode(0o755));
    }
    let _ = write_atomic(
        &horizon_dir().join("horizon_version.json"),
        json!({ "version": tag }).to_string().as_bytes(),
    );
    if let Ok(mut c) = integrity_cache().lock() {
        c.local_hash = None;
        c.expected_sha256 = None;
    }
    let _ = app.emit("horizon-install-progress", 100);
    Ok(json!({ "success": true, "version": tag }))
}

pub async fn run_horizon_args(
    app: &AppHandle,
    client: &Client,
    args: &[String],
    stdin_payload: Option<&str>,
    allow_internal: bool,
) -> Result<Value, String> {
    if let Err(reason) = validate_horizon_args(args, allow_internal) {
        return Ok(json!({
            "exitCode": -1,
            "lastJson": Value::Null,
            "success": false,
            "error": reason
        }));
    }

    let write_op = is_write_op(args);
    let _guard = if write_op {
        Some(horizon_queue().lock().await)
    } else {
        None
    };

    let exe = horizon_exe();
    if !exe.is_file() {
        return Ok(json!({
            "exitCode": -1,
            "lastJson": { "type": "ERROR", "message": "Gens-Horizon non installé." },
            "success": false,
            "error": "Gens-Horizon non installé."
        }));
    }

    if let Err(err) = verify_horizon_binary_integrity(client, &exe).await {
        let _ = app.emit("horizon-status", json!({ "type": "ERROR", "message": err }));
        return Ok(json!({
            "exitCode": -1,
            "lastJson": { "type": "ERROR", "message": err },
            "success": false,
            "error": err
        }));
    }

    let is_e2e = args
        .first()
        .map(|s| s == "--set-e2e-key" || s == "--get-e2e-key")
        .unwrap_or(false);
    let timeout = if is_e2e {
        Duration::from_secs(15)
    } else if write_op {
        Duration::from_secs(60 * 60)
    } else {
        Duration::from_secs(10 * 60)
    };

    let cwd = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(horizon_dir);
    let instances_dir = safe_data_dir().join("instances");

    let mut cmd = Command::new(&exe);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd.args(args)
        .current_dir(&cwd)
        .env("HORIZON_DATA_DIR", &cwd)
        .env("GENS_INSTANCES_DIR", &instances_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        let _ = stdin.write_all(payload.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }

    let exec_future = async {
        let mut last_json: Option<Value> = None;
        let mut raw_out = String::new();
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if !is_e2e {
                        let _ = app.emit("horizon-status", &v);
                    }
                    last_json = Some(v);
                }
                if raw_out.len() < 256 * 1024 {
                    raw_out.push_str(&line);
                    raw_out.push('\n');
                }
            }
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<(i32, bool, Option<Value>, String), String>((
            status.code().unwrap_or(-1),
            status.success(),
            last_json,
            raw_out,
        ))
    };

    let (exit_code, ok_status, last_json, raw_out) = match tokio::time::timeout(timeout, exec_future).await {
        Ok(res) => res?,
        Err(_) => {
            let _ = child.kill().await;
            return Ok(json!({
                "exitCode": -1,
                "lastJson": { "type": "ERROR", "message": "Délai d'attente dépassé lors de l'opération Horizon." },
                "success": false,
                "error": "Délai d'attente dépassé lors de l'opération Horizon."
            }));
        }
    };

    if is_e2e {
        let is_err_type = last_json
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            == Some("ERROR");
        if ok_status && last_json.is_some() && !is_err_type {
            let passphrase = last_json
                .as_ref()
                .and_then(|v| v.get("passphrase"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let has_key = last_json
                .as_ref()
                .and_then(|v| v.get("hasKey"))
                .and_then(|v| v.as_bool())
                .unwrap_or_else(|| passphrase.as_ref().map(|s| !s.is_empty()).unwrap_or(false));
            return Ok(json!({
                "success": true,
                "hasKey": has_key,
                "passphrase": passphrase,
                "exitCode": exit_code,
                "lastJson": last_json
            }));
        }
        let msg = last_json
            .as_ref()
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Erreur configuration clé E2E");
        return Ok(json!({
            "success": false,
            "error": msg,
            "exitCode": exit_code,
            "lastJson": last_json
        }));
    }

    Ok(json!({
        "exitCode": exit_code,
        "lastJson": last_json,
        "success": ok_status,
        "code": exit_code,
        "data": last_json,
        "output": raw_out
    }))
}
