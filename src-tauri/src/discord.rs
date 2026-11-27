//! Pure-Rust Discord Rich Presence IPC client (0 external crate).
//! Supports PING/PONG/CLOSE opcodes, rate-limiting (15s), and exponential backoff.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DISCORD_CLIENT_ID: &str = "1490353507218227301";
const MAX_FRAME_LEN: usize = 1024 * 1024;
const MAX_RECONNECT_ATTEMPTS: u32 = 10;

#[cfg(target_os = "windows")]
type IpcStream = std::fs::File;
#[cfg(unix)]
type IpcStream = std::os::unix::net::UnixStream;

struct DiscordInner {
    conn: Option<IpcStream>,
    reconnect_attempts: u32,
    next_retry_at: Option<Instant>,
    last_activity_at: Option<Instant>,
}

pub struct DiscordRpc {
    inner: Mutex<DiscordInner>,
}

impl DiscordRpc {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DiscordInner {
                conn: None,
                reconnect_attempts: 0,
                next_retry_at: None,
                last_activity_at: None,
            }),
        }
    }

    pub fn connect(&self) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Mutex poisoned".to_string())?;
        guard.conn = None;
        guard.reconnect_attempts = 0;
        guard.next_retry_at = None;
        Self::connect_locked(&mut guard)
    }

    fn connect_locked(inner: &mut DiscordInner) -> Result<(), String> {
        for idx in 0..10 {
            if let Ok(mut stream) = open_ipc_socket(idx) {
                let handshake = json!({ "v": 1, "client_id": DISCORD_CLIENT_ID });
                if write_frame(&mut stream, 0, &handshake).is_ok()
                    && let Ok((op, payload)) = read_frame(&mut stream) {
                        if op == 3 {
                            // PING -> PONG
                            let _ = write_frame(&mut stream, 4, &payload);
                        } else if op == 2 {
                            // CLOSE
                            continue;
                        }
                        inner.conn = Some(stream);
                        inner.reconnect_attempts = 0;
                        inner.next_retry_at = None;
                        return Ok(());
                    }
            }
        }
        if inner.reconnect_attempts < MAX_RECONNECT_ATTEMPTS {
            let delay_secs = (5u64.saturating_mul(1u64 << inner.reconnect_attempts.min(4))).min(60);
            inner.reconnect_attempts += 1;
            inner.next_retry_at = Some(Instant::now() + Duration::from_secs(delay_secs));
        }
        Err("Discord non détecté (aucun pipe IPC actif).".into())
    }

    pub fn set_activity(&self, details: &str, state: &str) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Mutex poisoned".to_string())?;

        if guard.conn.is_none() {
            if let Some(next) = guard.next_retry_at
                && (Instant::now() < next || guard.reconnect_attempts >= MAX_RECONNECT_ATTEMPTS) {
                    return Err("Discord en attente de reconnexion (backoff).".into());
                }
            Self::connect_locked(&mut guard)?;
        }

        // Respect Discord's 15s rate limit
        if let Some(last) = guard.last_activity_at
            && last.elapsed() < Duration::from_secs(15) {
                return Ok(());
            }

        let Some(stream) = guard.conn.as_mut() else {
            return Err("Discord non connecté.".into());
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
                "activity": {
                    "details": details,
                    "state": state,
                    "timestamps": { "start": now },
                    "assets": {
                        "large_image": "gens_logo",
                        "large_text": "Gens Launcher"
                    }
                }
            },
            "nonce": format!("gens-{}", now)
        });

        if let Err(e) = write_frame(stream, 1, &payload) {
            guard.conn = None;
            return Err(e);
        }
        guard.last_activity_at = Some(Instant::now());
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn open_ipc_socket(idx: u8) -> std::io::Result<IpcStream> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!(r"\\.\pipe\discord-ipc-{}", idx))
}

#[cfg(unix)]
fn open_ipc_socket(idx: u8) -> std::io::Result<IpcStream> {
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    let tmp = std::env::var("TMPDIR")
        .or_else(|_| std::env::var("TMP"))
        .unwrap_or_else(|_| "/tmp".into());
    let mut candidates: Vec<String> = Vec::new();
    if let Some(ref x) = xdg {
        let base = x.trim_end_matches('/');
        candidates.push(format!("{}/discord-ipc-{}", base, idx));
        candidates.push(format!("{}/app/com.discordapp.Discord/discord-ipc-{}", base, idx));
        candidates.push(format!("{}/snap.discord/discord-ipc-{}", base, idx));
    }
    candidates.push(format!("{}/discord-ipc-{}", tmp.trim_end_matches('/'), idx));
    candidates.push(format!("/tmp/discord-ipc-{}", idx));

    for p in candidates {
        if let Ok(s) = std::os::unix::net::UnixStream::connect(&p) {
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
            return Ok(s);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "Discord socket not found",
    ))
}

fn write_frame<W: Write>(w: &mut W, opcode: u32, payload: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut header = [0u8; 8];
    header[0..4].copy_from_slice(&opcode.to_le_bytes());
    header[4..8].copy_from_slice(&(body.len() as u32).to_le_bytes());
    w.write_all(&header).map_err(|e| e.to_string())?;
    w.write_all(&body).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

fn read_frame<R: Read>(r: &mut R) -> Result<(u32, Value), String> {
    let mut header = [0u8; 8];
    r.read_exact(&mut header).map_err(|e| e.to_string())?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if len > MAX_FRAME_LEN {
        return Err("Frame Discord trop volumineuse".into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| e.to_string())?;
    let val = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((op, val))
}
