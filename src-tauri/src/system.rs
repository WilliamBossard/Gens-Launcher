//! Native OS utilities: persistent main-process logging, memory info, Tauri Opener / Clipboard,
//! strict passive-file open_path, folder size, instance duplication filter, shortcuts, and
//! redacted diagnostic ZIP export (1:1 parity with src/main/ipc-system.js).

use crate::sandbox::{
    assert_read_sandbox_opts, assert_renderer_write_sandbox, folder_size, safe_data_dir, AccessMode,
};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const ALLOWED_OPEN_EXTENSIONS: &[&str] = &[
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
    "log",
    "txt",
    "json",
    "toml",
    "cfg",
    "properties",
    "mcmeta",
];

const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024; // 1 MiB
const MAX_MAIN_LOG_BYTES: usize = 10 * 1024 * 1024; // 10 MiB

struct MainLogger {
    file: Option<fs::File>,
    written: usize,
}

fn logger_cell() -> &'static Mutex<MainLogger> {
    static LOGGER: OnceLock<Mutex<MainLogger>> = OnceLock::new();
    LOGGER.get_or_init(|| {
        Mutex::new(MainLogger {
            file: None,
            written: 0,
        })
    })
}

pub fn init_main_log() {
    let logs_dir = safe_data_dir().join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let log_path = logs_dir.join(format!("main-process_{}.log", ts));
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let header = format!(
            "--- Gens Launcher Rust Main Log v{} (ts={}) ---\n",
            env!("CARGO_PKG_VERSION"),
            ts
        );
        let _ = f.write_all(header.as_bytes());
        if let Ok(mut guard) = logger_cell().lock() {
            guard.written = header.len();
            guard.file = Some(f);
        }
    }
}

pub fn main_log(msg: &str) {
    if let Ok(mut guard) = logger_cell().lock() {
        if guard.written >= MAX_MAIN_LOG_BYTES {
            return;
        }
        if let Some(ref mut f) = guard.file {
            let line = format!("{}\n", msg);
            if f.write_all(line.as_bytes()).is_ok() {
                guard.written = guard.written.saturating_add(line.len());
            }
        }
    }
}

pub fn get_mem_info() -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        }
        let mut st = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        if unsafe { GlobalMemoryStatusEx(&mut st) } != 0 {
            return (st.ull_total_phys, st.ull_avail_phys);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(txt) = fs::read_to_string("/proc/meminfo") {
            let mut total = 0u64;
            let mut avail = 0u64;
            for line in txt.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    total = rest
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.parse::<u64>().ok())
                        .unwrap_or(0)
                        * 1024;
                } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    avail = rest
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.parse::<u64>().ok())
                        .unwrap_or(0)
                        * 1024;
                }
            }
            if total > 0 {
                return (total, avail);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            if let Ok(total) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                if total > 0 {
                    return (total, total / 2);
                }
            }
        }
    }
    (8u64 * 1024 * 1024 * 1024, 4u64 * 1024 * 1024 * 1024)
}

const TRUSTED_EXTERNAL_DOMAINS: &[&str] = &[
    "github.com",
    "modrinth.com",
    "curseforge.com",
    "minecraft.net",
    "mojang.com",
    "microsoft.com",
    "live.com",
    "discord.com",
    "discord.gg",
    "adoptium.net",
    "neoforged.net",
    "fabricmc.net",
    "quiltmc.org",
    "minecraftforge.net",
    "optifine.net",
    "irisshaders.dev",
    "williambossard.github.io",
];

pub fn is_trusted_external_host(hostname: &str) -> bool {
    let h = hostname.trim().to_lowercase();
    if TRUSTED_EXTERNAL_DOMAINS
        .iter()
        .any(|d| h == *d || h.ends_with(&format!(".{}", d)))
    {
        return true;
    }
    let trusted_file = safe_data_dir().join("trusted_external_domains.json");
    if let Ok(raw) = fs::read_to_string(&trusted_file)
        && let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&raw) {
            return arr
                .iter()
                .filter_map(|v| v.as_str())
                .any(|d| d.trim().eq_ignore_ascii_case(&h));
        }
    false
}

pub fn open_external(app: &AppHandle, raw_url: &str) -> Result<Value, String> {
    let parsed = Url::parse(raw_url.trim()).map_err(|_| "URL externe invalide.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Seuls les liens HTTPS sont autorisés.".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Les identifiants dans l'URL sont refusés.".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !is_trusted_external_host(host) {
        let confirmed = app
            .dialog()
            .message(format!(
                "Voulez-vous ouvrir ce site externe dans votre navigateur ?\n\n{}",
                parsed.as_str()
            ))
            .title("Ouvrir un lien externe")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Ouvrir le lien".into(),
                "Annuler".into(),
            ))
            .blocking_show();
        if !confirmed {
            return Ok(json!({ "success": false, "error": "Ouverture annulée par l'utilisateur." }));
        }
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

/// Strict passive-file whitelist matching `ALLOWED_OPEN_EXTS` in `src/main/ipc-system.js`.
pub fn is_blocked_executable_path(path: &Path) -> bool {
    if path.is_dir() {
        return false;
    }
    let Some(base) = path.file_name().and_then(|n| n.to_str()) else {
        return true;
    };
    if base.contains(':') || base.ends_with('.') || base.ends_with(' ') {
        return true;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    !ALLOWED_OPEN_EXTENSIONS.contains(&ext.as_str())
}

pub fn open_path(app: &AppHandle, raw: &str) -> Result<Value, String> {
    let p = assert_read_sandbox_opts(raw, true, false)?;
    let lstat = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    if lstat.file_type().is_symlink() {
        return Err("Ouverture directe de lien symbolique bloquée.".into());
    }
    if !lstat.is_dir() && (!lstat.is_file() || is_blocked_executable_path(&p)) {
        return Err("Ouverture directe bloquée : seul l'accès aux dossiers et fichiers passifs autorisés est permis.".into());
    }
    app.opener()
        .open_path(p.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn show_item_in_folder(app: &AppHandle, raw: &str) -> Result<Value, String> {
    let p = assert_read_sandbox_opts(raw, true, false)?;
    app.opener()
        .reveal_item_in_dir(&p)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn write_clipboard(app: &AppHandle, text: &str) -> Value {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return json!({ "success": false, "error": "Contenu presse-papiers trop volumineux (> 1 Mo)." });
    }
    match app.clipboard().write_text(text.to_string()) {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// Returns `{ success: true, bytes }` matching Electron's `get-folder-size` contract.
pub fn get_folder_size_cmd(raw: &str) -> Result<Value, String> {
    match assert_read_sandbox_opts(raw, true, false) {
        Ok(p) => Ok(json!({ "success": true, "bytes": folder_size(&p) })),
        Err(e) => Ok(json!({ "success": false, "error": e, "bytes": 0 })),
    }
}

fn copy_instance_dir_filtered(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let low = name.to_lowercase();
        if low == "instance.lock" || low.ends_with(".log") || low.ends_with(".tmp") {
            continue;
        }
        let target = dst.join(entry.file_name());
        if meta.is_dir() {
            copy_instance_dir_filtered(&path, &target)?;
        } else if meta.is_file() {
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn duplicate_instance_folder(src_raw: &str, dst_raw: &str) -> Result<Value, String> {
    let src = assert_read_sandbox_opts(src_raw, true, false)?;
    let dst = assert_renderer_write_sandbox(dst_raw, AccessMode::Write)?;
    copy_instance_dir_filtered(&src, &dst)?;
    Ok(json!({ "success": true }))
}

/// Redact PII & secrets from diagnostic logs (1:1 parity with `redactDiagnosticLog` in Electron).
pub fn redact_diagnostic_log(raw: &str, homedir: &str, username: &str) -> String {
    let mut out = raw.to_string();
    if homedir.len() >= 3 {
        out = out.replace(homedir, "<USER_HOME>");
        let slash_home = homedir.replace('\\', "/");
        if slash_home != homedir {
            out = out.replace(&slash_home, "<USER_HOME>");
        }
    }
    if username.len() >= 2 {
        for sep in ['\\', '/'] {
            let pat = format!("{}{}{}", sep, username, sep);
            let rep = format!("{}<USER>{}", sep, sep);
            out = out.replace(&pat, &rep);
        }
    }

    let mut lines_out = Vec::new();
    for line in out.lines() {
        let mut tokens: Vec<String> = Vec::new();
        let mut redact_next = false;
        for tok in line.split_whitespace() {
            if redact_next {
                tokens.push("***REDACTED***".into());
                redact_next = false;
                continue;
            }
            let low = tok.to_lowercase();
            if matches!(
                low.as_str(),
                "bearer" | "--accesstoken" | "--session" | "--proxypass"
            ) {
                tokens.push(tok.to_string());
                redact_next = true;
            } else if low.starts_with("--accesstoken=")
                || low.starts_with("--session=")
                || low.starts_with("--proxypass=")
            {
                let prefix = tok.split('=').next().unwrap_or(tok);
                tokens.push(format!("{}=***REDACTED***", prefix));
            } else if tok.contains('@')
                && tok.contains('.')
                && !tok.starts_with("http")
                && tok
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-' | '@'))
            {
                tokens.push("<EMAIL_REDACTED>".into());
            } else {
                tokens.push(tok.to_string());
            }
        }
        lines_out.push(tokens.join(" "));
    }
    lines_out.join("\n")
}

pub fn export_diagnostic(app: &AppHandle, opts: &Value) -> Result<Value, String> {
    let root = safe_data_dir();
    let dest = if let Some(dp) = opts
        .get("destPath")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let safe = assert_renderer_write_sandbox(dp, AccessMode::Write)?;
        let ext = safe
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if ext != "zip" {
            return Err("Extension .zip requise pour l'export de diagnostic.".into());
        }
        if let Some(p) = safe.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        safe
    } else {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let default_name = format!("gens-diagnostic-{}.zip", ts);
        let picked = app
            .dialog()
            .file()
            .set_title("Exporter un rapport de diagnostic")
            .set_file_name(&default_name)
            .add_filter("Archive ZIP", &["zip"])
            .blocking_save_file();
        let Some(file_path) = picked else {
            return Ok(json!({ "success": false, "canceled": true }));
        };
        let p = file_path
            .into_path()
            .map_err(|_| "Chemin de destination invalide.".to_string())?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        p
    };

    let file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let zip_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let homedir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let username = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();

    let mut included_logs: Vec<String> = Vec::new();
    let logs_dir = root.join("logs");
    if let Ok(entries) = fs::read_dir(&logs_dir) {
        let mut all_logs: Vec<(String, PathBuf, u128)> = entries
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".log") {
                    return None;
                }
                let meta = fs::metadata(&p).ok()?;
                if !meta.is_file() {
                    return None;
                }
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                Some((name, p, mtime))
            })
            .collect();
        all_logs.sort_by_key(|b| std::cmp::Reverse(b.2));

        let main_logs: Vec<_> = all_logs
            .iter()
            .filter(|(n, _, _)| n.starts_with("main-process_"))
            .take(2)
            .cloned()
            .collect();
        let game_logs: Vec<_> = all_logs
            .iter()
            .filter(|(n, _, _)| n.starts_with("game_"))
            .take(1)
            .cloned()
            .collect();

        for (name, path, _) in main_logs.into_iter().chain(game_logs) {
            if let Ok(txt) = fs::read_to_string(&path) {
                let redacted = redact_diagnostic_log(&txt, &homedir, &username);
                let rel = format!("logs/{}", name);
                if zip.start_file(&rel, zip_opts).is_ok() {
                    let _ = zip.write_all(redacted.as_bytes());
                    included_logs.push(rel);
                }
            }
        }
    }

    let horizon_ver = fs::read_to_string(root.join("Horizon").join("horizon_version.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(|s| s.to_string()));

    let (tot, free) = get_mem_info();
    let diag_summary = json!({
        "generatedAt": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "runtime": "tauri-v2-rust",
        "totalMemMB": tot / (1024 * 1024),
        "freeMemMB": free / (1024 * 1024),
        "horizonVersion": horizon_ver,
        "includedLogs": included_logs
    });
    zip.start_file("diagnostic.json", zip_opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&diag_summary)
            .unwrap_or_default()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "path": dest.to_string_lossy() }))
}

pub fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Update the Windows Taskbar Jump List with recent Minecraft instances (1:1 with Electron `setUserTasks`).
pub fn update_jump_list(instances: &Value) {
    #[cfg(target_os = "windows")]
    {
        let Some(arr) = instances.as_array() else {
            return;
        };
        if let Err(e) = update_jump_list_win32(arr) {
            main_log(&format!("[JumpList] Erreur mise à jour Jump List : {}", e));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = instances;
    }
}

#[cfg(target_os = "windows")]
fn update_jump_list_win32(instances: &[Value]) -> Result<(), String> {
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    // PKEY_Title = {F29F85E0-4FF9-1068-AB91-08002B27B3D9}, PID 2
    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0xF29F85E0_4FF9_1068_AB91_08002B27B3D9),
        pid: 2,
    };

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().to_string();

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninit = hr.is_ok();

        let res = (|| -> Result<(), String> {
            let dest_list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;

            let mut max_slots: u32 = 0;
            let _removed: IObjectArray = dest_list
                .BeginList(&mut max_slots)
                .map_err(|e| e.to_string())?;

            let collection: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;

            let mut added = 0usize;
            for inst in instances.iter().take(10) {
                let raw_name = inst.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let safe_name = sanitize_shortcut_name(raw_name);
                if safe_name.is_empty() {
                    continue;
                }
                let icon_path = inst
                    .get("iconIcoPath")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .and_then(|p| assert_read_sandbox_opts(p, true, false).ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| exe_str.clone());

                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;
                let exe_h = HSTRING::from(&exe_str);
                let args_h = HSTRING::from(format!(
                    "--auto-launch=\"{}\"",
                    percent_encode_component(raw_name)
                ));
                let desc_h = HSTRING::from(format!("Démarrer l'instance {}", safe_name));
                let icon_h = HSTRING::from(&icon_path);

                link.SetPath(PCWSTR(exe_h.as_ptr()))
                    .map_err(|e| e.to_string())?;
                link.SetArguments(PCWSTR(args_h.as_ptr()))
                    .map_err(|e| e.to_string())?;
                link.SetDescription(PCWSTR(desc_h.as_ptr()))
                    .map_err(|e| e.to_string())?;
                link.SetIconLocation(PCWSTR(icon_h.as_ptr()), 0)
                    .map_err(|e| e.to_string())?;

                let store: IPropertyStore = link.cast().map_err(|e| e.to_string())?;
                let title_pv = PROPVARIANT::from(format!("Lancer {}", safe_name).as_str());
                store
                    .SetValue(&PKEY_TITLE, &title_pv)
                    .map_err(|e| e.to_string())?;
                store.Commit().map_err(|e| e.to_string())?;

                collection.AddObject(&link).map_err(|e| e.to_string())?;
                added += 1;
            }

            if added > 0 {
                let tasks: IObjectArray = collection.cast().map_err(|e| e.to_string())?;
                dest_list.AddUserTasks(&tasks).map_err(|e| e.to_string())?;
            }
            dest_list.CommitList().map_err(|e| e.to_string())?;
            Ok(())
        })();

        if should_uninit {
            CoUninitialize();
        }
        res
    }
}

fn desktop_dir() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(home).join("Desktop");
    }
    std::env::temp_dir()
}

pub fn sanitize_shortcut_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\r' | '\n' | '\0'
                    | '\'' | '`' | ';' | '$'
            )
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .chars()
        .take(100)
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return String::new();
    }
    let low = cleaned.to_lowercase();
    let stem = low.split('.').next().unwrap_or("");
    if matches!(
        stem,
        "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6"
            | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6"
            | "lpt7" | "lpt8" | "lpt9"
    ) {
        return String::new();
    }
    cleaned
}

pub fn check_shortcut_exists(safe_name: &str) -> Value {
    let clean = sanitize_shortcut_name(safe_name);
    if clean.is_empty() {
        return json!(false);
    }
    let ext = if cfg!(target_os = "windows") {
        "lnk"
    } else if cfg!(target_os = "macos") {
        "command"
    } else {
        "desktop"
    };
    json!(desktop_dir().join(format!("{}.{}", clean, ext)).exists())
}

pub fn delete_desktop_shortcut(instance_name: &str) -> Value {
    let clean = sanitize_shortcut_name(instance_name);
    if clean.is_empty() {
        return json!({ "success": false });
    }
    let ext = if cfg!(target_os = "windows") {
        "lnk"
    } else if cfg!(target_os = "macos") {
        "command"
    } else {
        "desktop"
    };
    let p = desktop_dir().join(format!("{}.{}", clean, ext));
    let _ = fs::remove_file(p);
    json!({ "success": true })
}

pub fn create_desktop_shortcut(instance_name: &str) -> Value {
    let clean = sanitize_shortcut_name(instance_name);
    if clean.is_empty() {
        return json!({ "success": false, "error": "Nom invalide" });
    }
    let Ok(exe) = std::env::current_exe() else {
        return json!({ "success": false, "error": "Exécutable introuvable" });
    };
    #[cfg(target_os = "windows")]
    {
        let lnk = desktop_dir().join(format!("{}.lnk", clean));
        // Pass values via environment variables to avoid any PowerShell string interpolation injection
        use std::os::windows::process::CommandExt;
        let ps_script = "$ws = New-Object -ComObject WScript.Shell; \
            $s = $ws.CreateShortcut($env:GENS_LNK_PATH); \
            $s.TargetPath = $env:GENS_EXE_PATH; \
            $s.Arguments = '--auto-launch=' + $env:GENS_INST_NAME; \
            $s.Save()";
        let ok = std::process::Command::new("powershell")
            .creation_flags(0x08000000)
            .env("GENS_LNK_PATH", &lnk)
            .env("GENS_EXE_PATH", &exe)
            .env("GENS_INST_NAME", &clean)
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_script])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        json!({ "success": ok })
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let p = desktop_dir().join(format!("{}.command", clean));
        let content = format!(
            "#!/bin/sh\nexec \"{}\" \"--auto-launch={}\"\n",
            exe.display(),
            clean
        );
        let ok = fs::write(&p, content).is_ok()
            && fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).is_ok();
        return json!({ "success": ok });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let p = desktop_dir().join(format!("{}.desktop", clean));
        let content = format!(
            "[Desktop Entry]\nType=Application\nName={}\nExec=\"{}\" \"--auto-launch={}\"\nTerminal=false\nCategories=Game;\n",
            clean,
            exe.display(),
            clean
        );
        let ok = fs::write(&p, content).is_ok()
            && fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).is_ok();
        return json!({ "success": ok });
    }
}
