#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod crypto;
mod discord;
mod encoding;
mod fs_ops;
mod game;
mod game_validation;
mod horizon;
mod nbt;
mod network;
mod ping;
mod sandbox;
mod system;
mod updater;

use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    http: Client,
    discord: discord::DiscordRpc,
    game: Arc<game::GameManager>,
    updater: Arc<updater::UpdateManager>,
    cancel_ms_auth: Arc<AtomicBool>,
    offline_mode: Arc<AtomicBool>,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = (bytes[i + 1] as char).to_digit(16);
            let h2 = (bytes[i + 2] as char).to_digit(16);
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push(((a << 4) | b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn parse_auto_launch_arg(argv: &[String]) -> Option<String> {
    const PREFIX: &str = "--auto-launch=";
    for arg in argv {
        if let Some(rest) = arg.strip_prefix(PREFIX) {
            let trimmed = rest.trim_matches(|c| c == '"' || c == '\'').trim();
            if !trimmed.is_empty() {
                return Some(percent_decode(trimmed));
            }
        }
    }
    None
}

#[tauri::command]
async fn ipc_invoke(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
    args: Value,
) -> Result<Value, String> {
    if channel.starts_with("fs:") {
        let ch = channel.clone();
        return tokio::task::spawn_blocking(move || fs_ops::handle_fs(&ch, &args))
            .await
            .map_err(|e| e.to_string());
    }

    let first = args
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);

    match channel.as_str() {
        "ping-server" => {
            let ip = first.as_str().unwrap_or("");
            match ping::ping_server(ip).await {
                Ok(v) => Ok(v),
                Err(e) => Ok(json!({ "success": true, "data": { "online": false, "error": e } })),
            }
        }
        "encrypt-string" => {
            let txt = first.as_str().unwrap_or("").to_string();
            tokio::task::spawn_blocking(move || crypto::encrypt_string(&txt).map(|s| json!(s)))
                .await
                .map_err(|e| e.to_string())?
        }
        "decrypt-string" => {
            let txt = first.as_str().unwrap_or("").to_string();
            tokio::task::spawn_blocking(move || match crypto::decrypt_string(&txt) {
                Ok(plain) => Ok(json!(plain)),
                Err(_) => Ok(Value::Null),
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "hash-file" => {
            let path = first
                .get("filePath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let algo = first
                .get("algo")
                .and_then(|v| v.as_str())
                .unwrap_or("sha256")
                .to_string();
            tokio::task::spawn_blocking(move || {
                let safe = sandbox::assert_read_sandbox_opts(&path, true, false)?;
                match crypto::hash_file(&safe, &algo) {
                    Ok(h) => Ok(json!({ "success": true, "hash": h })),
                    Err(e) => Ok(json!({ "success": false, "error": e })),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "hash-buffer" => {
            const MAX_HASH_BUFFER_BYTES: usize = 32 * 1024 * 1024;
            let algo = first
                .get("algo")
                .and_then(|v| v.as_str())
                .unwrap_or("sha256");
            let bytes: Vec<u8> = if let Some(b64) = first.get("bufferB64").and_then(|v| v.as_str()) {
                if b64.len() > (MAX_HASH_BUFFER_BYTES / 3 + 2) * 4 {
                    return Ok(json!({ "success": false, "error": "Buffer trop volumineux (> 32 Mo). Utilisez hash-file." }));
                }
                encoding::base64_decode(b64)?
            } else if let Some(arr) = first.get("buffer").and_then(|v| v.as_array()) {
                if arr.len() > MAX_HASH_BUFFER_BYTES {
                    return Ok(json!({ "success": false, "error": "Buffer trop volumineux (> 32 Mo). Utilisez hash-file." }));
                }
                arr.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as u8))
                    .collect()
            } else {
                Vec::new()
            };
            if bytes.len() > MAX_HASH_BUFFER_BYTES {
                return Ok(json!({ "success": false, "error": "Buffer trop volumineux (> 32 Mo). Utilisez hash-file." }));
            }
            match crypto::hash_bytes(&bytes, algo) {
                Ok(h) => Ok(json!({ "success": true, "hash": h })),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            }
        }
        "nbt:parse" => {
            const MAX_NBT_INPUT_BYTES: usize = 5 * 1024 * 1024;
            let bytes: Vec<u8> = if let Some(b64) = first.as_str() {
                if b64.len() > (MAX_NBT_INPUT_BYTES / 3 + 2) * 4 {
                    return Ok(json!({ "success": false, "error": "Fichier NBT trop volumineux (> 5 Mo)." }));
                }
                encoding::base64_decode(b64)?
            } else if let Some(arr) = first.as_array() {
                if arr.len() > MAX_NBT_INPUT_BYTES {
                    return Ok(json!({ "success": false, "error": "Fichier NBT trop volumineux (> 5 Mo)." }));
                }
                arr.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as u8))
                    .collect()
            } else {
                Vec::new()
            };
            if bytes.len() > MAX_NBT_INPUT_BYTES {
                return Ok(json!({ "success": false, "error": "Fichier NBT trop volumineux (> 5 Mo)." }));
            }
            match nbt::parse_nbt(&bytes) {
                Ok(data) => Ok(json!({ "success": true, "data": data })),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            }
        }
        "reconnect-discord" => match state.discord.connect() {
            Ok(()) => Ok(json!({ "success": true })),
            Err(e) => Ok(json!({ "success": false, "error": e })),
        },
        "download-file-stream" => network::download_file_stream(&app, &state.http, &first).await,
        "search-modrinth" => {
            let url = first.as_str().unwrap_or("");
            network::search_modrinth(&state.http, url).await
        }
        "fetch-curseforge" => network::fetch_curseforge(&state.http, &first).await,
        "fetch-mojang-raw-skin" => network::fetch_mojang_raw_skin(&state.http, &first).await,
        "fetch-mojang-profile" => network::fetch_mojang_profile(&state.http, &first).await,
        "upload-mojang-skin" => network::upload_mojang_skin(&state.http, &first).await,
        "login-microsoft" => {
            network::login_microsoft(&app, &state.http, &state.cancel_ms_auth).await
        }
        "refresh-microsoft" => {
            network::refresh_microsoft(&state.http, first.as_str().unwrap_or("")).await
        }
        "delete-msa-cache" => Ok(network::delete_msa_cache(first.as_str().unwrap_or(""))),
        "check-internet" => {
            if state.offline_mode.load(Ordering::SeqCst) {
                Ok(json!(false))
            } else {
                Ok(network::check_internet(&state.http).await)
            }
        }
        "check-for-updates" => Ok(state.updater.check_for_updates(&app, &state.http, true).await),
        "extract-tar" => {
            let ap = first
                .get("archivePath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dd = first
                .get("destDir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            tokio::task::spawn_blocking(move || archive::extract_tar(&ap, &dd))
                .await
                .map_err(|e| e.to_string())?
        }
        "java:install-adoptium" => game::install_adoptium_java(&app, &state.http, &first).await,
        "java:delete" => Ok(game::delete_java(&first)),
        "install-horizon" => horizon::install_horizon(&app, &state.http).await,
        "system:export-diagnostic" => {
            let app_c = app.clone();
            let opts = first.clone();
            tokio::task::spawn_blocking(move || system::export_diagnostic(&app_c, &opts))
                .await
                .map_err(|e| e.to_string())?
        }
        "extract-zip" => {
            let zip_path = first
                .get("zipPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dest_dir = first
                .get("destDir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let app_c = app.clone();
            tokio::task::spawn_blocking(move || {
                archive::extract_zip_with_progress(Some(&app_c), &zip_path, &dest_dir)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "read-zip-text" => {
            let zip_path = first
                .get("zipPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let names: Vec<String> = first
                .get("entryNames")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            tokio::task::spawn_blocking(move || archive::read_zip_text(&zip_path, &names))
                .await
                .map_err(|e| e.to_string())?
        }
        "read-zip-text-batch" => {
            let items = first
                .get("items")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let names: Vec<String> = first
                .get("entryNames")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            tokio::task::spawn_blocking(move || archive::read_zip_text_batch(&items, &names))
                .await
                .map_err(|e| e.to_string())
        }
        "compress-folder" => {
            let src = first
                .get("src")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dest = first
                .get("dest")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let excl: Vec<String> = first
                .get("exclude")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let app_c = app.clone();
            tokio::task::spawn_blocking(move || {
                archive::compress_folder(Some(&app_c), &src, &dest, &excl)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "check-java" => {
            let jp = first.as_str().unwrap_or("").to_string();
            tokio::task::spawn_blocking(move || game::check_java(&jp))
                .await
                .map_err(|e| e.to_string())
        }
        "scan-java-versions" => {
            let opts = first.clone();
            tokio::task::spawn_blocking(move || game::scan_java_versions_with_opts(&opts))
                .await
                .map_err(|e| e.to_string())
        }
        "run-forge-installer" => {
            let jp = first
                .get("javaPath")
                .and_then(|v| v.as_str())
                .unwrap_or("java");
            let ip = first
                .get("installerPath")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rp = first.get("rootPath").and_then(|v| v.as_str()).unwrap_or("");
            game::run_forge_installer(jp, ip, rp).await
        }
        "get-still-running" => Ok(json!(state.game.still_running())),
        "force-stop-game" => Ok(state.game.force_stop(first.as_str().unwrap_or(""))),
        "get-horizon-settings" => Ok(horizon::get_horizon_settings()),
        "save-horizon-settings" => horizon::save_horizon_settings(&first),
        "check-horizon-status" => {
            let offline = state.offline_mode.load(Ordering::SeqCst);
            Ok(horizon::check_horizon_status_online(&state.http, offline).await)
        }
        "call-horizon" => {
            let args_vec: Vec<String> = if let Some(arr) = first.as_array() {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            } else if let Some(s) = first.as_str() {
                vec![s.to_string()]
            } else {
                vec!["--status".into()]
            };
            horizon::run_horizon_args(&app, &state.http, &args_vec, None, false).await
        }
        "horizon:set-e2e-key" => {
            let key = first
                .get("passphrase")
                .or_else(|| first.get("key"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            horizon::run_horizon_args(&app, &state.http, &["--set-e2e-key".into()], Some(key), true)
                .await
        }
        "horizon:get-e2e-key" => {
            horizon::run_horizon_args(&app, &state.http, &["--get-e2e-key".into()], None, true)
                .await
        }
        "horizon:disconnect" => {
            horizon::run_horizon_args(&app, &state.http, &["--logout".into()], None, true).await
        }
        "system:get-mem-info" => {
            let (total, free) = system::get_mem_info();
            Ok(json!({ "totalmem": total, "freemem": free }))
        }
        "system:open-external" => {
            let app_c = app.clone();
            let url = first.as_str().unwrap_or("").to_string();
            tokio::task::spawn_blocking(move || system::open_external(&app_c, &url))
                .await
                .map_err(|e| e.to_string())?
        }
        "system:open-path" => system::open_path(&app, first.as_str().unwrap_or("")),
        "system:show-item-in-folder" => {
            system::show_item_in_folder(&app, first.as_str().unwrap_or(""))
        }
        "system:clipboard-write-text" => {
            Ok(system::write_clipboard(&app, first.as_str().unwrap_or("")))
        }
        "get-folder-size" => {
            let p = first.as_str().unwrap_or("").to_string();
            tokio::task::spawn_blocking(move || system::get_folder_size_cmd(&p))
                .await
                .map_err(|e| e.to_string())?
        }
        "duplicate-instance-folder" => {
            let src = first
                .get("srcPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dst = first
                .get("destPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            tokio::task::spawn_blocking(move || system::duplicate_instance_folder(&src, &dst))
                .await
                .map_err(|e| e.to_string())?
        }
        "copy-image-to-sandbox" | "copy-file-to-sandbox" => {
            let is_image = channel == "copy-image-to-sandbox";
            let dest_name = first
                .get("destName")
                .and_then(|v| v.as_str())
                .unwrap_or("file");
            let sub_dir = first
                .get("subDir")
                .and_then(|v| v.as_str())
                .unwrap_or("imports");
            if let Some(b64) = first.get("bytesB64").and_then(|v| v.as_str()) {
                network::save_uploaded_bytes(b64, dest_name, sub_dir, is_image)
            } else {
                let src = first.get("srcPath").and_then(|v| v.as_str()).unwrap_or("");
                network::save_temp_copy(src, dest_name, sub_dir, is_image)
            }
        }
        "check-shortcut-exists" => {
            let sn = first.get("safeName").and_then(|v| v.as_str()).unwrap_or("");
            Ok(system::check_shortcut_exists(sn))
        }
        "create-desktop-shortcut" => {
            let name = first
                .get("instanceName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(system::create_desktop_shortcut(name))
        }
        "delete-desktop-shortcut" => {
            let name = first
                .get("instanceName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(system::delete_desktop_shortcut(name))
        }
        "do-deb-update" => state.updater.do_deb_update(&app, &state.http).await,
        _ => Ok(json!({ "success": false, "error": format!("Canal non implémenté: {}", channel) })),
    }
}

#[tauri::command]
async fn ipc_send(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
    data: Value,
) -> Result<(), String> {
    match channel.as_str() {
        "update-discord" => {
            let details = data
                .get("details")
                .and_then(|v| v.as_str())
                .unwrap_or("Dans les menus");
            let st = data
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("Gens Launcher");
            let _ = state.discord.set_activity(details, st);
        }
        "cancel-login-microsoft" => {
            state.cancel_ms_auth.store(true, Ordering::SeqCst);
        }
        "launch-game" => {
            let game = Arc::clone(&state.game);
            let http = state.http.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                game.launch_game(app_clone, http, data).await;
            });
        }
        "hide-window" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "minimize-window" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
        }
        "show-window" | "restore-main-window" | "overlay-ready" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "set-offline-mode" => {
            state
                .offline_mode
                .store(data.as_bool().unwrap_or(false), Ordering::SeqCst);
        }
        "set-auto-download" => {
            state
                .updater
                .set_auto_download(data.as_bool().unwrap_or(false));
        }
        "download-update" => {
            let upd = Arc::clone(&state.updater);
            let http = state.http.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                upd.download_update(&app_clone, &http).await;
            });
        }
        "confirm-update" => {
            state.updater.confirm_update();
        }
        "set-taskbar-progress" => {
            if let Some(w) = app.get_webview_window("main") {
                use tauri::window::{ProgressBarState, ProgressBarStatus};
                let pct = data.as_f64().unwrap_or(-1.0);
                let pb = if pct < 0.0 {
                    ProgressBarState {
                        status: Some(ProgressBarStatus::None),
                        progress: None,
                    }
                } else {
                    let norm = if pct <= 1.0 { (pct * 100.0).round() as u64 } else { pct.round() as u64 };
                    ProgressBarState {
                        status: Some(ProgressBarStatus::Normal),
                        progress: Some(norm.min(100)),
                    }
                };
                let _ = w.set_progress_bar(pb);
            }
        }
        "update-jump-list" => {
            tokio::task::spawn_blocking(move || {
                system::update_jump_list(&data);
            });
        }
        "restart_app" => state.updater.restart_and_install(&app),
        "relaunch-app" => app.restart(),
        "quit-app" => app.exit(0),
        _ => {}
    }
    Ok(())
}

fn build_boot_script(is_auto_launch: bool) -> String {
    let app_data = sandbox::app_data_root().to_string_lossy().to_string();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into());
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".into());
    let temp = std::env::temp_dir().to_string_lossy().to_string();
    let (totalmem, freemem) = system::get_mem_info();
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };

    let boot = json!({
        "appData": app_data,
        "platform": platform,
        "arch": arch,
        "version": env!("CARGO_PKG_VERSION"),
        "homedir": home,
        "username": user,
        "hostname": host,
        "tempdir": temp,
        "totalmem": totalmem,
        "freemem": freemem,
        "isAutoLaunch": is_auto_launch,
        "isAppImage": std::env::var("APPIMAGE").is_ok()
    });
    format!("window.__GENS_BOOT__ = {};", boot)
}

fn setup_system_tray(app: &tauri::App) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    // Localized tray labels based on saved settings.json language
    let is_en = std::fs::read_to_string(sandbox::safe_data_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("language").and_then(|l| l.as_str()).map(|s| s.to_lowercase()))
        .map(|l| l.starts_with("en"))
        .unwrap_or(false);

    let show_lbl = if is_en { "Show Gens Launcher" } else { "Afficher Gens Launcher" };
    let quit_lbl = if is_en { "Quit" } else { "Quitter" };

    let Ok(show_item) = MenuItemBuilder::with_id("tray_show", show_lbl).build(app) else {
        return;
    };
    let Ok(quit_item) = MenuItemBuilder::with_id("tray_quit", quit_lbl).build(app) else {
        return;
    };
    let Ok(menu) = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
    else {
        return;
    };

    let mut builder = TrayIconBuilder::new()
        .tooltip("Gens Launcher")
        .menu(&menu)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "tray_show" => {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "tray_quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    if let Err(e) = builder.build(app) {
        system::main_log(&format!("[Tray] Impossible d'initialiser le Tray : {}", e));
    }
}

fn main() {
    system::init_main_log();
    system::main_log("Gens Launcher (Rust + Tauri v2) démarré.");
    let cli_args: Vec<String> = std::env::args().collect();
    let initial_auto_launch = parse_auto_launch_arg(&cli_args);
    let boot_script = build_boot_script(initial_auto_launch.is_some());
    let state = AppState {
        http: network::build_http_client(),
        discord: discord::DiscordRpc::new(),
        game: Arc::new(game::GameManager::new()),
        updater: Arc::new(updater::UpdateManager::new()),
        cancel_ms_auth: Arc::new(AtomicBool::new(false)),
        offline_mode: Arc::new(AtomicBool::new(false)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(inst) = parse_auto_launch_arg(&argv) {
                let _ = app.emit("trigger-auto-launch", inst);
            }
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(move |app| {
            setup_system_tray(app);
            let is_auto = initial_auto_launch.is_some();
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Gens Launcher")
            .inner_size(if is_auto { 420.0 } else { 1200.0 }, if is_auto { 360.0 } else { 740.0 })
            .min_inner_size(if is_auto { 420.0 } else { 960.0 }, if is_auto { 360.0 } else { 620.0 })
            .resizable(!is_auto)
            .decorations(!is_auto)
            .center()
            .initialization_script(&boot_script)
            .build()?;

            if let Some(inst_name) = initial_auto_launch {
                let handle = app.handle().clone();
                let _ = win.show();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    let _ = handle.emit("trigger-auto-launch", inst_name);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Erreur démarrage Gens Launcher (Tauri)");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_sandbox<F: FnOnce(&std::path::Path)>(f: F) {
        let _guard = TEST_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!(
            "gens_launcher_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        sandbox::set_test_data_dir(Some(tmp.clone()));
        f(&tmp);
        sandbox::set_test_data_dir(None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_hex_and_base64_roundtrip() {
        let data = b"Gens Launcher Rust 2026!";
        assert_eq!(encoding::hex_decode(&encoding::hex_encode(data)).unwrap(), data);
        assert_eq!(encoding::base64_decode(&encoding::base64_encode(data)).unwrap(), data);
    }

    #[test]
    fn test_ssrf_blocks_private_ips() {
        assert!(ping::is_private_or_reserved_ip("127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(ping::is_private_or_reserved_ip("10.0.0.5".parse::<IpAddr>().unwrap()));
        assert!(ping::is_private_or_reserved_ip("192.168.1.1".parse::<IpAddr>().unwrap()));
        assert!(ping::is_private_or_reserved_ip("169.254.169.254".parse::<IpAddr>().unwrap()));
        assert!(!ping::is_private_or_reserved_ip("8.8.8.8".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn test_sandbox_rejects_escape_unc_and_renderer_secrets() {
        with_temp_sandbox(|root| {
            let inside = root.join("instances").join("test");
            assert!(sandbox::assert_write_sandbox(&inside.to_string_lossy()).is_ok());

            let escape = root.join("..").join("evil.txt");
            assert!(sandbox::assert_write_sandbox(&escape.to_string_lossy()).is_err());

            assert!(sandbox::assert_write_sandbox(r"\\evil-server\share\file.txt").is_err());
            assert!(sandbox::assert_write_sandbox(r"/\evil-server/share/file.txt").is_err());

            // Renderer denylist: secrets & java/ writes blocked
            let secret = root.join(".secret_key");
            assert!(sandbox::assert_renderer_path_allowed(&secret, sandbox::AccessMode::Read).is_err());
            let msa = root.join("msa-cache").join("gens-1.json");
            assert!(sandbox::assert_renderer_path_allowed(&msa, sandbox::AccessMode::Read).is_err());
            let java_write = root.join("java").join("jre21").join("evil.dll");
            assert!(sandbox::assert_renderer_path_allowed(&java_write, sandbox::AccessMode::Write).is_err());
            assert!(sandbox::assert_renderer_path_allowed(root, sandbox::AccessMode::Delete).is_err());
        });
    }

    #[test]
    fn test_game_validation_blocks_dangerous_jvm_and_overrides() {
        with_temp_sandbox(|root| {
            assert!(game_validation::validate_custom_jvm_args(Some(&json!(["-XX:+UseG1GC"]))).is_ok());
            assert!(game_validation::validate_custom_jvm_args(Some(&json!(["-javaagent:evil.jar"]))).is_err());
            assert!(game_validation::validate_custom_jvm_args(Some(&json!(["-jar"]))).is_err());
            assert!(game_validation::validate_custom_jvm_args(Some(&json!(["--module-path=/tmp"]))).is_err());
            assert!(game_validation::validate_custom_jvm_args(Some(&json!(["@argfile.txt"]))).is_err());
            assert!(game_validation::validate_custom_launch_args(Some(&json!(["--accessToken=stolen"]))).is_err());
            assert!(game_validation::validate_safe_segment("../1.20", "version").is_err());
            assert!(game_validation::validate_safe_segment("1.21.4", "version").is_ok());

            // Out-of-sandbox override rejected
            let bad_opts = json!({ "overrides": { "gameDirectory": root.join("..").join("outside").to_string_lossy() } });
            assert!(game_validation::validate_launch_overrides(&bad_opts).is_err());

            // Non-HTTPS override URL rejected
            let bad_url = json!({ "overrides": { "url": { "meta": "http://piston-meta.mojang.com/x" } } });
            assert!(game_validation::validate_launch_overrides(&bad_url).is_err());

            // Executable open_path blocked
            assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\evil.exe")));
            assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\run.bat")));
            assert!(!system::is_blocked_executable_path(std::path::Path::new("C:\\test\\latest.log")));
        });
    }

    #[test]
    fn test_crypto_roundtrip() {
        with_temp_sandbox(|_| {
            let enc = crypto::encrypt_string("{\"list\":[]}").unwrap();
            let dec = crypto::decrypt_string(&enc).unwrap();
            assert_eq!(dec, "{\"list\":[]}");
            assert_eq!(crypto::hash_bytes(b"abc", "md5").unwrap(), "900150983cd24fb0d6963f7d28e17f72");
            assert_eq!(crypto::hash_bytes(b"abc", "sha1").unwrap(), "a9993e364706816aba3e25717850c26c9cd0d89d");
            assert_eq!(crypto::hash_bytes(b"abc", "sha256").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        });
    }

    #[test]
    fn test_motd_single_line_css_classes() {
        let comp = json!({ "text": "§aHypixel\n§c[1.8]" });
        let html = ping::parse_motd_html(&comp);
        assert!(html.contains("mc-c-green"));
        assert!(html.contains("mc-c-red"));
        assert!(!html.contains("<br>"));
        assert!(!html.contains("style="));
    }

    #[test]
    fn test_horizon_and_java_schemas() {
        with_temp_sandbox(|_| {
            let h = horizon::check_horizon_status();
            assert!(h.get("installed").is_some());
            assert!(h.get("localVersion").is_some());
            assert!(h.get("linked").is_some());
            assert!(h.get("provider").is_some());

            let j = game::scan_java_versions();
            assert_eq!(j.get("success").and_then(|v| v.as_bool()), Some(true));
            assert!(j.get("paths").and_then(|v| v.as_array()).is_some());
        });
    }

    #[test]
    fn test_fs_ops_and_zip_roundtrip() {
        with_temp_sandbox(|root| {
            let sub = root.join("_rust_test_tmp");
            let file_p = sub.join("hello.txt");
            let w = fs_ops::handle_fs("fs:writeFile", &json!([file_p.to_string_lossy(), "bonjour", "utf8"]));
            assert_eq!(w.get("ok").and_then(|v| v.as_bool()), Some(true));

            let r = fs_ops::handle_fs("fs:readFile", &json!([file_p.to_string_lossy(), "utf8"]));
            assert_eq!(r.get("data").and_then(|v| v.as_str()), Some("bonjour"));

            let zip_p = root.join("_rust_test_tmp.zip");
            let c = archive::compress_folder(None, &sub.to_string_lossy(), &zip_p.to_string_lossy(), &[]).unwrap();
            assert_eq!(c.get("success").and_then(|v| v.as_bool()), Some(true));

            // Compressing the root GensLauncher folder itself must be rejected
            assert!(archive::compress_folder(None, &root.to_string_lossy(), &zip_p.to_string_lossy(), &[]).is_err());

            let rz = archive::read_zip_text(&zip_p.to_string_lossy(), &["hello.txt".into()]).unwrap();
            assert_eq!(rz.get("text").and_then(|v| v.as_str()), Some("bonjour"));
        });
    }

    #[test]
    fn test_nbt_parser_basic_compound() {
        let mut buf = vec![10, 0, 0, 8, 0, 4];
        buf.extend_from_slice(b"name");
        buf.extend_from_slice(&[0, 7]);
        buf.extend_from_slice(b"Hypixel");
        buf.push(0);
        let parsed = nbt::parse_nbt(&buf).unwrap();
        assert_eq!(parsed.pointer("/value/name/value").and_then(|v| v.as_str()), Some("Hypixel"));

        // Truncated/oversized array must be rejected
        let bad = vec![10, 0, 0, 7, 0, 1, b'x', 0x7f, 0xff, 0xff, 0xff];
        assert!(nbt::parse_nbt(&bad).is_err());
    }

    #[test]
    fn test_mc_version_parsing_arch_rules_and_semver() {
        assert_eq!(game::parse_mc_version("26.1-forge-62.1.0"), (26, 1, 0));
        assert_eq!(game::parse_mc_version("fabric-loader-0.16.0-1.21.4"), (1, 21, 4));
        assert_eq!(game::parse_mc_version("26w01a"), (26, 0, 0));
        assert_eq!(game::parse_mc_version("14w10a"), (1, 0, 0));

        assert!(game::is_modern_forge(&json!({ "id": "26.1-forge-62.1.0", "inheritsFrom": "26.1" })));
        assert!(game::is_modern_forge(&json!({ "id": "neoforge-21.1.0", "inheritsFrom": "1.21.1" })));
        assert!(!game::is_modern_forge(&json!({ "id": "1.12.2-forge", "inheritsFrom": "1.12.2" })));

        // Arch filtering: bare natives-linux skipped on arm64, ^x86$ skipped on x86_64
        assert!(game::should_skip_lib(&json!({ "name": "org.lwjgl:lwjgl:3.3.3:natives-linux" }), "linux", "arm64"));
        assert!(!game::should_skip_lib(&json!({ "name": "org.lwjgl:lwjgl:3.3.3:natives-linux-arm64" }), "linux", "arm64"));
        assert!(game::should_skip_lib(
            &json!({ "name": "foo:bar:1.0", "rules": [{ "action": "allow", "os": { "arch": "^x86$" } }] }),
            "windows",
            "x86_64"
        ));

        // Semver ordering: never downgrade v1.5.0 -> v1.4.0
        assert!(!horizon::is_semver_newer("v1.4.0", "v1.5.0"));
        assert!(horizon::is_semver_newer("v1.5.1", "v1.5.0"));
        assert!(!horizon::is_semver_newer("1.9.4", "v1.9.4"));
    }

    #[test]
    fn test_domain_allowlist_and_shortcut_sanitization() {
        assert!(game_validation::is_allowed_domain("cdn.modrinth.com", game_validation::ALLOWED_DOWNLOAD_DOMAINS));
        assert!(!game_validation::is_allowed_domain("evil-modrinth.com", game_validation::ALLOWED_DOWNLOAD_DOMAINS));
        assert!(game_validation::is_allowed_domain("objects.githubusercontent.com", game_validation::MULTI_TENANT_DOMAINS));
        assert_eq!(system::sanitize_shortcut_name("CON"), "");
        assert_eq!(system::sanitize_shortcut_name("My Instance; rm -rf /"), "My Instance rm -rf");
    }

    #[test]
    fn test_parse_electron_yml_manifest() {
        let yml = "\
version: 2.0.0
files:
  - url: Gens-Launcher_2.0.0_x64-setup.exe
    sha512: abcdef123456==
    size: 11400000
path: Gens-Launcher_2.0.0_x64-setup.exe
sha512: abcdef123456==
releaseDate: '2026-11-27T15:00:00.000Z'
";
        let info = updater::parse_electron_yml(yml).unwrap();
        assert_eq!(info.version, "2.0.0");
        assert_eq!(info.path, "Gens-Launcher_2.0.0_x64-setup.exe");
        assert_eq!(info.sha512, "abcdef123456==");
        assert_eq!(info.size, 11400000);
    }

    #[test]
    fn test_horizon_args_whitelist_and_settings_merge() {
        // Public commands allowed
        assert!(horizon::validate_horizon_args(&["--sync".into(), "Survival 1.21".into()], false).is_ok());
        assert!(horizon::validate_horizon_args(&["--check".into(), "--dry-run".into()], false).is_ok());
        // Internal-only commands blocked on public call-horizon
        assert!(horizon::validate_horizon_args(&["--logout".into()], false).is_err());
        assert!(horizon::validate_horizon_args(&["--logout".into()], true).is_ok());
        // Injection / traversal blocked
        assert!(horizon::validate_horizon_args(&["--sync".into(), "../evil".into()], false).is_err());
        assert!(horizon::validate_horizon_args(&["--sync".into(), "a;rm -rf".into()], false).is_err());
        assert!(horizon::validate_horizon_args(&["--evil-cmd".into()], true).is_err());

        with_temp_sandbox(|_| {
            // Save initial settings with deltaThreshold alias + selectiveProfiles
            horizon::save_horizon_settings(&json!({
                "provider": "dropbox",
                "syncMode": "SMART",
                "deltaThreshold": 12,
                "e2eEncryption": true,
                "selectiveProfiles": { "Survival": "ESSENTIAL", "Bad": "INVALID" }
            }))
            .unwrap();
            // Partial update must merge instead of wiping previous fields
            horizon::save_horizon_settings(&json!({ "autoSync": false })).unwrap();
            let s = horizon::get_horizon_settings();
            assert_eq!(s.get("provider").and_then(|v| v.as_str()), Some("dropbox"));
            assert_eq!(s.get("deltaCleanupThreshold").and_then(|v| v.as_i64()), Some(12));
            assert_eq!(s.get("e2eEncryption").and_then(|v| v.as_bool()), Some(true));
            assert_eq!(s.get("autoSync").and_then(|v| v.as_bool()), Some(false));
            assert_eq!(s.pointer("/selectiveProfiles/Survival").and_then(|v| v.as_str()), Some("ESSENTIAL"));
            assert!(s.pointer("/selectiveProfiles/Bad").is_none());

            // Invalid provider / out-of-bounds threshold rejected
            assert!(horizon::save_horizon_settings(&json!({ "provider": "evil" })).is_err());
            assert!(horizon::save_horizon_settings(&json!({ "deltaCleanupThreshold": 999 })).is_err());
        });
    }

    #[test]
    fn test_magic_bytes_and_sandbox_upload_guards() {
        assert!(network::is_valid_image_magic(b"\x89PNG\r\n\x1a\nrest"));
        assert!(network::is_valid_image_magic(b"\xFF\xD8\xFF\xE0"));
        assert!(!network::is_valid_image_magic(b"MZ\x90\x00executable"));
        assert!(network::is_valid_zip_magic(b"PK\x03\x04content"));
        assert!(!network::is_valid_zip_magic(b"not a zip"));

        with_temp_sandbox(|_| {
            let png_b64 = encoding::base64_encode(b"\x89PNG\r\n\x1a\nfakebody");
            assert!(network::save_uploaded_bytes(&png_b64, "icon.png", "icons", true).is_ok());
            // Fake PNG with executable magic bytes must be rejected
            let exe_b64 = encoding::base64_encode(b"MZ\x90\x00notapng!");
            assert!(network::save_uploaded_bytes(&exe_b64, "evil.png", "icons", true).is_err());
            // Disallowed extension must be rejected
            assert!(network::save_uploaded_bytes(&png_b64, "evil.exe", "icons", true).is_err());
            // UNC path must be rejected in save_temp_copy
            assert!(network::save_temp_copy(r"\\evil\share\icon.png", "icon.png", "icons", true).is_err());
        });
    }

    #[test]
    fn test_tar_gz_extraction_and_slip_protection() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        fn build_tar_gz(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
            let mut tar_buf = Vec::new();
            for (name, typeflag, data) in entries {
                let mut hdr = [0u8; 512];
                hdr[..name.len()].copy_from_slice(name.as_bytes());
                hdr[100..108].copy_from_slice(b"0000755\0");
                let size_str = format!("{:011o}\0", data.len());
                hdr[124..136].copy_from_slice(size_str.as_bytes());
                hdr[156] = *typeflag;
                hdr[257..263].copy_from_slice(b"ustar\0");
                hdr[263..265].copy_from_slice(b"00");
                // Compute header checksum with checksum field (148..156) filled with spaces
                hdr[148..156].fill(b' ');
                let cksum: u32 = hdr.iter().map(|&b| b as u32).sum();
                let ck_str = format!("{:06o}\0 ", cksum);
                hdr[148..156].copy_from_slice(ck_str.as_bytes());
                tar_buf.extend_from_slice(&hdr);
                tar_buf.extend_from_slice(data);
                let pad = (512 - (data.len() % 512)) % 512;
                tar_buf.resize(tar_buf.len() + pad, 0);
            }
            tar_buf.resize(tar_buf.len() + 1024, 0);
            let mut enc = GzEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&tar_buf).unwrap();
            enc.finish().unwrap()
        }

        with_temp_sandbox(|root| {
            let good_tar = root.join("good.tar.gz");
            std::fs::write(&good_tar, build_tar_gz(&[("sub/hello.txt", b'0', b"salut")])).unwrap();
            let dst = root.join("tar_out");
            let res = archive::extract_tar(&good_tar.to_string_lossy(), &dst.to_string_lossy()).unwrap();
            assert_eq!(res.get("success").and_then(|v| v.as_bool()), Some(true));
            assert_eq!(std::fs::read_to_string(dst.join("sub").join("hello.txt")).unwrap(), "salut");

            // Tar-Slip traversal must be blocked
            let slip_tar = root.join("slip.tar.gz");
            std::fs::write(&slip_tar, build_tar_gz(&[("../escape.txt", b'0', b"bad")])).unwrap();
            assert!(archive::extract_tar(&slip_tar.to_string_lossy(), &dst.to_string_lossy()).is_err());

            // Symlink inside tar must be blocked
            let sym_tar = root.join("sym.tar.gz");
            std::fs::write(&sym_tar, build_tar_gz(&[("link", b'2', b"")])).unwrap();
            assert!(archive::extract_tar(&sym_tar.to_string_lossy(), &dst.to_string_lossy()).is_err());
        });
    }

    #[test]
    fn test_folder_size_contract_and_duplicate_filter() {
        with_temp_sandbox(|root| {
            let src = root.join("inst_a");
            let dst = root.join("inst_b");
            std::fs::create_dir_all(&src).unwrap();
            std::fs::write(src.join("options.txt"), b"fov:90").unwrap();
            std::fs::write(src.join("instance.lock"), b"12345").unwrap();
            std::fs::write(src.join("latest.log"), b"logdata").unwrap();
            std::fs::write(src.join("temp.tmp"), b"tmp").unwrap();

            let sz = system::get_folder_size_cmd(&src.to_string_lossy()).unwrap();
            assert_eq!(sz.get("success").and_then(|v| v.as_bool()), Some(true));
            assert!(sz.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0) > 0);

            system::duplicate_instance_folder(&src.to_string_lossy(), &dst.to_string_lossy()).unwrap();
            assert!(dst.join("options.txt").is_file());
            assert!(!dst.join("instance.lock").exists());
            assert!(!dst.join("latest.log").exists());
            assert!(!dst.join("temp.tmp").exists());
        });
    }

    #[test]
    fn test_diagnostic_log_redaction_and_open_path_whitelist() {
        let raw = "User C:\\Users\\Alice\\AppData Bearer secretTok123 --accessToken=myToken456 alice@example.com";
        let red = system::redact_diagnostic_log(raw, r"C:\Users\Alice", "Alice");
        assert!(red.contains("<USER_HOME>"));
        assert!(!red.contains("secretTok123"));
        assert!(!red.contains("myToken456"));
        assert!(!red.contains("alice@example.com"));
        assert!(red.contains("<EMAIL_REDACTED>"));

        assert!(!system::is_blocked_executable_path(std::path::Path::new("C:\\test\\latest.log")));
        assert!(!system::is_blocked_executable_path(std::path::Path::new("C:\\test\\icon.png")));
        assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\evil.exe")));
        assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\notes.docx")));
        assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\log.txt:ads")));
        assert!(system::is_blocked_executable_path(std::path::Path::new("C:\\test\\log.txt.")));
    }

    #[test]
    fn test_auto_launch_percent_decoding() {
        let encoded = system::percent_encode_component("Mon Instance 1.21");
        assert_eq!(encoded, "Mon%20Instance%201.21");
        let args = vec!["gens.exe".into(), format!("--auto-launch={}", encoded)];
        assert_eq!(parse_auto_launch_arg(&args).as_deref(), Some("Mon Instance 1.21"));
    }

    #[test]
    fn test_trusted_external_domains() {
        with_temp_sandbox(|root| {
            assert!(system::is_trusted_external_host("github.com"));
            assert!(system::is_trusted_external_host("api.modrinth.com"));
            assert!(!system::is_trusted_external_host("evil-modrinth.com"));
            assert!(!system::is_trusted_external_host("random-site.example"));

            std::fs::write(
                root.join("trusted_external_domains.json"),
                r#"["custom-trusted.example"]"#,
            )
            .unwrap();
            assert!(system::is_trusted_external_host("custom-trusted.example"));
        });
    }
}
