//! Pure-Rust Minecraft Server List Ping (TCP + VarInt + anti-SSRF + MOTD HTML, 0 extra crate).

use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream};

const MAX_PACKET_LEN: usize = 2 * 1024 * 1024;

pub fn is_private_or_reserved_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || o[0] >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_or_reserved_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

pub fn parse_address(raw: &str) -> (String, u16) {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix('[')
        && let Some(end) = rest.find(']') {
            let host = rest[..end].to_string();
            let port = rest[end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(25565);
            return (host, port);
        }
    if let Some(idx) = s.rfind(':')
        && s.find(':') == Some(idx)
            && let Ok(port) = s[idx + 1..].parse::<u16>() {
                return (s[..idx].to_string(), port);
            }
    (s.to_string(), 25565)
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn mc_color_class(code: &str) -> Option<&'static str> {
    match code {
        "0" | "black" => Some("mc-c-black"),
        "1" | "dark_blue" => Some("mc-c-dark_blue"),
        "2" | "dark_green" => Some("mc-c-dark_green"),
        "3" | "dark_aqua" => Some("mc-c-dark_aqua"),
        "4" | "dark_red" => Some("mc-c-dark_red"),
        "5" | "dark_purple" => Some("mc-c-dark_purple"),
        "6" | "gold" => Some("mc-c-gold"),
        "7" | "gray" => Some("mc-c-gray"),
        "8" | "dark_gray" => Some("mc-c-dark_gray"),
        "9" | "blue" => Some("mc-c-blue"),
        "a" | "green" => Some("mc-c-green"),
        "b" | "aqua" => Some("mc-c-aqua"),
        "c" | "red" => Some("mc-c-red"),
        "d" | "light_purple" => Some("mc-c-light_purple"),
        "e" | "yellow" => Some("mc-c-yellow"),
        "f" | "white" => Some("mc-c-white"),
        _ => None,
    }
}

fn render_legacy_text(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    let mut open_span = false;
    while let Some(c) = chars.next() {
        if c == '§' {
            if let Some(code) = chars.next() {
                let low = code.to_ascii_lowercase().to_string();
                if let Some(cls) = mc_color_class(&low) {
                    if open_span {
                        out.push_str("</span>");
                    }
                    out.push_str(&format!("<span class=\"{}\">", cls));
                    open_span = true;
                } else if low == "l" {
                    out.push_str("<span class=\"mc-bold\">");
                    open_span = true;
                } else if low == "o" {
                    out.push_str("<span class=\"mc-italic\">");
                    open_span = true;
                } else if low == "n" {
                    out.push_str("<span class=\"mc-underlined\">");
                    open_span = true;
                } else if low == "m" {
                    out.push_str("<span class=\"mc-strikethrough\">");
                    open_span = true;
                } else if low == "r" && open_span {
                    out.push_str("</span>");
                    open_span = false;
                }
            }
        } else if c == '\n' || c == '\r' {
            out.push(' ');
        } else {
            out.push_str(&escape_html(&c.to_string()));
        }
    }
    if open_span {
        out.push_str("</span>");
    }
    out
}

pub fn parse_motd_html(comp: &Value) -> String {
    match comp {
        Value::String(s) => render_legacy_text(s),
        Value::Array(arr) => arr.iter().map(parse_motd_html).collect::<Vec<_>>().join(""),
        Value::Object(map) => {
            let mut classes: Vec<&str> = Vec::new();
            let mut rgb_attr = String::new();
            if let Some(col) = map.get("color").and_then(|v| v.as_str()) {
                let c = col.trim();
                if let Some(cls) = mc_color_class(c) {
                    classes.push(cls);
                } else if c.starts_with('#') && c.len() <= 9 {
                    rgb_attr = format!(" data-mc-rgb=\"{}\"", escape_html(c));
                }
            }
            if map.get("bold").and_then(|v| v.as_bool()) == Some(true) {
                classes.push("mc-bold");
            }
            if map.get("italic").and_then(|v| v.as_bool()) == Some(true) {
                classes.push("mc-italic");
            }
            if map.get("underlined").and_then(|v| v.as_bool()) == Some(true) {
                classes.push("mc-underlined");
            }
            if map.get("strikethrough").and_then(|v| v.as_bool()) == Some(true) {
                classes.push("mc-strikethrough");
            }
            let mut inner = String::new();
            if let Some(txt) = map.get("text").and_then(|v| v.as_str()) {
                inner.push_str(&render_legacy_text(txt));
            }
            if let Some(extra) = map.get("extra").and_then(|v| v.as_array()) {
                for child in extra {
                    inner.push_str(&parse_motd_html(child));
                }
            }
            if classes.is_empty() && rgb_attr.is_empty() {
                inner
            } else {
                let cls_attr = if classes.is_empty() {
                    String::new()
                } else {
                    format!(" class=\"{}\"", classes.join(" "))
                };
                format!("<span{}{}>{}</span>", cls_attr, rgb_attr, inner)
            }
        }
        _ => String::new(),
    }
}

pub async fn ping_server(raw_address: &str) -> Result<Value, String> {
    if raw_address.trim().is_empty() {
        return Err("Adresse de serveur vide.".into());
    }
    let (host, port) = parse_address(raw_address);
    let addrs: Vec<SocketAddr> = lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("DNS échoué pour {}: {}", host, e))?
        .collect();

    if addrs.is_empty() {
        return Err("Aucune IP trouvée.".into());
    }
    for a in &addrs {
        if is_private_or_reserved_ip(a.ip()) {
            return Err(format!("Ping SSRF bloqué vers IP privée : {}", a.ip()));
        }
    }

    let start = Instant::now();
    let mut stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(addrs[0]))
        .await
        .map_err(|_| "Timeout connexion serveur".to_string())?
        .map_err(|e| e.to_string())?;
    let latency_ms = start.elapsed().as_millis() as u64;

    let mut hs = Vec::new();
    write_varint(&mut hs, 0x00);
    write_varint(&mut hs, 767);
    write_mc_string(&mut hs, &host);
    hs.push((port >> 8) as u8);
    hs.push((port & 0xff) as u8);
    write_varint(&mut hs, 1);
    write_packet(&mut stream, &hs).await?;
    write_packet(&mut stream, &[0x00]).await?;

    let packet_len = read_varint(&mut stream).await? as usize;
    if packet_len == 0 || packet_len > MAX_PACKET_LEN {
        return Err("Réponse serveur invalide.".into());
    }
    let packet_id = read_varint(&mut stream).await?;
    if packet_id != 0x00 {
        return Err(format!("Packet ID inattendu: {}", packet_id));
    }
    let json_len = read_varint(&mut stream).await? as usize;
    if json_len > MAX_PACKET_LEN {
        return Err("JSON serveur trop volumineux.".into());
    }
    let mut buf = vec![0u8; json_len];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut buf))
        .await
        .map_err(|_| "Timeout lecture serveur".to_string())?
        .map_err(|e| e.to_string())?;

    let parsed: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    let online = parsed.pointer("/players/online").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
    let max = parsed.pointer("/players/max").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
    let favicon = parsed.get("favicon").and_then(|v| v.as_str()).unwrap_or("");
    let description = parsed.get("description").cloned().unwrap_or(Value::String(String::new()));
    let motd_html = parse_motd_html(&description);

    // Format exact attendu par src/ui/ServerUI.js
    Ok(json!({
        "success": true,
        "data": {
            "online": true,
            "icon": favicon,
            "motd": { "html": motd_html },
            "players": { "online": online, "max": max },
            "latency": latency_ms
        }
    }))
}

fn write_varint(out: &mut Vec<u8>, mut v: u32) {
    while (v & !0x7f) != 0 {
        out.push(((v & 0x7f) | 0x80) as u8);
        v >>= 7;
    }
    out.push(v as u8);
}

fn write_mc_string(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    write_varint(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}

async fn write_packet(stream: &mut TcpStream, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 5);
    write_varint(&mut frame, payload.len() as u32);
    frame.extend_from_slice(payload);
    stream.write_all(&frame).await.map_err(|e| e.to_string())
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32, String> {
    let mut num_read = 0u32;
    let mut result = 0i32;
    loop {
        let mut b = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut b))
            .await
            .map_err(|_| "Timeout VarInt".to_string())?
            .map_err(|e| e.to_string())?;
        let val = (b[0] & 0x7f) as i32;
        result |= val << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return Err("VarInt trop long".into());
        }
        if (b[0] & 0x80) == 0 {
            break;
        }
    }
    Ok(result)
}
