//! HTTPS client, streamed & hash-verified downloads with domain allowlist,
//! Modrinth/CurseForge/Mojang proxies & Microsoft OAuth + Refresh.

use crate::crypto::{decrypt_string, encrypt_string};
use crate::encoding::{base64_decode, base64_encode, hex_encode};
use crate::game_validation::{
    assert_allowed_https_url, is_allowed_domain, ALLOWED_DOWNLOAD_DOMAINS, MULTI_TENANT_DOMAINS,
};
use crate::sandbox::{
    assert_renderer_write_sandbox, rename_with_retry, safe_data_dir, write_atomic, AccessMode,
};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MS_CLIENT_ID: &str = "00000000402b5328";
const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

pub fn build_http_client() -> Client {
    Client::builder()
        .user_agent(format!(
            "WilliamBossard/Gens-Launcher ({})",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("reqwest client")
}

fn gen_uuid_v4() -> String {
    let mut b = [0u8; 16];
    rand::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex_encode(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

enum StreamHasher {
    Sha1(Sha1),
    Sha256(Sha256),
    Sha512(Sha512),
}

impl StreamHasher {
    fn new(algo: &str) -> Self {
        match algo.to_lowercase().as_str() {
            "sha1" => Self::Sha1(Sha1::new()),
            "sha512" => Self::Sha512(Sha512::new()),
            _ => Self::Sha256(Sha256::new()),
        }
    }
    fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha1(h) => h.update(data),
            Self::Sha256(h) => h.update(data),
            Self::Sha512(h) => h.update(data),
        }
    }
    fn finalize_hex(self) -> String {
        match self {
            Self::Sha1(h) => hex_encode(&h.finalize()),
            Self::Sha256(h) => hex_encode(&h.finalize()),
            Self::Sha512(h) => hex_encode(&h.finalize()),
        }
    }
}

pub async fn download_file_stream(
    app: &AppHandle,
    client: &Client,
    payload: &Value,
) -> Result<Value, String> {
    let url_str = payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("URL manquante")?;
    let dest = payload
        .get("destPath")
        .and_then(|v| v.as_str())
        .ok_or("destPath manquant")?;

    let parsed = assert_allowed_https_url(url_str, "download-file-stream", ALLOWED_DOWNLOAD_DOMAINS)?;
    let host = parsed.host_str().unwrap_or("");
    let expected_hash = payload
        .get("expectedHash")
        .or_else(|| payload.get("expectedSha256"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    if is_allowed_domain(host, MULTI_TENANT_DOMAINS) && expected_hash.is_none() {
        return Err(format!(
            "Empreinte cryptographique requise pour les téléchargements depuis un hôte multi-locataire ({}).",
            host
        ));
    }

    let safe_dest = assert_renderer_write_sandbox(dest, AccessMode::Write)?;
    let hash_algo = payload
        .get("hashAlgo")
        .and_then(|v| v.as_str())
        .unwrap_or("sha256");
    let max_bytes = payload
        .get("maxBytes")
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_MAX_DOWNLOAD_BYTES);
    let progress_id = payload
        .get("progressId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let resp = client.get(url_str).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    // Re-verify final URL host after redirects
    if let Some(final_host) = resp.url().host_str()
        && (resp.url().scheme() != "https" || !is_allowed_domain(final_host, ALLOWED_DOWNLOAD_DOMAINS)) {
            return Err(format!("Redirection vers un domaine non autorisé bloquée ({}).", final_host));
        }

    let total_bytes = resp.content_length().unwrap_or(0);
    if total_bytes > max_bytes {
        return Err(format!(
            "Fichier trop volumineux ({} octets > limite {} octets).",
            total_bytes, max_bytes
        ));
    }

    if let Some(parent) = safe_dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = safe_dest.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut hasher = expected_hash.as_ref().map(|_| StreamHasher::new(hash_algo));
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&tmp_path);
                return Err(e.to_string());
            }
        };
        received = received.saturating_add(chunk.len() as u64);
        if received > max_bytes {
            drop(file);
            let _ = fs::remove_file(&tmp_path);
            return Err(format!(
                "Téléchargement interrompu : taille maximale dépassée (> {} octets).",
                max_bytes
            ));
        }
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&tmp_path);
            return Err(e.to_string());
        }
        if let Some(ref mut h) = hasher {
            h.update(&chunk);
        }
        if !progress_id.is_empty()
            && (last_emit.elapsed() >= Duration::from_millis(120)
                || (total_bytes > 0 && received >= total_bytes))
        {
            last_emit = Instant::now();
            let percent = if total_bytes > 0 {
                ((received as f64 / total_bytes as f64) * 100.0).min(100.0).round() as u64
            } else {
                0
            };
            let _ = app.emit(
                "download-progress",
                json!({
                    "progressId": progress_id,
                    "receivedBytes": received,
                    "totalBytes": total_bytes,
                    "percent": percent
                }),
            );
        }
    }
    drop(file);

    if let (Some(h), Some(exp)) = (hasher, expected_hash) {
        let actual = h.finalize_hex();
        if actual != exp {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Empreinte {} invalide", hash_algo));
        }
    }

    if let Err(e) = rename_with_retry(&tmp_path, &safe_dest) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if !progress_id.is_empty() {
        let _ = app.emit(
            "download-progress",
            json!({
                "progressId": progress_id,
                "receivedBytes": received,
                "totalBytes": if total_bytes > 0 { total_bytes } else { received },
                "percent": 100
            }),
        );
    }
    Ok(json!({ "success": true }))
}

pub async fn search_modrinth(client: &Client, url: &str) -> Result<Value, String> {
    let full = if url.starts_with("http") {
        url.to_string()
    } else {
        format!("https://{}", url)
    };
    let parsed = match url::Url::parse(&full) {
        Ok(u) if u.scheme() == "https" && u.host_str() == Some("api.modrinth.com") => u,
        _ => return Ok(json!({ "success": false, "error": "Domaine Modrinth non autorisé" })),
    };
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok(json!({ "success": status < 400, "status": status, "data": data }))
}

pub async fn fetch_curseforge(client: &Client, payload: &Value) -> Result<Value, String> {
    let url_str = payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("URL manquante")?;
    let api_key = payload
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let parsed = match url::Url::parse(url_str) {
        Ok(u) if u.scheme() == "https" && u.host_str() == Some("api.curseforge.com") => u,
        _ => return Ok(json!({ "success": false, "error": "URL CurseForge non autorisée" })),
    };
    let method = payload
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET");
    let mut req = if method.eq_ignore_ascii_case("POST") {
        client.post(parsed)
    } else {
        client.get(parsed)
    };
    req = req
        .header("x-api-key", api_key.trim())
        .header("Accept", "application/json");
    if let Some(body) = payload.get("body")
        && !body.is_null() {
            req = req.json(body);
        }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok(json!({ "success": status < 400, "status": status, "data": data }))
}

pub async fn fetch_mojang_raw_skin(client: &Client, payload: &Value) -> Result<Value, String> {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let uuid = payload.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
    let target = if !uuid.is_empty() { uuid } else { name };
    if target.is_empty()
        || !target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Ok(json!({ "success": false }));
    }
    let url = format!("https://mc-heads.net/skin/{}", target);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(json!({ "success": false }));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "data": base64_encode(&bytes) }))
}

pub async fn fetch_mojang_profile(client: &Client, payload: &Value) -> Result<Value, String> {
    let token = payload.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if token.is_empty() {
        return Ok(json!({ "success": false, "error": "Jeton manquant" }));
    }
    let resp = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(json!({ "success": false, "error": format!("HTTP {}", resp.status()) }));
    }
    let profile: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "profile": profile, "data": profile }))
}

pub async fn upload_mojang_skin(client: &Client, payload: &Value) -> Result<Value, String> {
    let token = payload
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or("accessToken manquant")?;
    let variant = payload
        .get("variant")
        .and_then(|v| v.as_str())
        .unwrap_or("classic");
    let png_bytes: Vec<u8> = if let Some(s) = payload.get("skinData").and_then(|v| v.as_str()) {
        base64_decode(s.split(',').next_back().unwrap_or(s))?
    } else if let Some(arr) = payload.get("skinData").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|x| x.as_u64().map(|n| n as u8))
            .collect()
    } else if let Some(b64) = payload
        .pointer("/skinData/__bytes_b64")
        .and_then(|v| v.as_str())
    {
        base64_decode(b64)?
    } else {
        return Ok(json!({ "success": false, "error": "skinData invalide" }));
    };

    let boundary = "----GensLauncherSkinBoundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{}\r\n",
            boundary, variant
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n",
            boundary
        )
        .as_bytes(),
    );
    body.extend_from_slice(&png_bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let resp = client
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(token)
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "success": resp.status().is_success(), "status": resp.status().as_u16() }))
}

async fn exchange_ms_token_for_mc(
    client: &Client,
    ms_access_token: &str,
) -> Result<(String, String, String, u64), String> {
    let xbl: Value = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={}", ms_access_token) },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let xbl_tok = xbl
        .get("Token")
        .and_then(|v| v.as_str())
        .ok_or("XBL Token manquant")?;
    let uhs = xbl
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(|v| v.as_str())
        .ok_or("UHS manquant")?;

    let xsts: Value = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_tok] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let xsts_tok = xsts
        .get("Token")
        .and_then(|v| v.as_str())
        .ok_or("XSTS Token manquant")?;

    let mc: Value = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&json!({ "identityToken": format!("XBL3.0 x={};{}", uhs, xsts_tok) }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mc_token = mc
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("MC access_token manquant")?
        .to_string();
    let expires_in = mc.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(86400);

    let profile: Value = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&mc_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let name = profile
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Profil Minecraft introuvable")?
        .to_string();
    let uuid = profile
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("UUID Minecraft introuvable")?
        .to_string();
    Ok((mc_token, name, uuid, expires_in))
}

pub async fn login_microsoft(
    app: &AppHandle,
    client: &Client,
    cancel_flag: &AtomicBool,
) -> Result<Value, String> {
    cancel_flag.store(false, Ordering::SeqCst);
    let dc_resp: Value = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .form(&[
            ("client_id", MS_CLIENT_ID),
            ("scope", "XboxLive.signin offline_access"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let user_code = dc_resp
        .get("user_code")
        .and_then(|v| v.as_str())
        .ok_or("user_code manquant")?
        .to_string();
    let device_code = dc_resp
        .get("device_code")
        .and_then(|v| v.as_str())
        .ok_or("device_code manquant")?
        .to_string();
    let verification_uri = dc_resp
        .get("verification_uri")
        .and_then(|v| v.as_str())
        .unwrap_or("https://www.microsoft.com/link")
        .to_string();
    let message = dc_resp
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut interval = dc_resp.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);

    let _ = app.emit(
        "microsoft-device-code",
        json!({
            "message": message,
            "user_code": user_code,
            "verification_uri": verification_uri,
            "expires_in": 900
        }),
    );

    let mut ms_token = String::new();
    let mut refresh_token = String::new();
    for _ in 0..90 {
        for _ in 0..(interval * 4) {
            if cancel_flag.load(Ordering::SeqCst) {
                return Ok(json!({ "success": false, "cancelled": true }));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let resp = match client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", MS_CLIENT_ID),
                ("device_code", device_code.as_str()),
            ])
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue, // tolerate transient network blip
        };
        let Ok(tok) = resp.json::<Value>().await else {
            continue;
        };

        if let Some(at) = tok.get("access_token").and_then(|v| v.as_str()) {
            ms_token = at.to_string();
            refresh_token = tok
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            break;
        }
        let err = tok.get("error").and_then(|v| v.as_str()).unwrap_or("");
        if err == "slow_down" {
            interval = (interval + 5).min(30);
        } else if err != "authorization_pending" {
            return Ok(json!({ "success": false, "error": err }));
        }
    }
    if ms_token.is_empty() {
        return Ok(json!({ "success": false, "error": "Timeout Microsoft OAuth" }));
    }

    let (mc_token, name, uuid, expires_in) = exchange_ms_token_for_mc(client, &ms_token).await?;
    let session_label = format!("gens-{}", gen_uuid_v4());
    if !refresh_token.is_empty()
        && let Ok(enc) = encrypt_string(&refresh_token) {
            let cache_path = safe_data_dir()
                .join("msa-cache")
                .join(format!("{}.json", session_label));
            let _ = write_atomic(
                &cache_path,
                json!({ "refreshToken": enc }).to_string().as_bytes(),
            );
        }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let expires_at = now_ms + expires_in * 1000;

    Ok(json!({
        "success": true,
        "auth": {
            "access_token": mc_token,
            "client_token": gen_uuid_v4(),
            "uuid": uuid,
            "name": name,
            "user_properties": {},
            "meta": {
                "type": "msa",
                "demo": false,
                "msaCacheKey": session_label,
                "expiresAt": expires_at
            }
        }
    }))
}

pub async fn refresh_microsoft(client: &Client, session_label: &str) -> Result<Value, String> {
    if !session_label.starts_with("gens-")
        || session_label.contains("..")
        || session_label.contains('/')
        || session_label.contains('\\')
    {
        return Ok(json!({ "success": false, "error": "Identifiant de session invalide." }));
    }
    let cache_path = safe_data_dir()
        .join("msa-cache")
        .join(format!("{}.json", session_label));
    let raw = match fs::read_to_string(&cache_path) {
        Ok(s) => s,
        Err(_) => {
            return Ok(json!({ "success": false, "error": "EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN" }));
        }
    };
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let enc = parsed
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let refresh_tok = match decrypt_string(enc) {
        Ok(t) => t,
        Err(_) => {
            return Ok(json!({ "success": false, "error": "EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN" }));
        }
    };

    let tok: Value = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", MS_CLIENT_ID),
            ("refresh_token", refresh_tok.as_str()),
            ("scope", "XboxLive.signin offline_access"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let Some(ms_access) = tok.get("access_token").and_then(|v| v.as_str()) else {
        return Ok(json!({ "success": false, "error": "EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN" }));
    };
    // Only overwrite refresh_token when Microsoft returns a new non-empty one
    if let Some(new_ref) = tok
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        && let Ok(enc_new) = encrypt_string(new_ref) {
            let _ = write_atomic(
                &cache_path,
                json!({ "refreshToken": enc_new }).to_string().as_bytes(),
            );
        }

    let (mc_token, _name, _uuid, expires_in) = exchange_ms_token_for_mc(client, ms_access).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(json!({
        "success": true,
        "access_token": mc_token,
        "expiresAt": now_ms + expires_in * 1000
    }))
}

pub fn delete_msa_cache(session_label: &str) -> Value {
    if !session_label.starts_with("gens-")
        || session_label.contains("..")
        || session_label.contains('/')
        || session_label.contains('\\')
    {
        return json!({ "success": false, "error": "Label invalide" });
    }
    let cache_path = safe_data_dir()
        .join("msa-cache")
        .join(format!("{}.json", session_label));
    let _ = fs::remove_file(cache_path);
    json!({ "success": true })
}

pub async fn check_internet(client: &Client) -> Value {
    let ok = client
        .head("https://launchercontent.mojang.com/v2/news.json")
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    json!(ok)
}

const MAX_UPLOAD_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25 MiB
const MAX_UPLOAD_FILE_BYTES: usize = 512 * 1024 * 1024; // 512 MiB
const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico"];
const ALLOWED_IMPORT_EXTS: &[&str] = &["zip", "mrpack", "jar"];

pub fn is_valid_image_magic(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return true;
    }
    // JPEG: FF D8 FF
    if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return true;
    }
    // GIF: GIF87a / GIF89a
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return true;
    }
    // WEBP: RIFF....WEBP
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }
    // BMP: BM
    if &bytes[..2] == b"BM" {
        return true;
    }
    // ICO: 00 00 01 00
    if bytes[..4] == [0x00, 0x00, 0x01, 0x00] {
        return true;
    }
    false
}

pub fn is_valid_zip_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == 0x50
        && bytes[1] == 0x4B
        && ((bytes[2] == 0x03 && bytes[3] == 0x04) || (bytes[2] == 0x05 && bytes[3] == 0x06))
}

fn sanitize_sandbox_dest_name(dest_name: &str) -> Result<String, String> {
    let base = std::path::Path::new(dest_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '(' | ')' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(200)
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("Nom de fichier de destination invalide.".into());
    }
    Ok(cleaned)
}

fn validate_ext_for_kind(name_or_path: &str, is_image: bool) -> Result<(), String> {
    let ext = std::path::Path::new(name_or_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let allowed = if is_image {
        ALLOWED_IMAGE_EXTS
    } else {
        ALLOWED_IMPORT_EXTS
    };
    if !allowed.contains(&ext.as_str()) {
        return Err(if is_image {
            format!("Extension d'image non autorisée (.{}).", ext)
        } else {
            format!("Extension de fichier non autorisée pour l'import (.{}).", ext)
        });
    }
    Ok(())
}

pub fn save_temp_copy(
    src: &str,
    dest_name: &str,
    sub_dir: &str,
    is_image: bool,
) -> Result<Value, String> {
    use std::io::Read;
    let trimmed = src.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Chemin source invalide.".into());
    }
    if crate::sandbox::is_unc_path(trimmed) {
        return Err("Accès aux partages réseau UNC bloqué.".into());
    }
    validate_ext_for_kind(trimmed, is_image)?;

    let src_path = std::path::Path::new(trimmed);
    let lstat = fs::symlink_metadata(src_path).map_err(|_| "Fichier source introuvable.")?;
    if lstat.file_type().is_symlink() || !lstat.is_file() {
        return Err("Le chemin source n'est pas un fichier régulier.".into());
    }
    let max_bytes = if is_image {
        MAX_UPLOAD_IMAGE_BYTES as u64
    } else {
        MAX_UPLOAD_FILE_BYTES as u64
    };
    if lstat.len() > max_bytes {
        return Err("Fichier source trop volumineux.".into());
    }
    let real_src = fs::canonicalize(src_path).map_err(|e| e.to_string())?;
    let norm_src = crate::sandbox::normalize_lexical(src_path);
    let norm_real = crate::sandbox::normalize_lexical(&real_src);
    let same = {
        #[cfg(target_os = "windows")]
        {
            norm_src
                .to_string_lossy()
                .eq_ignore_ascii_case(&norm_real.to_string_lossy())
        }
        #[cfg(not(target_os = "windows"))]
        {
            norm_src == norm_real
        }
    };
    if !same {
        return Err("Lien symbolique ou jonction détecté dans le chemin source.".into());
    }

    let mut header = [0u8; 16];
    let mut f = fs::File::open(&real_src).map_err(|e| e.to_string())?;
    let n = f.read(&mut header).map_err(|e| e.to_string())?;
    let valid_magic = if is_image {
        is_valid_image_magic(&header[..n])
    } else {
        is_valid_zip_magic(&header[..n])
    };
    if !valid_magic {
        return Err(if is_image {
            "Signature binaire d'image invalide (Magic Bytes).".into()
        } else {
            "Signature d'archive ZIP/JAR invalide.".into()
        });
    }

    let dir = if sub_dir.is_empty() {
        safe_data_dir()
    } else {
        safe_data_dir().join(sub_dir)
    };
    let safe_dir = assert_renderer_write_sandbox(&dir.to_string_lossy(), AccessMode::Write)?;
    fs::create_dir_all(&safe_dir).map_err(|e| e.to_string())?;
    let safe_name = sanitize_sandbox_dest_name(dest_name)?;
    let dst = assert_renderer_write_sandbox(
        &safe_dir.join(&safe_name).to_string_lossy(),
        AccessMode::Write,
    )?;
    fs::copy(&real_src, &dst).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "destPath": dst.to_string_lossy(), "path": dst.to_string_lossy() }))
}

pub fn save_uploaded_bytes(
    bytes_b64: &str,
    dest_name: &str,
    sub_dir: &str,
    is_image: bool,
) -> Result<Value, String> {
    let max_bytes = if is_image {
        MAX_UPLOAD_IMAGE_BYTES
    } else {
        MAX_UPLOAD_FILE_BYTES
    };
    // Base64 expands by ~4/3; reject oversized payloads before allocating
    let max_b64_len = (max_bytes / 3 + 2) * 4;
    if bytes_b64.len() > max_b64_len {
        return Err("Fichier envoyé trop volumineux.".into());
    }
    let safe_name = sanitize_sandbox_dest_name(dest_name)?;
    validate_ext_for_kind(&safe_name, is_image)?;

    let bytes = base64_decode(bytes_b64)?;
    if bytes.len() > max_bytes {
        return Err("Fichier envoyé trop volumineux.".into());
    }
    let valid_magic = if is_image {
        is_valid_image_magic(&bytes)
    } else {
        is_valid_zip_magic(&bytes)
    };
    if !valid_magic {
        return Err(if is_image {
            "Signature binaire d'image invalide (Magic Bytes).".into()
        } else {
            "Signature d'archive ZIP/JAR invalide.".into()
        });
    }

    let dir = if sub_dir.is_empty() {
        safe_data_dir()
    } else {
        safe_data_dir().join(sub_dir)
    };
    let safe_dir = assert_renderer_write_sandbox(&dir.to_string_lossy(), AccessMode::Write)?;
    fs::create_dir_all(&safe_dir).map_err(|e| e.to_string())?;
    let dst = assert_renderer_write_sandbox(
        &safe_dir.join(&safe_name).to_string_lossy(),
        AccessMode::Write,
    )?;
    write_atomic(&dst, &bytes)?;
    Ok(json!({ "success": true, "destPath": dst.to_string_lossy(), "path": dst.to_string_lossy() }))
}
