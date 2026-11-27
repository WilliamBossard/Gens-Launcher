//! Sandbox path validation (lexical + anti-symlink realpath), renderer denylist,
//! atomic file writes with Windows lock retries, and directory utilities.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

#[cfg(test)]
use std::sync::Mutex;

#[cfg(test)]
static TEST_DATA_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
pub fn set_test_data_dir(dir: Option<PathBuf>) {
    if let Ok(mut guard) = TEST_DATA_DIR.lock() {
        *guard = dir;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessMode {
    Read,
    Write,
    Delete,
}

const VALID_JAVA_BASENAMES: &[&str] = &["java", "java.exe", "javaw", "javaw.exe"];

const BLOCKED_BOTH_FILES: &[&str] = &[
    ".secret_key",
    ".key_salt",
    "horizon_seal.key",
    "trusted_external_domains.json",
    "github_release_cache.json",
];

const BLOCKED_DELETE_ROOTS: &[&str] = &["horizon", "bin", "java", "runtime", "msa-cache"];

pub fn app_data_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(v) = std::env::var("APPDATA") {
            return PathBuf::from(v);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return PathBuf::from(xdg);
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".config");
        }
    }
    std::env::temp_dir()
}

pub fn safe_data_dir() -> PathBuf {
    #[cfg(test)]
    {
        if let Ok(guard) = TEST_DATA_DIR.lock()
            && let Some(ref custom) = *guard {
                return custom.clone();
            }
    }
    app_data_root().join("GensLauncher")
}

pub fn is_unc_path(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first_sep = bytes[0] == b'\\' || bytes[0] == b'/';
        let second_sep = bytes[1] == b'\\' || bytes[1] == b'/';
        if first_sep && second_sep {
            return true;
        }
    }
    false
}

/// Strip Windows extended-length prefix (`\\?\`) produced by `fs::canonicalize`.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", stripped));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    strip_verbatim_prefix(out)
}

/// Resolve the closest existing ancestor via `fs::canonicalize` and re-append any remaining tail.
/// Blocks symlink / junction escapes even when the target file does not exist yet.
pub fn resolve_nearest_real_path(abs_target: &Path) -> PathBuf {
    let normalized = normalize_lexical(abs_target);
    let mut cur = normalized.as_path();
    let mut tail_parts: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(real_cur) = fs::canonicalize(cur) {
            let mut out = strip_verbatim_prefix(real_cur);
            for part in tail_parts.into_iter().rev() {
                out.push(part);
            }
            return normalize_lexical(&out);
        }
        if let Some(name) = cur.file_name() {
            tail_parts.push(name);
        }
        match cur.parent() {
            Some(parent) if parent != cur => cur = parent,
            _ => return normalized,
        }
    }
}

pub fn is_under(target: &Path, base: &Path) -> bool {
    let t = normalize_lexical(target);
    let b = normalize_lexical(base);
    #[cfg(target_os = "windows")]
    {
        let ts = t.to_string_lossy().to_lowercase();
        let bs = b.to_string_lossy().to_lowercase();
        let bs_trimmed = bs.trim_end_matches('\\');
        ts == bs_trimmed || ts.starts_with(&format!("{}\\", bs_trimmed))
    }
    #[cfg(not(target_os = "windows"))]
    {
        t == b || t.starts_with(&b)
    }
}

/// Enforce the Renderer Path Guard denylist matching `createRendererPathGuard` in `src/main/fs-utils.js`.
pub fn assert_renderer_path_allowed(resolved_path: &Path, mode: AccessMode) -> Result<(), String> {
    let root = normalize_lexical(&safe_data_dir());
    let target = normalize_lexical(resolved_path);

    let norm_str = |p: &Path| -> String {
        #[cfg(target_os = "windows")]
        {
            p.to_string_lossy().to_lowercase()
        }
        #[cfg(not(target_os = "windows"))]
        {
            p.to_string_lossy().to_string()
        }
    };

    let norm_root = norm_str(&root);
    let norm_target = norm_str(&target);
    let sep = std::path::MAIN_SEPARATOR;
    let root_prefix = format!("{}{}", norm_root.trim_end_matches(sep), sep);

    if mode == AccessMode::Delete && norm_target == norm_root.trim_end_matches(sep) {
        return Err("Accès refusé par la politique de sécurité du Launcher (suppression ou renommage du dossier racine GensLauncher interdit).".into());
    }
    if !norm_target.starts_with(&root_prefix) {
        return Ok(());
    }

    let rel = &norm_target[root_prefix.len()..];
    let rel_unix = rel.replace('\\', "/").to_lowercase();
    let parts: Vec<&str> = rel_unix.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Ok(());
    }

    // 1. Secrets strictly reserved for Main Process (read + write + delete forbidden)
    if (parts.len() == 1 && BLOCKED_BOTH_FILES.contains(&parts[0]))
        || rel_unix == "horizon/horizon_version.json"
    {
        return Err("Accès refusé par la politique de sécurité du Launcher (fichier secret réservé au Main Process).".into());
    }
    for sub in ["msa-cache", "horizon/auth"] {
        if rel_unix == sub || rel_unix.starts_with(&format!("{}/", sub)) {
            return Err("Accès refusé par la politique de sécurité du Launcher (dossier de secrets réservé au Main Process).".into());
        }
    }
    if parts.len() == 2 {
        let joined_top2 = format!("{}/{}", parts[0], parts[1]);
        if (joined_top2.starts_with("horizon/horizon") || joined_top2.starts_with("bin/horizon"))
            && !joined_top2.ends_with(".json")
        {
            return Err("Accès refusé par la politique de sécurité du Launcher (binaire Horizon réservé au Main Process).".into());
        }
    }

    // 2. Critical root folders protected against global deletion/rename
    if mode == AccessMode::Delete && parts.len() == 1 && BLOCKED_DELETE_ROOTS.contains(&parts[0]) {
        return Err("Accès refusé par la politique de sécurité du Launcher (suppression ou renommage de dossier système réservé au Main Process).".into());
    }

    // 3. Java/runtime executables protected against renderer writes/deletes
    if matches!(mode, AccessMode::Write | AccessMode::Delete) {
        for sub in ["java", "runtime"] {
            if rel_unix == sub || rel_unix.starts_with(&format!("{}/", sub)) {
                return Err("Accès refusé par la politique de sécurité du Launcher (dossier runtime/java géré exclusivement par le Main Process).".into());
            }
        }
    }

    Ok(())
}

/// Validate a path strictly under `safe_data_dir` (lexical + realpath anti-symlink).
/// Used for both internal sandbox writes and IPC write validation.
pub fn assert_write_sandbox(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() || raw.contains('\0') {
        return Err("Chemin invalide.".into());
    }
    if is_unc_path(raw) {
        return Err("Chemin hors du sandbox GensLauncher (UNC bloqué).".into());
    }
    let p = normalize_lexical(Path::new(raw.trim()));
    #[cfg(target_os = "windows")]
    if p.to_string_lossy().starts_with(r"\\") {
        return Err("Chemin hors du sandbox GensLauncher (UNC bloqué).".into());
    }
    let root = safe_data_dir();
    if !is_under(&p, &root) {
        return Err(format!("Accès en écriture hors sandbox refusé : {}", p.display()));
    }
    let real_root = resolve_nearest_real_path(&root);
    let real_target = resolve_nearest_real_path(&p);
    if !is_under(&real_target, &real_root) {
        return Err(format!(
            "Évasion symlink hors sandbox bloquée : {}",
            p.display()
        ));
    }
    Ok(p)
}

/// Validate a renderer-initiated write/delete path (sandbox + renderer denylist on both lexical & real paths).
pub fn assert_renderer_write_sandbox(raw: &str, mode: AccessMode) -> Result<PathBuf, String> {
    let safe_path = assert_write_sandbox(raw)?;
    assert_renderer_path_allowed(&safe_path, mode)?;
    let real_target = resolve_nearest_real_path(&safe_path);
    assert_renderer_path_allowed(&real_target, mode)?;
    Ok(safe_path)
}

fn allowed_read_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        safe_data_dir(),
        app_data_root().join(".minecraft"),
        std::env::temp_dir().join("GensLauncher"),
    ];
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let h = PathBuf::from(home);
        roots.push(h.join(".minecraft"));
        roots.push(h.join("Library").join("Application Support").join("minecraft"));
    }
    roots
}

pub fn assert_read_sandbox(raw: &str) -> Result<PathBuf, String> {
    assert_read_sandbox_opts(raw, false, false)
}

/// Validate a read path with anti-symlink check, optional renderer denylist, and optional java.exe exception.
pub fn assert_read_sandbox_opts(
    raw: &str,
    enforce_renderer_guard: bool,
    allow_java_exe: bool,
) -> Result<PathBuf, String> {
    if raw.trim().is_empty() || raw.contains('\0') {
        return Err("Chemin invalide.".into());
    }
    if is_unc_path(raw) {
        return Err("Accès aux partages réseau UNC refusé par le système de sécurité du Launcher.".into());
    }
    let p = normalize_lexical(Path::new(raw.trim()));
    #[cfg(target_os = "windows")]
    if p.to_string_lossy().starts_with(r"\\") {
        return Err("Accès aux partages réseau UNC refusé par le système de sécurité du Launcher.".into());
    }

    let roots = allowed_read_roots();
    if roots.iter().any(|r| is_under(&p, r)) {
        let real_target = resolve_nearest_real_path(&p);
        let real_ok = roots
            .iter()
            .any(|r| is_under(&real_target, &resolve_nearest_real_path(r)));
        if real_ok {
            if enforce_renderer_guard {
                assert_renderer_path_allowed(&p, AccessMode::Read)?;
                assert_renderer_path_allowed(&real_target, AccessMode::Read)?;
            }
            return Ok(p);
        }
    }

    if allow_java_exe {
        let base = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        if VALID_JAVA_BASENAMES.contains(&base.as_str()) {
            let real_java = resolve_nearest_real_path(&p);
            let real_base = real_java
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            let real_is_unc = real_java.to_string_lossy().starts_with(r"\\");
            if !real_is_unc && VALID_JAVA_BASENAMES.contains(&real_base.as_str()) {
                if enforce_renderer_guard {
                    assert_renderer_path_allowed(&p, AccessMode::Read)?;
                    assert_renderer_path_allowed(&real_java, AccessMode::Read)?;
                }
                return Ok(p);
            }
        }
    }

    Err(format!("Accès en lecture hors sandbox refusé : {}", p.display()))
}

pub fn rename_with_retry(src: &Path, dest: &Path) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 0..5 {
        match fs::rename(src, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if attempt < 4 {
                    std::thread::sleep(Duration::from_millis(40 * (attempt + 1) as u64));
                    continue;
                }
            }
        }
    }
    Err(last_err)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = rename_with_retry(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn folder_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            total = total.saturating_add(folder_size(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

pub fn copy_dir_no_symlinks(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if meta.is_dir() {
            copy_dir_no_symlinks(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
