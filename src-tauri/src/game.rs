//! Full native Rust Minecraft Launcher (Vanilla / Fabric / Quilt / Forge / NeoForge),
//! ForgeWrapper support, Mojang rule/arch evaluation, retry downloads, Java scanner,
//! Adoptium installer (SHA-256 verified), and Forge installer runner.

use crate::archive::{extract_tar_privileged, extract_zip_privileged};
use crate::crypto::{hash_bytes, hash_file};
use crate::game_validation::{
    validate_custom_jvm_args, validate_custom_launch_args, validate_java_executable,
    validate_launch_overrides, validate_safe_segment,
};
use crate::sandbox::{
    assert_read_sandbox_opts, assert_renderer_write_sandbox, safe_data_dir, write_atomic,
    AccessMode,
};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Semaphore;

const DEFAULT_FW_VERSION: &str = "1.6.0";
const DEFAULT_FW_BASE_URL: &str = "https://github.com/ZekerZhayard/ForgeWrapper/releases/download/";
const DEFAULT_FW_SHA1: &str = "035a51fe6439792a61507630d89382f621da0f1f";
const DEFAULT_FW_SIZE: u64 = 34715;

pub struct GameManager {
    running_pids: Mutex<HashMap<String, u32>>,
    pending_launches: Mutex<HashSet<String>>,
}

impl GameManager {
    pub fn new() -> Self {
        Self {
            running_pids: Mutex::new(HashMap::new()),
            pending_launches: Mutex::new(HashSet::new()),
        }
    }

    pub fn still_running(&self) -> Vec<String> {
        let mut alive: HashSet<String> = self
            .running_pids
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();

        // Also scan instances/*/instance.lock for detached/surviving Java processes
        let instances_dir = safe_data_dir().join("instances");
        if let Ok(entries) = fs::read_dir(&instances_dir) {
            for entry in entries.flatten() {
                let folder = entry.path();
                if !folder.is_dir() {
                    continue;
                }
                let lock_file = folder.join("instance.lock");
                if !lock_file.is_file() {
                    continue;
                }
                let raw = fs::read_to_string(&lock_file).unwrap_or_default();
                let trimmed = raw.trim();
                let pid_opt: Option<u32> = if trimmed.starts_with('{') {
                    serde_json::from_str::<Value>(trimmed)
                        .ok()
                        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
                        .map(|n| n as u32)
                } else {
                    trimmed.parse::<u32>().ok()
                };
                if let Some(pid) = pid_opt
                    && pid > 0 && is_running_java_pid(pid) {
                        let mut inst_name = entry.file_name().to_string_lossy().to_string();
                        if let Ok(jtxt) = fs::read_to_string(folder.join("instance.json"))
                            && let Ok(jv) = serde_json::from_str::<Value>(&jtxt)
                                && let Some(n) = jv.get("name").and_then(|v| v.as_str())
                                    && !n.is_empty() {
                                        inst_name = n.to_string();
                                    }
                        alive.insert(inst_name);
                        continue;
                    }
                // Stale lock file -> clean up
                let _ = fs::remove_file(&lock_file);
            }
        }
        alive.into_iter().collect()
    }

    pub fn force_stop(&self, instance_id: &str) -> Value {
        let pid = self
            .running_pids
            .lock()
            .ok()
            .and_then(|mut m| m.remove(instance_id));
        if let Some(pid) = pid {
            kill_pid(pid);
            return json!({ "success": true });
        }
        json!({ "success": false })
    }

    pub async fn launch_game(&self, app: AppHandle, http: Client, opts: Value) {
        let inst_id = opts
            .get("instanceId")
            .or_else(|| opts.get("instanceName"))
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        // Prevent duplicate concurrent launches for the same instance
        {
            let already_running = self
                .running_pids
                .lock()
                .map(|m| m.contains_key(&inst_id))
                .unwrap_or(false);
            let mut pending = self
                .pending_launches
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if already_running || !pending.insert(inst_id.clone()) {
                let _ = app.emit(
                    "launch-game-rejected",
                    json!({ "instanceId": inst_id, "reason": "ALREADY_RUNNING" }),
                );
                return;
            }
        }

        let res = self.launch_game_inner(&app, &http, &inst_id, &opts).await;
        if let Ok(mut pending) = self.pending_launches.lock() {
            pending.remove(&inst_id);
        }
        if let Err(err) = res {
            let _ = app.emit(
                "mc-data",
                json!({ "instanceId": inst_id, "data": format!("[Launcher] Erreur: {}", err) }),
            );
            let _ = app.emit("mc-close", json!({ "instanceId": inst_id, "code": 1 }));
        }
    }

    async fn launch_game_inner(
        &self,
        app: &AppHandle,
        http: &Client,
        inst_id: &str,
        opts: &Value,
    ) -> Result<(), String> {
        let root_raw = opts
            .get("root")
            .and_then(|v| v.as_str())
            .ok_or("Dossier root manquant")?;
        let root = assert_renderer_write_sandbox(root_raw, AccessMode::Write)?;
        validate_launch_overrides(opts)?;
        let validated_jvm_args = validate_custom_jvm_args(opts.get("customArgs"))?;
        let validated_launch_args = validate_custom_launch_args(opts.get("customLaunchArgs"))?;

        let java_exe = opts
            .get("javaPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("java");
        validate_java_executable(java_exe)?;

        let offline = opts
            .get("offline")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let game_dir = opts
            .pointer("/overrides/gameDirectory")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone());
        let assets_dir = opts
            .pointer("/overrides/assetRoot")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("assets"));
        let libs_dir = opts
            .pointer("/overrides/libraryRoot")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("libraries"));
        let natives_dir = opts
            .pointer("/overrides/natives")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("natives"));

        fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&libs_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

        let ver_number_raw = opts
            .pointer("/version/number")
            .and_then(|v| v.as_str())
            .ok_or("Version Minecraft manquante")?;
        let ver_number_owned = validate_safe_segment(ver_number_raw, "version.number")?;
        let ver_number = ver_number_owned.as_str();
        let ver_custom_owned = match opts
            .pointer("/version/custom")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            Some(c) => Some(validate_safe_segment(c, "version.custom")?),
            None => None,
        };
        let ver_custom = ver_custom_owned.as_deref();

        let _ = app.emit(
            "mc-data",
            json!({ "instanceId": inst_id, "data": format!("[Gens-Rust] Préparation de Minecraft {}...", ver_custom.unwrap_or(ver_number)) }),
        );

        // 1. Charger/Télécharger le JSON de version de base
        let base_json = ensure_version_json(http, &root, ver_number, offline).await?;

        // 2. Client JAR
        let client_jar = root
            .join("versions")
            .join(ver_number)
            .join(format!("{}.jar", ver_number));
        if let Some(dl) = base_json.pointer("/downloads/client") {
            let url = dl.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let sha1 = dl.get("sha1").and_then(|v| v.as_str());
            if !url.is_empty() && !is_file_valid(&client_jar, sha1) {
                if offline {
                    return Err(format!(
                        "Client JAR {} manquant en mode hors-ligne.",
                        ver_number
                    ));
                }
                let _ = app.emit(
                    "mc-progress",
                    json!({ "instanceId": inst_id, "type": "client", "task": 0, "total": 1 }),
                );
                download_verified_with_retry(http, url, &client_jar, sha1, 3).await?;
                let _ = app.emit(
                    "mc-progress",
                    json!({ "instanceId": inst_id, "type": "client", "task": 1, "total": 1 }),
                );
            }
        }

        // 3. Profil custom (Fabric / Quilt / Forge / NeoForge) + ForgeWrapper si opts.forge fourni
        let mut custom_json: Option<Value> = None;
        let mut fw_extra_jvm: Vec<String> = Vec::new();
        if let Some(forge_path_raw) = opts
            .get("forge")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            let forge_jar = assert_read_sandbox_opts(forge_path_raw, true, false)?;
            let (fw_json, extra_jvm) = resolve_forged_wrapped(
                &root,
                ver_number,
                &forge_jar,
                &libs_dir,
                &client_jar,
                opts,
            )?;
            fw_extra_jvm = extra_jvm;
            custom_json = Some(fw_json);
        } else if let Some(cust) = ver_custom {
            let p = root
                .join("versions")
                .join(cust)
                .join(format!("{}.json", cust));
            if p.is_file() {
                let txt = fs::read_to_string(&p).map_err(|e| e.to_string())?;
                custom_json = Some(serde_json::from_str(&txt).map_err(|e| e.to_string())?);
            }
        }

        // 4. Bibliothèques + Natives (base + custom + mavenFiles)
        let mut all_libs: Vec<Value> = Vec::new();
        if let Some(c) = &custom_json {
            if let Some(arr) = c.get("libraries").and_then(|v| v.as_array()) {
                all_libs.extend(arr.iter().cloned());
            }
            if let Some(arr) = c.get("mavenFiles").and_then(|v| v.as_array()) {
                all_libs.extend(arr.iter().cloned());
            }
        }
        if let Some(arr) = base_json.get("libraries").and_then(|v| v.as_array()) {
            all_libs.extend(arr.iter().cloned());
        }

        let current_os = current_os_name();
        let current_arch = current_arch_name();
        let mut cp_entries: Vec<String> = Vec::new();
        let mut seen_cp: HashSet<String> = HashSet::new();
        let mut dl_tasks: Vec<(String, PathBuf, Option<String>, bool)> = Vec::new();

        for lib in &all_libs {
            if should_skip_lib(lib, current_os, current_arch) {
                continue;
            }
            if let Some(art) = lib.pointer("/downloads/artifact") {
                if let (Some(rel), Some(url)) = (
                    art.get("path").and_then(|v| v.as_str()),
                    art.get("url").and_then(|v| v.as_str()),
                ) {
                    let target = libs_dir.join(rel);
                    let sha1 = art
                        .get("sha1")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let s = target.to_string_lossy().to_string();
                    if seen_cp.insert(s.clone()) {
                        cp_entries.push(s);
                    }
                    if !url.is_empty() && !is_file_valid(&target, sha1.as_deref()) {
                        dl_tasks.push((url.to_string(), target, sha1, false));
                    }
                }
            } else if let Some(name) = lib.get("name").and_then(|v| v.as_str())
                && let Some(rel) = maven_coord_to_path(name) {
                    let target = libs_dir.join(&rel);
                    let base_url = lib
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("https://libraries.minecraft.net/");
                    let url = format!("{}/{}", base_url.trim_end_matches('/'), rel);
                    let s = target.to_string_lossy().to_string();
                    if seen_cp.insert(s.clone()) {
                        cp_entries.push(s);
                    }
                    if !target.is_file() {
                        dl_tasks.push((url, target, None, false));
                    }
                }

            // Native classifier
            let native_key = if cfg!(target_os = "windows") {
                "natives-windows"
            } else if cfg!(target_os = "macos") {
                "natives-osx"
            } else {
                "natives-linux"
            };
            if let Some(nat) = lib.pointer(&format!("/downloads/classifiers/{}", native_key))
                && let (Some(rel), Some(url)) = (
                    nat.get("path").and_then(|v| v.as_str()),
                    nat.get("url").and_then(|v| v.as_str()),
                ) {
                    let target = libs_dir.join(rel);
                    let sha1 = nat
                        .get("sha1")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    dl_tasks.push((url.to_string(), target, sha1, true));
                }
        }

        if !dl_tasks.is_empty() {
            if offline {
                return Err(format!(
                    "{} bibliothèque(s) manquante(s) en mode hors-ligne.",
                    dl_tasks.len()
                ));
            }
            let total = dl_tasks.len();
            let done = Arc::new(AtomicUsize::new(0));
            let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let sem = Arc::new(Semaphore::new(8));
            let mut handles = Vec::new();
            for (url, target, sha1, is_native) in dl_tasks {
                let http_c = http.clone();
                let sem_c = Arc::clone(&sem);
                let done_c = Arc::clone(&done);
                let errs_c = Arc::clone(&errors);
                let app_c = app.clone();
                let id_c = inst_id.to_string();
                let nat_dir = natives_dir.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = sem_c.acquire().await.ok();
                    if !is_file_valid(&target, sha1.as_deref())
                        && let Err(e) =
                            download_verified_with_retry(&http_c, &url, &target, sha1.as_deref(), 3)
                                .await
                            && let Ok(mut list) = errs_c.lock() {
                                list.push(format!("{}: {}", url, e));
                            }
                    if is_native && target.is_file() {
                        let _ = extract_natives_jar(&target, &nat_dir);
                    }
                    let c = done_c.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = app_c.emit(
                        "mc-progress",
                        json!({ "instanceId": id_c, "type": "classes", "task": c, "total": total }),
                    );
                }));
            }
            for h in handles {
                let _ = h.await;
            }
            let failed = errors.lock().map(|v| v.clone()).unwrap_or_default();
            if !failed.is_empty() {
                return Err(format!(
                    "Échec du téléchargement de {} bibliothèque(s) (ex: {})",
                    failed.len(),
                    failed[0]
                ));
            }
        }

        // 5. Assets
        let asset_index_id = base_json
            .pointer("/assetIndex/id")
            .and_then(|v| v.as_str())
            .unwrap_or("legacy")
            .to_string();
        if let Some(ai_url) = base_json.pointer("/assetIndex/url").and_then(|v| v.as_str()) {
            let idx_path = assets_dir
                .join("indexes")
                .join(format!("{}.json", asset_index_id));
            let ai_sha1 = base_json.pointer("/assetIndex/sha1").and_then(|v| v.as_str());
            if !is_file_valid(&idx_path, ai_sha1) && !offline {
                download_verified_with_retry(http, ai_url, &idx_path, ai_sha1, 3).await?;
            }
            if let Ok(txt) = fs::read_to_string(&idx_path)
                && let Ok(idx_doc) = serde_json::from_str::<Value>(&txt)
                    && let Some(objs) = idx_doc.get("objects").and_then(|v| v.as_object()) {
                        let mut missing: Vec<(String, PathBuf)> = Vec::new();
                        for (_, obj) in objs {
                            if let Some(h) = obj.get("hash").and_then(|v| v.as_str())
                                && h.len() >= 2 {
                                    let p = assets_dir.join("objects").join(&h[..2]).join(h);
                                    if !p.is_file() {
                                        missing.push((h.to_string(), p));
                                    }
                                }
                        }
                        if !missing.is_empty() && !offline {
                            let total = missing.len();
                            let done = Arc::new(AtomicUsize::new(0));
                            let sem = Arc::new(Semaphore::new(12));
                            let mut handles = Vec::new();
                            for (h, p) in missing {
                                let http_c = http.clone();
                                let sem_c = Arc::clone(&sem);
                                let done_c = Arc::clone(&done);
                                let app_c = app.clone();
                                let id_c = inst_id.to_string();
                                handles.push(tokio::spawn(async move {
                                    let _permit = sem_c.acquire().await.ok();
                                    let url = format!(
                                        "https://resources.download.minecraft.net/{}/{}",
                                        &h[..2],
                                        h
                                    );
                                    let _ = download_verified_with_retry(
                                        &http_c,
                                        &url,
                                        &p,
                                        Some(&h),
                                        3,
                                    )
                                    .await;
                                    let c = done_c.fetch_add(1, Ordering::Relaxed) + 1;
                                    if c.is_multiple_of(10) || c == total {
                                        let _ = app_c.emit(
                                            "mc-progress",
                                            json!({ "instanceId": id_c, "type": "assets", "task": c, "total": total }),
                                        );
                                    }
                                }));
                            }
                            for h in handles {
                                let _ = h.await;
                            }
                        }
                    }
        }

        // Ajouter le client JAR au classpath
        cp_entries.push(client_jar.to_string_lossy().to_string());
        let cp_sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let classpath = cp_entries.join(cp_sep);

        // 6. Construire les arguments JVM + Jeu
        let main_class = custom_json
            .as_ref()
            .and_then(|c| c.get("mainClass").and_then(|v| v.as_str()))
            .or_else(|| base_json.get("mainClass").and_then(|v| v.as_str()))
            .unwrap_or("net.minecraft.client.main.Main");

        let auth_name = opts
            .pointer("/authorization/name")
            .and_then(|v| v.as_str())
            .unwrap_or("Player");
        let auth_uuid = opts
            .pointer("/authorization/uuid")
            .and_then(|v| v.as_str())
            .unwrap_or("00000000000000000000000000000000");
        let auth_token = opts
            .pointer("/authorization/access_token")
            .and_then(|v| v.as_str())
            .unwrap_or("0")
            .to_string();
        let user_type = opts
            .pointer("/authorization/meta/type")
            .and_then(|v| v.as_str())
            .unwrap_or("msa");
        let is_demo = opts
            .pointer("/authorization/meta/demo")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let client_id = opts
            .pointer("/authorization/meta/clientId")
            .or_else(|| opts.pointer("/authorization/client_token"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let xuid = opts
            .pointer("/authorization/meta/xuid")
            .and_then(|v| v.as_str())
            .unwrap_or("0");

        let mut vars: HashMap<&str, String> = HashMap::new();
        vars.insert("${auth_player_name}", auth_name.to_string());
        vars.insert("${version_name}", ver_custom.unwrap_or(ver_number).to_string());
        vars.insert("${game_directory}", game_dir.to_string_lossy().to_string());
        vars.insert("${assets_root}", assets_dir.to_string_lossy().to_string());
        vars.insert("${game_assets}", assets_dir.to_string_lossy().to_string());
        vars.insert("${assets_index_name}", asset_index_id.clone());
        vars.insert("${auth_uuid}", auth_uuid.to_string());
        vars.insert("${auth_access_token}", auth_token.clone());
        vars.insert("${auth_session}", auth_token.clone());
        vars.insert("${auth_xuid}", xuid.to_string());
        vars.insert("${clientid}", client_id.to_string());
        vars.insert("${user_type}", user_type.to_string());
        vars.insert("${user_properties}", "{}".to_string());
        vars.insert("${version_type}", "release".to_string());
        vars.insert("${natives_directory}", natives_dir.to_string_lossy().to_string());
        vars.insert("${launcher_name}", "Gens-Launcher".to_string());
        vars.insert("${launcher_version}", env!("CARGO_PKG_VERSION").to_string());
        vars.insert("${classpath}", classpath.clone());
        vars.insert("${library_directory}", libs_dir.to_string_lossy().to_string());
        vars.insert("${classpath_separator}", cp_sep.to_string());

        let features: HashSet<String> = opts
            .get("features")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let mut args: Vec<String> = Vec::new();
        if let Some(min_m) = opts.pointer("/memory/min").and_then(|v| v.as_str()) {
            args.push(format!("-Xms{}", min_m));
        } else if let Some(min_n) = opts.pointer("/memory/min").and_then(|v| v.as_u64()) {
            args.push(format!("-Xms{}M", min_n));
        }
        if let Some(max_m) = opts.pointer("/memory/max").and_then(|v| v.as_str()) {
            args.push(format!("-Xmx{}", max_m));
        } else if let Some(max_n) = opts.pointer("/memory/max").and_then(|v| v.as_u64()) {
            args.push(format!("-Xmx{}M", max_n));
        } else {
            args.push("-Xmx4G".into());
        }
        for s in fw_extra_jvm {
            args.push(s);
        }
        for s in validated_jvm_args {
            args.push(s);
        }

        // JVM args du JSON (base + custom), sans doublons -D / -XX:
        let mut json_jvm_args: Vec<String> = Vec::new();
        for doc in [Some(&base_json), custom_json.as_ref()].into_iter().flatten() {
            if let Some(jvm_arr) = doc.pointer("/arguments/jvm").and_then(|v| v.as_array()) {
                for item in jvm_arr {
                    for s in extract_arg_strings(item, current_os, current_arch, &features) {
                        if s == "-cp" || s == "${classpath}" {
                            continue;
                        }
                        let replaced = substitute_vars(&s, &vars);
                        if (replaced.starts_with("-D") || replaced.starts_with("-XX:"))
                            && json_jvm_args.contains(&replaced)
                        {
                            continue;
                        }
                        json_jvm_args.push(replaced);
                    }
                }
            }
        }
        if json_jvm_args.is_empty() {
            json_jvm_args.extend([
                "-XX:-UseAdaptiveSizePolicy".to_string(),
                "-XX:-OmitStackTraceInFastThrow".to_string(),
                "-Dfml.ignorePatchDiscrepancies=true".to_string(),
                "-Dfml.ignoreInvalidMinecraftCertificates=true".to_string(),
                format!("-Djava.library.path={}", natives_dir.display()),
                default_os_jvm_arg(current_os).to_string(),
            ]);
        } else {
            if !json_jvm_args
                .iter()
                .any(|a| a.starts_with("-Djava.library.path="))
            {
                json_jvm_args.push(format!("-Djava.library.path={}", natives_dir.display()));
            }
            let parsed_ver = parse_mc_version(ver_number);
            if parsed_ver.0 >= 26
                && !json_jvm_args.iter().any(|a| a.contains("StackShadowPages"))
            {
                json_jvm_args.push("-XX:StackShadowPages=32".to_string());
            }
        }
        args.extend(json_jvm_args);
        args.push("-cp".into());
        args.push(classpath);
        args.push(main_class.to_string());

        // Game args (sans perdre les args de base quand custom_json en ajoute)
        if let Some(legacy) = custom_json
            .as_ref()
            .and_then(|c| c.get("minecraftArguments").and_then(|v| v.as_str()))
            .or_else(|| base_json.get("minecraftArguments").and_then(|v| v.as_str()))
        {
            for tok in legacy.split_whitespace() {
                args.push(substitute_vars(tok, &vars));
            }
        } else {
            for doc in [Some(&base_json), custom_json.as_ref()].into_iter().flatten() {
                if let Some(game_arr) = doc.pointer("/arguments/game").and_then(|v| v.as_array()) {
                    for item in game_arr {
                        for s in extract_arg_strings(item, current_os, current_arch, &features) {
                            args.push(substitute_vars(&s, &vars));
                        }
                    }
                }
            }
        }

        if is_demo && !features.contains("is_demo_user") {
            args.push("--demo".into());
        }

        if opts.pointer("/window/fullscreen").and_then(|v| v.as_bool()) == Some(true) {
            args.push("--fullscreen".into());
        } else if let (Some(w), Some(h)) = (
            opts.pointer("/window/width").and_then(|v| v.as_u64()),
            opts.pointer("/window/height").and_then(|v| v.as_u64()),
        )
            && w > 0 && h > 0 {
                args.push("--width".into());
                args.push(w.to_string());
                args.push("--height".into());
                args.push(h.to_string());
            }

        // QuickPlay (singleplayer / multiplayer / realms / legacy) ou legacy opts.server
        if let Some(qp) = opts.get("quickPlay").filter(|v| v.is_object()) {
            let qp_type = qp.get("type").and_then(|v| v.as_str()).unwrap_or("multiplayer");
            if let Some(id) = qp
                .get("identifier")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                match qp_type {
                    "singleplayer" => {
                        args.push("--quickPlaySingleplayer".into());
                        args.push(id.to_string());
                    }
                    "multiplayer" => {
                        args.push("--quickPlayMultiplayer".into());
                        args.push(id.to_string());
                    }
                    "realms" => {
                        args.push("--quickPlayRealms".into());
                        args.push(id.to_string());
                    }
                    "legacy" => {
                        let mut parts = id.splitn(2, ':');
                        let host = parts.next().unwrap_or(id);
                        let port = parts.next().unwrap_or("25565");
                        args.push("--server".into());
                        args.push(host.to_string());
                        args.push("--port".into());
                        args.push(port.to_string());
                    }
                    _ => {}
                }
                if let Some(qpath) = qp.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    args.push("--quickPlayPath".into());
                    args.push(qpath.to_string());
                }
            }
        } else if let Some(host) = opts
            .pointer("/server/host")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            args.push("--server".into());
            args.push(host.to_string());
            if let Some(port) = opts.pointer("/server/port") {
                let ps = port
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| port.as_u64().map(|n| n.to_string()));
                if let Some(p) = ps.filter(|s| !s.is_empty()) {
                    args.push("--port".into());
                    args.push(p);
                }
            }
        }

        for s in validated_launch_args {
            args.push(s);
        }

        let mut cmd = Command::new(java_exe);
        cmd.args(&args)
            .current_dir(&game_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Échec lancement Java ({}): {}", java_exe, e))?;
        let lock_file = root.join("instance.lock");
        if let Some(pid) = child.id() {
            let _ = fs::write(&lock_file, pid.to_string());
            if let Ok(mut map) = self.running_pids.lock() {
                map.insert(inst_id.to_string(), pid);
            }
        }
        let _ = app.emit("mc-started", json!({ "instanceId": inst_id }));

        let secret_tok = if auth_token.len() > 8 {
            Some(auth_token)
        } else {
            None
        };

        if let Some(stdout) = child.stdout.take() {
            let app_out = app.clone();
            let id_out = inst_id.to_string();
            let tok_out = secret_tok.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let safe_line = redact_secret(&line, tok_out.as_deref());
                    let _ = app_out.emit("mc-data", json!({ "instanceId": id_out, "data": safe_line }));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let app_err = app.clone();
            let id_err = inst_id.to_string();
            let tok_err = secret_tok;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let safe_line = redact_secret(&line, tok_err.as_deref());
                    let _ = app_err.emit("mc-data", json!({ "instanceId": id_err, "data": safe_line }));
                }
            });
        }

        let code = child
            .wait()
            .await
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(-1);
        let _ = fs::remove_file(&lock_file);
        if let Ok(mut map) = self.running_pids.lock() {
            map.remove(inst_id);
        }
        let _ = app.emit("mc-close", json!({ "instanceId": inst_id, "code": code }));
        Ok(())
    }
}

fn redact_secret(line: &str, secret: Option<&str>) -> String {
    if let Some(tok) = secret
        && line.contains(tok) {
            return line.replace(tok, "[REDACTED]");
        }
    line.to_string()
}

pub fn parse_mc_version(version_str: &str) -> (u32, u32, u32) {
    let s = version_str.trim();
    if s.is_empty() {
        return (0, 0, 0);
    }
    // Snapshot format: YYwWWx (e.g. 26w01a, 24w14a)
    let bytes = s.as_bytes();
    if bytes.len() == 6
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && (bytes[2] == b'w' || bytes[2] == b'W')
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_alphabetic()
    {
        let year: u32 = s[0..2].parse().unwrap_or(0);
        if year >= 26 {
            return (year, 0, 0);
        }
        return (1, if year >= 22 { 19 } else { 0 }, 0);
    }

    // Look for "1.X" or "1.X.Y" anywhere (e.g. "fabric-loader-0.15-1.20.4")
    for tok in s.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let parts: Vec<&str> = tok.split('.').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 && parts[0] == "1" {
            let minor = parts[1].parse::<u32>().unwrap_or(0);
            let patch = parts.get(2).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
            return (1, minor, patch);
        }
    }

    // Modern format: "26.1-forge-62.1.0" -> (26, 1, 0)
    for tok in s.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let parts: Vec<&str> = tok.split('.').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            let maj = parts[0].parse::<u32>().unwrap_or(0);
            let min = parts[1].parse::<u32>().unwrap_or(0);
            let pat = parts.get(2).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
            if maj > 0 {
                return (maj, min, pat);
            }
        }
    }

    (0, 0, 0)
}

pub fn is_modern_forge(doc: &Value) -> bool {
    let Some(id) = doc.get("id").and_then(|v| v.as_str()) else {
        return false;
    };
    let low = id.to_lowercase();
    if low.contains("neoforge") {
        return true;
    }
    let inherits = doc
        .get("inheritsFrom")
        .and_then(|v| v.as_str())
        .unwrap_or(id);
    let (maj, min, _) = parse_mc_version(inherits);
    maj >= 26 || (maj == 1 && min >= 13)
}

fn resolve_forged_wrapped(
    root: &Path,
    ver_number: &str,
    forge_jar: &Path,
    libs_dir: &Path,
    client_jar: &Path,
    opts: &Value,
) -> Result<(Value, Vec<String>), String> {
    let fw_version = opts
        .pointer("/overrides/fw/version")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_FW_VERSION);
    let fw_base_url = opts
        .pointer("/overrides/fw/baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_FW_BASE_URL);
    let fw_sha1 = opts
        .pointer("/overrides/fw/sh1")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_FW_SHA1);
    let fw_size = opts
        .pointer("/overrides/fw/size")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_FW_SIZE);

    let make_fw_jvm = || -> Vec<String> {
        vec![
            format!("-Dforgewrapper.librariesDir={}", libs_dir.display()),
            format!("-Dforgewrapper.installer={}", forge_jar.display()),
            format!("-Dforgewrapper.minecraft={}", client_jar.display()),
        ]
    };

    let cached_path = root.join("forge").join(ver_number).join("version.json");
    if cached_path.is_file()
        && let Ok(txt) = fs::read_to_string(&cached_path)
            && let Ok(parsed) = serde_json::from_str::<Value>(&txt)
                && parsed.get("forgeWrapperVersion").and_then(|v| v.as_str()) == Some(fw_version) {
                    let extra = if is_modern_forge(&parsed) {
                        make_fw_jvm()
                    } else {
                        Vec::new()
                    };
                    return Ok((parsed, extra));
                }

    let file = fs::File::open(forge_jar)
        .map_err(|e| format!("Archive Forge illisible ({}): {}", forge_jar.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Archive Forge corrompue: {}", e))?;

    let mut version_txt = String::new();
    if let Ok(mut entry) = archive.by_name("version.json") {
        let _ = entry.read_to_string(&mut version_txt);
    }
    let mut install_txt = String::new();
    if let Ok(mut entry) = archive.by_name("install_profile.json") {
        let _ = entry.read_to_string(&mut install_txt);
    }

    let mut doc: Value = serde_json::from_str(if version_txt.is_empty() { "{}" } else { &version_txt })
        .map_err(|e| format!("version.json Forge invalide: {}", e))?;
    if !install_txt.is_empty()
        && let Ok(inst_doc) = serde_json::from_str::<Value>(&install_txt)
            && let Some(inst_libs) = inst_doc.get("libraries").and_then(|v| v.as_array()) {
                let entry = doc
                    .as_object_mut()
                    .unwrap()
                    .entry("mavenFiles")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(arr) = entry.as_array_mut() {
                    arr.extend(inst_libs.iter().cloned());
                }
            }

    let modern = is_modern_forge(&doc);
    let mut extra_jvm = Vec::new();
    if modern && doc.get("inheritsFrom").and_then(|v| v.as_str()) != Some("1.12.2") {
        extra_jvm = make_fw_jvm();
        let fw_name = format!("ForgeWrapper-{}.jar", fw_version);
        let fw_rel = format!(
            "io/github/zekerzhayard/ForgeWrapper/{}/{}",
            fw_version, fw_name
        );
        let fw_lib = json!({
            "name": format!("io.github.zekerzhayard:ForgeWrapper:{}", fw_version),
            "downloads": {
                "artifact": {
                    "path": fw_rel,
                    "url": format!("{}{}/{}", fw_base_url, fw_version, fw_name),
                    "sha1": fw_sha1,
                    "size": fw_size
                }
            }
        });
        if let Some(obj) = doc.as_object_mut() {
            let libs = obj
                .entry("libraries")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(arr) = libs.as_array_mut() {
                arr.push(fw_lib);
            }
            obj.insert(
                "mainClass".into(),
                Value::String("io.github.zekerzhayard.forgewrapper.installer.Main".into()),
            );
            obj.insert(
                "forgeWrapperVersion".into(),
                Value::String(fw_version.to_string()),
            );
        }
    } else if let Some(obj) = doc.as_object_mut() {
        obj.insert(
            "forgeWrapperVersion".into(),
            Value::String(fw_version.to_string()),
        );
    }

    if let Ok(pretty) = serde_json::to_string_pretty(&doc) {
        let _ = write_atomic(&cached_path, pretty.as_bytes());
    }
    Ok((doc, extra_jvm))
}

fn current_os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

fn current_arch_name() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x86_64"
    }
}

fn default_os_jvm_arg(os_name: &str) -> &'static str {
    match os_name {
        "windows" => "-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump",
        "osx" => "-XstartOnFirstThread",
        _ => "-Xss1M",
    }
}

pub fn match_arch(current_arch: &str, rule_arch: &str) -> bool {
    if rule_arch.is_empty() {
        return false;
    }
    if rule_arch == current_arch {
        return true;
    }
    if current_arch == "arm64" && rule_arch == "aarch64" {
        return true;
    }
    if rule_arch == "^x86$" {
        return current_arch == "x86";
    }
    if rule_arch == "^x86_64$" || rule_arch == "^amd64$" {
        return current_arch == "x86_64";
    }
    if rule_arch == "^arm64$" || rule_arch == "^aarch64$" {
        return current_arch == "arm64";
    }
    false
}

pub fn eval_rules_full(
    rules: Option<&Value>,
    current_os: &str,
    current_arch: &str,
    features: &HashSet<String>,
) -> bool {
    let Some(arr) = rules.and_then(|v| v.as_array()) else {
        return true;
    };
    if arr.is_empty() {
        return true;
    }
    let has_allow = arr
        .iter()
        .any(|r| r.get("action").and_then(|v| v.as_str()) == Some("allow"));
    let mut allowed = !has_allow;
    for r in arr {
        let mut matches = true;
        if let Some(os_obj) = r.get("os").and_then(|v| v.as_object()) {
            if let Some(name) = os_obj.get("name").and_then(|v| v.as_str())
                && name != current_os {
                    matches = false;
                }
            if matches
                && let Some(arch) = os_obj.get("arch").and_then(|v| v.as_str())
                    && !match_arch(current_arch, arch) {
                        matches = false;
                    }
        }
        if matches
            && let Some(feat_obj) = r.get("features").and_then(|v| v.as_object()) {
                for (k, v) in feat_obj {
                    let want = v.as_bool().unwrap_or(false);
                    if want != features.contains(k) {
                        matches = false;
                        break;
                    }
                }
            }
        if matches {
            allowed = r.get("action").and_then(|v| v.as_str()) == Some("allow");
        }
    }
    allowed
}

pub fn should_skip_lib(lib: &Value, current_os: &str, current_arch: &str) -> bool {
    if let Some(name) = lib.get("name").and_then(|v| v.as_str()) {
        let is_arm64 = current_arch == "arm64";
        let is_x86 = current_arch == "x86";
        let is_x64 = current_arch == "x86_64";

        if name.contains("-arm64") && !is_arm64 {
            return true;
        }
        if name.contains("-arm32") {
            return true;
        }
        if (name.ends_with("-x86") || name.contains("-x86:")) && !is_x86 {
            return true;
        }
        if (name.contains("-x86_64") || name.contains("-amd64")) && !is_x64 {
            return true;
        }
        if is_arm64 {
            for bare in [
                ":natives-linux",
                ":natives-windows",
                ":natives-macos",
                ":natives-osx",
            ] {
                if name.ends_with(bare) || name.contains(&format!("{}:", bare)) {
                    return true;
                }
            }
        }
    }
    if let Some(rules) = lib.get("rules") {
        let empty = HashSet::new();
        return !eval_rules_full(Some(rules), current_os, current_arch, &empty);
    }
    false
}

fn is_running_java_pid(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(out) = std::process::Command::new("tasklist")
            .creation_flags(0x08000000)
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
        {
            let txt = String::from_utf8_lossy(&out.stdout).to_lowercase();
            return txt.contains("java.exe") || txt.contains("javaw.exe");
        }
        false
    }
    #[cfg(unix)]
    {
        if let Ok(out) = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
        {
            let txt = String::from_utf8_lossy(&out.stdout).to_lowercase();
            return out.status.success() && txt.contains("java");
        }
        false
    }
}

fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .creation_flags(0x08000000)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

async fn ensure_version_json(
    http: &Client,
    root: &Path,
    version: &str,
    offline: bool,
) -> Result<Value, String> {
    let local = root
        .join("versions")
        .join(version)
        .join(format!("{}.json", version));
    if local.is_file()
        && let Ok(txt) = fs::read_to_string(&local)
            && let Ok(v) = serde_json::from_str::<Value>(&txt) {
                return Ok(v);
            }
    if offline {
        return Err(format!(
            "Métadonnées de version {} introuvables en mode hors-ligne.",
            version
        ));
    }
    let manifest: Value = http
        .get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let entry = manifest
        .get("versions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|e| e.get("id").and_then(|id| id.as_str()) == Some(version))
        })
        .ok_or_else(|| format!("Version {} introuvable dans le manifest Mojang", version))?;

    let ver_url = entry
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("URL de version manquante")?;
    let expected_sha1 = entry.get("sha1").and_then(|s| s.as_str());

    let txt = http
        .get(ver_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(exp) = expected_sha1 {
        let actual = hash_bytes(txt.as_bytes(), "sha1")?;
        if !actual.eq_ignore_ascii_case(exp) {
            return Err(format!("SHA-1 invalide pour le JSON de version {}", version));
        }
    }
    write_atomic(&local, txt.as_bytes())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

fn is_file_valid(path: &Path, expected_sha1: Option<&str>) -> bool {
    if !path.is_file() {
        return false;
    }
    if let Some(exp) = expected_sha1
        && !exp.is_empty() {
            return hash_file(path, "sha1")
                .map(|h| h.eq_ignore_ascii_case(exp))
                .unwrap_or(false);
        }
    true
}

async fn download_verified(
    http: &Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
) -> Result<(), String> {
    let resp = http.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} sur {}", resp.status(), url));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if let Some(exp) = expected_sha1
        && !exp.is_empty() {
            let actual = hash_bytes(&bytes, "sha1")?;
            if !actual.eq_ignore_ascii_case(exp) {
                return Err(format!("SHA-1 invalide pour {}", url));
            }
        }
    write_atomic(dest, &bytes)
}

async fn download_verified_with_retry(
    http: &Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    max_attempts: usize,
) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 0..max_attempts.max(1) {
        match download_verified(http, url, dest, expected_sha1).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                if attempt + 1 < max_attempts {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last_err)
}

fn maven_coord_to_path(coord: &str) -> Option<String> {
    let parts: Vec<&str> = coord.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let suffix = if parts.len() >= 4 {
        format!("-{}", parts[3])
    } else {
        String::new()
    };
    Some(format!(
        "{}/{}/{}/{}-{}{}.jar",
        group, artifact, version, artifact, version, suffix
    ))
}

fn extract_arg_strings(
    item: &Value,
    current_os: &str,
    current_arch: &str,
    features: &HashSet<String>,
) -> Vec<String> {
    if let Some(s) = item.as_str() {
        return vec![s.to_string()];
    }
    if let Some(obj) = item.as_object() {
        if !eval_rules_full(obj.get("rules"), current_os, current_arch, features) {
            return Vec::new();
        }
        if let Some(val) = obj.get("value") {
            if let Some(s) = val.as_str() {
                return vec![s.to_string()];
            }
            if let Some(arr) = val.as_array() {
                return arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
    }
    Vec::new()
}

fn substitute_vars(input: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = input.to_string();
    for (k, v) in vars {
        if out.contains(k) {
            out = out.replace(k, v);
        }
    }
    out
}

fn extract_natives_jar(jar_path: &Path, natives_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(jar_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        if entry.is_dir() || name.starts_with("META-INF/") {
            continue;
        }
        let low = name.to_lowercase();
        if (low.ends_with(".dll") || low.ends_with(".so") || low.ends_with(".dylib"))
            && let Some(fname) = Path::new(&name).file_name() {
                let dst = natives_dir.join(fname);
                if let Ok(mut out) = fs::File::create(&dst) {
                    let _ = std::io::copy(&mut entry, &mut out);
                }
            }
    }
    Ok(())
}

// --- Java Management ---

pub fn check_java(java_path: &str) -> Value {
    let exe = if java_path.trim().is_empty() {
        "java"
    } else {
        java_path
    };
    if let Err(msg) = validate_java_executable(exe) {
        return json!({ "err": { "message": msg, "code": "EACCES" }, "stdout": "", "stderr": "" });
    }
    let mut cmd = std::process::Command::new(exe);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.arg("-version").output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            if out.status.success() {
                json!({ "err": null, "stdout": stdout, "stderr": stderr })
            } else {
                json!({ "err": { "message": "Java exit non-zero", "code": out.status.code() }, "stdout": stdout, "stderr": stderr })
            }
        }
        Err(e) => {
            json!({ "err": { "message": e.to_string(), "code": "ENOENT" }, "stdout": "", "stderr": "" })
        }
    }
}

const JAVA_SCAN_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

type JavaScanCache = Mutex<Option<(Vec<String>, Instant)>>;

fn java_scan_cache() -> &'static JavaScanCache {
    static CACHE: std::sync::OnceLock<JavaScanCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn invalidate_java_scan_cache() {
    if let Ok(mut guard) = java_scan_cache().lock() {
        *guard = None;
    }
}

#[allow(dead_code)]
pub fn scan_java_versions() -> Value {
    scan_java_versions_with_opts(&Value::Null)
}

pub fn scan_java_versions_with_opts(opts: &Value) -> Value {
    let force_refresh = opts
        .get("forceRefresh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !force_refresh
        && let Ok(guard) = java_scan_cache().lock()
            && let Some((ref paths, ts)) = *guard
                && ts.elapsed() < JAVA_SCAN_CACHE_TTL {
                    return json!({ "success": true, "paths": paths });
                }

    let mut found: Vec<String> = Vec::new();
    let bin_name = if cfg!(target_os = "windows") {
        "javaw.exe"
    } else {
        "java"
    };

    let managed = safe_data_dir().join("java");
    scan_dir_for_java(&managed, bin_name, &mut found, 4);

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pfx86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let mut bases = vec![
            PathBuf::from(&pf).join("Java"),
            PathBuf::from(&pfx86).join("Java"),
            PathBuf::from(&pf).join("Eclipse Adoptium"),
            PathBuf::from(&pf).join("Microsoft"),
            PathBuf::from(&pf).join("BellSoft"),
            PathBuf::from(&pf).join("Zulu"),
            PathBuf::from(&pf).join("Amazon Corretto"),
            PathBuf::from(&pf).join("Semeru"),
            crate::sandbox::app_data_root()
                .join(".minecraft")
                .join("runtime"),
        ];
        if let Ok(local_ad) = std::env::var("LOCALAPPDATA")
            && !local_ad.is_empty() {
                bases.push(
                    PathBuf::from(local_ad)
                        .join("Programs")
                        .join("Eclipse Adoptium"),
                );
            }
        for base in bases {
            scan_dir_for_java(&base, bin_name, &mut found, 4);
        }
    }
    #[cfg(target_os = "macos")]
    {
        scan_dir_for_java(
            &PathBuf::from("/Library/Java/JavaVirtualMachines"),
            bin_name,
            &mut found,
            4,
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut bases = vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/usr/lib64/jvm"),
            PathBuf::from("/usr/java"),
            PathBuf::from("/opt/jdk"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            let h = PathBuf::from(home);
            bases.push(h.join(".sdkman").join("candidates").join("java"));
            bases.push(h.join(".jdks"));
        }
        for base in bases {
            scan_dir_for_java(&base, bin_name, &mut found, 4);
        }
    }

    found.sort();
    found.dedup();
    if let Ok(mut guard) = java_scan_cache().lock() {
        *guard = Some((found.clone(), Instant::now()));
    }
    json!({ "success": true, "paths": found })
}

fn scan_dir_for_java(dir: &PathBuf, bin_name: &str, out: &mut Vec<String>, depth: usize) {
    if depth == 0 || !dir.exists() {
        return;
    }
    let candidate = dir.join("bin").join(bin_name);
    if candidate.is_file() {
        out.push(candidate.to_string_lossy().to_string());
    }
    let is_ms_root = dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.eq_ignore_ascii_case("Microsoft"))
        .unwrap_or(false);
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if is_ms_root {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if !(n.contains("jdk") || n.contains("jre") || n.contains("java") || n.contains("openjdk")) {
                    continue;
                }
            }
            if let Ok(meta) = fs::symlink_metadata(&p)
                && !meta.file_type().is_symlink() && meta.is_dir() {
                    scan_dir_for_java(&p, bin_name, out, depth - 1);
                }
        }
    }
}

pub async fn install_adoptium_java(
    app: &AppHandle,
    http: &Client,
    payload: &Value,
) -> Result<Value, String> {
    let version = payload.get("version").and_then(|v| v.as_u64()).unwrap_or(21);
    let img_type = payload
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("jre");
    let progress_id = payload
        .get("progressId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    };
    let api_url = format!(
        "https://api.adoptium.net/v3/assets/latest/{}/hotspot?architecture={}&image_type={}&os={}&vendor=eclipse",
        version, arch, img_type, os
    );

    let assets: Value = http
        .get(&api_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let pkg = assets
        .pointer("/0/binary/package")
        .ok_or("Package Adoptium introuvable")?;
    let link = pkg
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or("Lien Adoptium manquant")?;
    let sha256 = pkg
        .get("checksum")
        .and_then(|v| v.as_str())
        .ok_or("SHA-256 Adoptium manquant")?;

    let java_dir = safe_data_dir().join("java");
    fs::create_dir_all(&java_dir).map_err(|e| e.to_string())?;
    let ext = if cfg!(target_os = "windows") {
        "zip"
    } else {
        "tar.gz"
    };
    let archive_path = java_dir.join(format!("{}{}.{}", img_type, version, ext));
    let tmp_path = archive_path.with_extension(format!("tmp.{}", std::process::id()));

    // Stream directly to disk with incremental SHA-256 & real progress events
    let resp = http.get(link).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(json!({ "success": false, "error": format!("HTTP {}", resp.status()) }));
    }
    let total_bytes = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            e.to_string()
        })?;
        file.write_all(&chunk).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            e.to_string()
        })?;
        hasher.update(&chunk);
        received = received.saturating_add(chunk.len() as u64);
        if !progress_id.is_empty() && last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let pct = if total_bytes > 0 {
                ((received as f64 / total_bytes as f64) * 90.0).min(90.0) as u64
            } else {
                0
            };
            let _ = app.emit(
                "download-progress",
                json!({
                    "progressId": progress_id,
                    "receivedBytes": received,
                    "totalBytes": total_bytes,
                    "percent": pct
                }),
            );
        }
    }
    drop(file);

    let actual = crate::encoding::hex_encode(&hasher.finalize());
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&tmp_path);
        return Ok(json!({ "success": false, "error": "Empreinte SHA-256 Adoptium invalide !" }));
    }
    crate::sandbox::rename_with_retry(&tmp_path, &archive_path)?;

    let extract_dir = java_dir.join(format!("{}{}", img_type, version));
    let _ = fs::remove_dir_all(&extract_dir);
    if cfg!(target_os = "windows") {
        extract_zip_privileged(
            &archive_path.to_string_lossy(),
            &extract_dir.to_string_lossy(),
        )?;
    } else {
        extract_tar_privileged(
            &archive_path.to_string_lossy(),
            &extract_dir.to_string_lossy(),
        )?;
    }
    let _ = fs::remove_file(&archive_path);
    invalidate_java_scan_cache();

    let mut found = Vec::new();
    let bin_name = if cfg!(target_os = "windows") {
        "javaw.exe"
    } else {
        "java"
    };
    scan_dir_for_java(&extract_dir, bin_name, &mut found, 5);
    if !progress_id.is_empty() {
        let _ = app.emit(
            "download-progress",
            json!({
                "progressId": progress_id,
                "receivedBytes": received,
                "totalBytes": total_bytes,
                "percent": 100
            }),
        );
    }
    let java_path = found.into_iter().next().unwrap_or_default();
    Ok(json!({ "success": !java_path.is_empty(), "javaPath": java_path }))
}

pub fn delete_java(payload: &Value) -> Value {
    let ver = payload
        .as_u64()
        .or_else(|| payload.get("version").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    if !(8..=30).contains(&ver) {
        return json!({ "success": false, "error": "Version Java invalide" });
    }
    let java_dir = safe_data_dir().join("java");
    let _ = fs::remove_dir_all(java_dir.join(format!("jre{}", ver)));
    let _ = fs::remove_dir_all(java_dir.join(format!("jdk{}", ver)));
    invalidate_java_scan_cache();
    json!({ "success": true })
}

pub async fn run_forge_installer(
    java_path: &str,
    installer_path: &str,
    root_path: &str,
) -> Result<Value, String> {
    validate_java_executable(java_path)?;
    let safe_root = assert_renderer_write_sandbox(root_path, AccessMode::Write)?;
    let safe_installer = assert_read_sandbox_opts(installer_path, true, false)?;
    let profiles = safe_root.join("launcher_profiles.json");
    if !profiles.exists() {
        let _ = fs::write(&profiles, "{\"profiles\":{}}");
    }
    let mut cmd = Command::new(java_path);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .args([
            "-jar",
            &safe_installer.to_string_lossy(),
            "--installClient",
            &safe_root.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(json!({ "success": true, "stdout": stdout }))
    } else {
        Ok(json!({
            "err": format!("Forge installer exit {:?}", out.status.code()),
            "stdout": stdout,
            "stderr": stderr
        }))
    }
}
