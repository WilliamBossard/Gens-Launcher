//! Sandboxed filesystem IPC handlers matching src/main/ipc-fs.js contract ({ ok, data, error }).

use crate::encoding::{base64_decode, base64_encode, hex_encode};
use crate::sandbox::{
    assert_read_sandbox_opts, assert_renderer_write_sandbox, copy_dir_no_symlinks,
    rename_with_retry, write_atomic, AccessMode,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::UNIX_EPOCH;

const MAX_IPC_READ_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB anti-OOM

fn ok(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn err(msg: impl Into<String>, code: Option<&str>) -> Value {
    json!({ "ok": false, "error": { "message": msg.into(), "code": code } })
}

fn validate_encoding(enc: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = enc else { return Ok(None) };
    let low = raw.to_lowercase();
    if matches!(
        low.as_str(),
        "utf8" | "utf-8" | "base64" | "hex" | "latin1" | "ascii"
    ) {
        Ok(Some(low))
    } else {
        Err(format!("Encodage non autorisé : {}", raw))
    }
}

pub fn handle_fs(channel: &str, args: &Value) -> Value {
    let a = args.as_array().map(|v| v.as_slice()).unwrap_or(&[]);
    let path_str = a.first().and_then(|v| v.as_str()).unwrap_or("");

    match channel {
        "fs:exists" => match assert_read_sandbox_opts(path_str, true, true) {
            Ok(p) => ok(json!(p.exists())),
            Err(_) => ok(json!(false)),
        },
        "fs:readFile" => {
            let p = match assert_read_sandbox_opts(path_str, true, false) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let enc = match validate_encoding(a.get(1).and_then(|v| v.as_str())) {
                Ok(e) => e,
                Err(e) => return err(e, Some("EINVAL")),
            };
            if let Ok(meta) = fs::metadata(&p)
                && meta.is_file() && meta.len() > MAX_IPC_READ_BYTES {
                    return err(
                        format!(
                            "Fichier trop volumineux pour fs:readFile ({} octets > {}). Utilisez fs:readTail.",
                            meta.len(),
                            MAX_IPC_READ_BYTES
                        ),
                        Some("EFBIG"),
                    );
                }
            match fs::read(&p) {
                Ok(bytes) => match enc.as_deref() {
                    Some("utf8") | Some("utf-8") | Some("ascii") => {
                        ok(json!(String::from_utf8_lossy(&bytes).into_owned()))
                    }
                    Some("latin1") => {
                        let s: String = bytes.iter().map(|&b| b as char).collect();
                        ok(json!(s))
                    }
                    Some("base64") => ok(json!(base64_encode(&bytes))),
                    Some("hex") => ok(json!(hex_encode(&bytes))),
                    _ => ok(json!({ "__bytes_b64": base64_encode(&bytes) })),
                },
                Err(e) => err(e.to_string(), Some("ENOENT")),
            }
        }
        "fs:readTail" => {
            let p = match assert_read_sandbox_opts(path_str, true, false) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let req = a.get(1).and_then(|v| v.as_u64()).unwrap_or(512 * 1024);
            let limit = req.clamp(1024, 2 * 1024 * 1024);
            match fs::File::open(&p) {
                Ok(mut f) => {
                    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                    let start = len.saturating_sub(limit);
                    let _ = f.seek(SeekFrom::Start(start));
                    let mut buf = Vec::new();
                    let _ = f.take(limit).read_to_end(&mut buf);
                    ok(json!(String::from_utf8_lossy(&buf).into_owned()))
                }
                Err(e) => err(e.to_string(), Some("ENOENT")),
            }
        }
        "fs:writeFile" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let data_val = a.get(1);
            let bytes: Vec<u8> = if let Some(s) = data_val.and_then(|v| v.as_str()) {
                s.as_bytes().to_vec()
            } else if let Some(b64) = data_val
                .and_then(|v| v.get("__bytes_b64"))
                .and_then(|v| v.as_str())
            {
                match base64_decode(b64) {
                    Ok(b) => b,
                    Err(e) => return err(e, Some("EINVAL")),
                }
            } else if let Some(arr) = data_val.and_then(|v| v.as_array()) {
                arr.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as u8))
                    .collect()
            } else {
                Vec::new()
            };
            match write_atomic(&p, &bytes) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e, Some("EIO")),
            }
        }
        "fs:appendFile" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let text = a.get(1).and_then(|v| v.as_str()).unwrap_or("");
            match fs::OpenOptions::new().create(true).append(true).open(&p) {
                Ok(mut f) => match f.write_all(text.as_bytes()) {
                    Ok(()) => ok(Value::Null),
                    Err(e) => err(e.to_string(), Some("EIO")),
                },
                Err(e) => err(e.to_string(), Some("EIO")),
            }
        }
        "fs:readdir" => {
            let p = match assert_read_sandbox_opts(path_str, true, false) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            match fs::read_dir(&p) {
                Ok(entries) => {
                    let names: Vec<String> = entries
                        .flatten()
                        .filter_map(|e| e.file_name().into_string().ok())
                        .collect();
                    ok(json!(names))
                }
                Err(e) => err(e.to_string(), Some("ENOENT")),
            }
        }
        "fs:stat" => {
            let p = match assert_read_sandbox_opts(path_str, true, true) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            match fs::metadata(&p) {
                Ok(m) => {
                    let mtime_ms = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let btime_ms = m
                        .created()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(mtime_ms);
                    ok(json!({
                        "isDirectory": m.is_dir(),
                        "isFile": m.is_file(),
                        "size": m.len(),
                        "mtime": mtime_ms,
                        "mtimeMs": mtime_ms,
                        "birthtime": btime_ms
                    }))
                }
                Err(e) => err(e.to_string(), Some("ENOENT")),
            }
        }
        "fs:mkdir" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            match fs::create_dir_all(&p) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e.to_string(), Some("EIO")),
            }
        }
        "fs:rm" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Delete) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            if !p.exists() {
                return ok(Value::Null);
            }
            let res = if p.is_dir() {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
            match res {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e.to_string(), Some("EIO")),
            }
        }
        "fs:unlink" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Delete) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            match fs::remove_file(&p) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e.to_string(), Some("ENOENT")),
            }
        }
        "fs:rename" => {
            let dst_str = a.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let src = match assert_renderer_write_sandbox(path_str, AccessMode::Delete) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let dst = match assert_renderer_write_sandbox(dst_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            match rename_with_retry(&src, &dst) {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e, Some("EIO")),
            }
        }
        "fs:copyFile" => {
            let dst_str = a.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let src = match assert_read_sandbox_opts(path_str, true, false) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let dst = match assert_renderer_write_sandbox(dst_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            if let Some(parent) = dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::copy(&src, &dst) {
                Ok(_) => ok(Value::Null),
                Err(e) => err(e.to_string(), Some("EIO")),
            }
        }
        "fs:cp" => {
            let dst_str = a.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let src = match assert_read_sandbox_opts(path_str, true, false) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            let dst = match assert_renderer_write_sandbox(dst_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            if let Ok(meta) = fs::symlink_metadata(&src)
                && meta.file_type().is_symlink() {
                    return err("Copie de lien symbolique bloquée (dereference: false).", Some("EACCES"));
                }
            let res = if src.is_dir() {
                copy_dir_no_symlinks(&src, &dst)
            } else {
                fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
            };
            match res {
                Ok(()) => ok(Value::Null),
                Err(e) => err(e, Some("EIO")),
            }
        }
        "fs:access" => match assert_read_sandbox_opts(path_str, true, true) {
            Ok(p) if p.exists() => ok(Value::Null),
            Ok(_) => err("Fichier introuvable", Some("ENOENT")),
            Err(e) => err(e, Some("EACCES")),
        },
        "fs:chmod" => {
            let p = match assert_renderer_write_sandbox(path_str, AccessMode::Write) {
                Ok(p) => p,
                Err(e) => return err(e, Some("EACCES")),
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = a
                    .get(1)
                    .and_then(|v| v.as_u64())
                    .or_else(|| {
                        a.get(1)
                            .and_then(|v| v.as_str())
                            .and_then(|s| u64::from_str_radix(s.trim_start_matches("0o"), 8).ok())
                    })
                    .unwrap_or(0o644) as u32;
                match fs::set_permissions(&p, fs::Permissions::from_mode(mode & 0o777)) {
                    Ok(()) => ok(Value::Null),
                    Err(e) => err(e.to_string(), Some("EIO")),
                }
            }
            #[cfg(not(unix))]
            {
                let _ = p;
                ok(Value::Null)
            }
        }
        _ => err(format!("Canal fs inconnu: {}", channel), Some("EINVAL")),
    }
}
