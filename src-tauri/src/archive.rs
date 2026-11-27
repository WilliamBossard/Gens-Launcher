//! Zip-Slip-safe ZIP & pure-Rust .tar.gz extraction, inspection, and folder compression.

use crate::sandbox::{
    assert_read_sandbox, assert_read_sandbox_opts, assert_renderer_write_sandbox,
    assert_write_sandbox, is_under, normalize_lexical, safe_data_dir, AccessMode,
};
use flate2::read::GzDecoder;
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MAX_UNCOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB anti-Zip-Bomb
const MAX_TEXT_ENTRY_BYTES: u64 = 10 * 1024 * 1024; // 10 MiB anti-OOM
const MAX_BATCH_ITEMS: usize = 500;

#[allow(dead_code)]
pub fn extract_zip(zip_path: &str, dest_dir: &str) -> Result<Value, String> {
    extract_zip_internal(None, zip_path, dest_dir, true)
}

pub fn extract_zip_privileged(zip_path: &str, dest_dir: &str) -> Result<Value, String> {
    extract_zip_internal(None, zip_path, dest_dir, false)
}

pub fn extract_zip_with_progress(
    app: Option<&AppHandle>,
    zip_path: &str,
    dest_dir: &str,
) -> Result<Value, String> {
    extract_zip_internal(app, zip_path, dest_dir, true)
}

fn extract_zip_internal(
    app: Option<&AppHandle>,
    zip_path: &str,
    dest_dir: &str,
    enforce_renderer_guard: bool,
) -> Result<Value, String> {
    let src = assert_read_sandbox_opts(zip_path, enforce_renderer_guard, false)?;
    let dst = if enforce_renderer_guard {
        assert_renderer_write_sandbox(dest_dir, AccessMode::Write)?
    } else {
        assert_write_sandbox(dest_dir)?
    };
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;

    let file = fs::File::open(&src).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total_entries = archive.len().max(1);
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject symlinks inside ZIP archives (Unix mode S_IFLNK = 0o120000)
        if let Some(mode) = entry.unix_mode()
            && (mode & 0o170000) == 0o120000 {
                return Err("Zip-Slip bloqué : lien symbolique interdit dans l'archive.".into());
            }
        let Some(rel) = entry.enclosed_name() else {
            return Err("Zip-Slip bloqué : chemin d'entrée invalide".into());
        };
        let target = normalize_lexical(&dst.join(rel));
        if !is_under(&target, &dst) {
            return Err("Zip-Slip bloqué : sortie hors répertoire".into());
        }
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let remaining = MAX_UNCOMPRESSED_BYTES.saturating_sub(total_bytes);
            let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut out)
                .map_err(|e| e.to_string())?;
            total_bytes = total_bytes.saturating_add(copied);
            if total_bytes > MAX_UNCOMPRESSED_BYTES {
                drop(out);
                let _ = fs::remove_file(&target);
                return Err("Zip Bomb bloquée (> 4 Gio)".into());
            }
        }
        if let Some(handle) = app
            && (i % 10 == 0 || i + 1 == total_entries) {
                let pct = (((i + 1) as f64 / total_entries as f64) * 100.0).round() as u64;
                let _ = handle.emit(
                    "zip-progress",
                    json!({ "percent": pct, "current": i + 1, "total": total_entries }),
                );
            }
    }
    Ok(json!({ "success": true }))
}

pub fn extract_tar(archive_path: &str, dest_dir: &str) -> Result<Value, String> {
    extract_tar_internal(archive_path, dest_dir, true)
}

pub fn extract_tar_privileged(archive_path: &str, dest_dir: &str) -> Result<Value, String> {
    extract_tar_internal(archive_path, dest_dir, false)
}

fn parse_tar_octal(bytes: &[u8]) -> u64 {
    let s = std::str::from_utf8(bytes)
        .unwrap_or("")
        .trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace());
    if s.is_empty() {
        return 0;
    }
    u64::from_str_radix(s, 8).unwrap_or(0)
}

fn parse_tar_cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn sanitize_tar_rel_path(raw: &str) -> Result<Option<std::path::PathBuf>, String> {
    let norm = raw.replace('\\', "/");
    let trimmed = norm.trim_start_matches("./");
    if trimmed.is_empty() || trimmed == "." {
        return Ok(None);
    }
    if trimmed.starts_with('/') || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':') {
        return Err(format!("Tar-Slip bloqué : chemin absolu ({})", raw));
    }
    let mut out = std::path::PathBuf::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(format!("Tar-Slip bloqué : traversée '..' ({})", raw));
        }
        out.push(seg);
    }
    if out.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

/// Pure-Rust USTAR / GNU LongName / PAX `.tar.gz` extractor (0 extra crate).
/// Enforces Zip-Slip protection, rejects symlinks & hardlinks, and caps total bytes at 4 GiB.
fn extract_tar_internal(
    archive_path: &str,
    dest_dir: &str,
    enforce_renderer_guard: bool,
) -> Result<Value, String> {
    let src = assert_read_sandbox_opts(archive_path, enforce_renderer_guard, false)?;
    let dst = if enforce_renderer_guard {
        assert_renderer_write_sandbox(dest_dir, AccessMode::Write)?
    } else {
        assert_write_sandbox(dest_dir)?
    };
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;

    let file = fs::File::open(&src).map_err(|e| e.to_string())?;
    let mut reader = GzDecoder::new(file);
    let mut header = [0u8; 512];
    let mut total_bytes: u64 = 0;
    let mut next_long_name: Option<String> = None;

    loop {
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("Erreur lecture tar.gz : {}", e)),
        }
        // Two consecutive zero blocks mark end-of-archive
        if header.iter().all(|&b| b == 0) {
            break;
        }

        let size = parse_tar_octal(&header[124..136]);
        let mode = parse_tar_octal(&header[100..108]) as u32;
        let typeflag = header[156];
        let pad = (512 - (size % 512)) % 512;

        // GNU LongName ('L')
        if typeflag == b'L' {
            if size > 64 * 1024 {
                return Err("Tar-Slip bloqué : nom de fichier GNU trop long.".into());
            }
            let mut buf = vec![0u8; size as usize];
            reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
            if pad > 0 {
                std::io::copy(&mut reader.by_ref().take(pad), &mut std::io::sink())
                    .map_err(|e| e.to_string())?;
            }
            next_long_name = Some(parse_tar_cstr(&buf));
            continue;
        }

        // PAX extended header ('x' / 'g') — extract `path=` if present
        if typeflag == b'x' || typeflag == b'g' {
            if size > 256 * 1024 {
                return Err("En-tête PAX trop volumineux.".into());
            }
            let mut buf = vec![0u8; size as usize];
            reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
            if pad > 0 {
                std::io::copy(&mut reader.by_ref().take(pad), &mut std::io::sink())
                    .map_err(|e| e.to_string())?;
            }
            if typeflag == b'x' {
                let text = String::from_utf8_lossy(&buf);
                for line in text.lines() {
                    if let Some((_, kv)) = line.split_once(' ')
                        && let Some(p) = kv.strip_prefix("path=") {
                            next_long_name = Some(p.to_string());
                        }
                }
            }
            continue;
        }

        let raw_name = if let Some(ln) = next_long_name.take() {
            ln
        } else {
            let name = parse_tar_cstr(&header[0..100]);
            let prefix = parse_tar_cstr(&header[345..500]);
            if prefix.is_empty() {
                name
            } else {
                format!("{}/{}", prefix, name)
            }
        };

        // Block symlinks ('2') and hardlinks ('1')
        if typeflag == b'1' || typeflag == b'2' {
            return Err(format!(
                "Tar-Slip bloqué : lien symbolique/dur interdit ({})",
                raw_name
            ));
        }

        let rel_opt = sanitize_tar_rel_path(&raw_name)?;
        if let Some(rel) = rel_opt {
            let target = normalize_lexical(&dst.join(&rel));
            if !is_under(&target, &dst) {
                return Err(format!("Tar-Slip bloqué : sortie hors répertoire ({})", raw_name));
            }
            if typeflag == b'5' {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                if size > 0 {
                    std::io::copy(&mut reader.by_ref().take(size), &mut std::io::sink())
                        .map_err(|e| e.to_string())?;
                }
            } else if typeflag == b'0' || typeflag == 0 {
                total_bytes = total_bytes.saturating_add(size);
                if total_bytes > MAX_UNCOMPRESSED_BYTES {
                    return Err("Zip Bomb bloquée (> 4 Gio)".into());
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
                let copied = std::io::copy(&mut reader.by_ref().take(size), &mut out)
                    .map_err(|e| e.to_string())?;
                if copied != size {
                    return Err("Archive tar.gz tronquée.".into());
                }
                drop(out);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perm = if (mode & 0o111) != 0 { 0o755 } else { 0o644 };
                    let _ = fs::set_permissions(&target, fs::Permissions::from_mode(perm));
                }
                #[cfg(not(unix))]
                {
                    let _ = mode;
                }
            } else if size > 0 {
                std::io::copy(&mut reader.by_ref().take(size), &mut std::io::sink())
                    .map_err(|e| e.to_string())?;
            }
        } else if size > 0 {
            std::io::copy(&mut reader.by_ref().take(size), &mut std::io::sink())
                .map_err(|e| e.to_string())?;
        }

        if pad > 0 {
            std::io::copy(&mut reader.by_ref().take(pad), &mut std::io::sink())
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(json!({ "success": true }))
}

pub fn read_zip_text(zip_path: &str, entry_names: &[String]) -> Result<Value, String> {
    let src = assert_read_sandbox(zip_path)?;
    let file = fs::File::open(&src).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for name in entry_names {
        if let Ok(entry) = archive.by_name(name) {
            if entry.size() > MAX_TEXT_ENTRY_BYTES {
                return Err("Entrée ZIP trop volumineuse (> 10 Mio)".into());
            }
            let mut buf = Vec::new();
            entry
                .take(MAX_TEXT_ENTRY_BYTES + 1)
                .read_to_end(&mut buf)
                .map_err(|e| e.to_string())?;
            if buf.len() as u64 > MAX_TEXT_ENTRY_BYTES {
                return Err("Entrée ZIP trop volumineuse (> 10 Mio)".into());
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            // Format exact attendu par Electron : { success, text, file }
            return Ok(json!({ "success": true, "text": text, "file": name }));
        }
    }
    Ok(json!({ "success": false }))
}

pub fn read_zip_text_batch(items: &[Value], entry_names: &[String]) -> Value {
    if items.len() > MAX_BATCH_ITEMS {
        return json!({ "success": false, "results": {} });
    }
    let mut results = Map::new();
    for item in items {
        let Some(path) = item
            .as_str()
            .or_else(|| item.get("path").and_then(|v| v.as_str()))
        else {
            continue;
        };
        if let Ok(r) = read_zip_text(path, entry_names) {
            results.insert(path.to_string(), r);
        } else {
            results.insert(path.to_string(), json!({ "success": false }));
        }
    }
    json!({ "success": true, "results": results })
}

pub fn compress_folder(
    app: Option<&AppHandle>,
    src_dir: &str,
    dest_zip: &str,
    exclude: &[String],
) -> Result<Value, String> {
    let src = assert_read_sandbox_opts(src_dir, true, false)?;
    let dst = assert_renderer_write_sandbox(dest_zip, AccessMode::Write)?;
    if normalize_lexical(&src) == normalize_lexical(&safe_data_dir()) {
        return Err("La compression complète du dossier racine GensLauncher est interdite.".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    collect_files_recursive(&src, &src, exclude, &mut files)?;
    let total = files.len().max(1);

    let file = fs::File::create(&dst).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for (idx, (path, rel)) in files.iter().enumerate() {
        zip.start_file(rel, opts).map_err(|e| e.to_string())?;
        let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        if let Some(handle) = app
            && (idx % 10 == 0 || idx + 1 == total) {
                let pct = (((idx + 1) as f64 / total as f64) * 100.0).round() as u64;
                let _ = handle.emit("zip-progress", json!({ "percent": pct }));
            }
    }
    zip.finish().map_err(|e| e.to_string())?;
    if let Some(handle) = app {
        let _ = handle.emit("zip-progress", json!({ "percent": 100 }));
    }
    Ok(json!({ "success": true }))
}

fn collect_files_recursive(
    base: &Path,
    current: &Path,
    exclude: &[String],
    out: &mut Vec<(std::path::PathBuf, String)>,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if exclude.iter().any(|ex| ex.eq_ignore_ascii_case(&name)) {
            continue;
        }
        if meta.is_dir() {
            collect_files_recursive(base, &path, exclude, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((path, rel));
        }
    }
    Ok(())
}
