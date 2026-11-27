//! Crypto: Windows DPAPI (FFI crypt32.dll, 0 extra crate) + Electron AES-256-GCM + SHA-1/256/512.

use crate::encoding::{hex_decode, hex_encode};
use crate::sandbox::{safe_data_dir, write_atomic};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::fs;
use std::path::Path;

pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(blob) = dpapi_protect(plaintext.as_bytes()) {
            return Ok(format!("safeStorage:{}", hex_encode(&blob)));
        }
    }
    let key = get_or_create_pbkdf2_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut iv = [0u8; 12];
    rand::fill(&mut iv);
    let mut ciphertext = cipher
        .encrypt((&iv).into(), plaintext.as_bytes())
        .map_err(|_| "Erreur chiffrement AES-GCM".to_string())?;
    let tag_start = ciphertext.len().saturating_sub(16);
    let tag = ciphertext.split_off(tag_start);
    Ok(format!(
        "aes-gcm:{}:{}:{}",
        hex_encode(&iv),
        hex_encode(&tag),
        hex_encode(&ciphertext)
    ))
}

pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    let s = encoded.trim();
    if let Some(hex_blob) = s.strip_prefix("safeStorage:") {
        #[cfg(target_os = "windows")]
        {
            let blob = hex_decode(hex_blob)?;
            // 1. Format Chromium os_crypt v10 (Electron safeStorage sur Windows)
            if blob.len() > 3 + 12 + 16 && (&blob[0..3] == b"v10" || &blob[0..3] == b"v11")
                && let Ok(os_key) = read_chromium_os_crypt_key() {
                    let cipher = Aes256Gcm::new_from_slice(&os_key).map_err(|e| e.to_string())?;
                    let nonce: [u8; 12] = blob[3..15].try_into().map_err(|_| "Nonce invalide")?;
                    if let Ok(plain) = cipher.decrypt((&nonce).into(), &blob[15..]) {
                        return String::from_utf8(plain).map_err(|e| e.to_string());
                    }
                }
            // 2. DPAPI brut
            let plain = dpapi_unprotect(&blob)?;
            return String::from_utf8(plain).map_err(|e| e.to_string());
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = hex_blob;
            return Err("safeStorage non pris en charge hors Windows".into());
        }
    }
    if let Some(rest) = s.strip_prefix("v2:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() != 3 {
            return Err("Format v2 invalide".into());
        }
        let nonce: [u8; 12] = crate::encoding::base64_decode(parts[0])?.try_into().map_err(|_| "Nonce v2 invalide")?;
        let tag = crate::encoding::base64_decode(parts[1])?;
        let mut ct = crate::encoding::base64_decode(parts[2])?;
        ct.extend_from_slice(&tag);
        let key = read_v2_master_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let plain = cipher
            .decrypt((&nonce).into(), ct.as_ref())
            .map_err(|_| "Échec déchiffrement v2".to_string())?;
        return String::from_utf8(plain).map_err(|e| e.to_string());
    }
    if let Some(rest) = s.strip_prefix("aes-gcm:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() != 3 {
            return Err("Format aes-gcm invalide".into());
        }
        let iv: [u8; 12] = hex_decode(parts[0])?.try_into().map_err(|_| "IV invalide")?;
        let tag = hex_decode(parts[1])?;
        let mut ct = hex_decode(parts[2])?;
        ct.extend_from_slice(&tag);

        let key = get_or_create_pbkdf2_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let plain = cipher
            .decrypt((&iv).into(), ct.as_ref())
            .map_err(|_| "Échec déchiffrement AES-GCM".to_string())?;
        return String::from_utf8(plain).map_err(|e| e.to_string());
    }
    Err("Format chiffré non reconnu".into())
}

fn read_v2_master_key() -> Result<[u8; 32], String> {
    let secret_path = safe_data_dir().join(".secret_key");
    let raw = fs::read(&secret_path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    if raw.starts_with(b"DPAPI:") {
        let unp = dpapi_unprotect(&raw[6..])?;
        if unp.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&unp);
            return Ok(k);
        }
    }
    if raw.len() == 32 {
        let mut k = [0u8; 32];
        k.copy_from_slice(&raw);
        return Ok(k);
    }
    let mut h = Sha256::new();
    h.update(&raw);
    let d = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&d);
    Ok(k)
}

#[cfg(target_os = "windows")]
fn read_chromium_os_crypt_key() -> Result<[u8; 32], String> {
    let appdata = crate::sandbox::app_data_root();
    for folder in ["gens-launcher", "Gens Launcher"] {
        let ls = appdata.join(folder).join("Local State");
        if let Ok(txt) = fs::read_to_string(&ls)
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt)
                && let Some(b64) = v.pointer("/os_crypt/encrypted_key").and_then(|s| s.as_str()) {
                    let mut raw = crate::encoding::base64_decode(b64)?;
                    if raw.starts_with(b"DPAPI") {
                        raw.drain(0..5);
                    }
                    let unp = dpapi_unprotect(&raw)?;
                    if unp.len() == 32 {
                        let mut k = [0u8; 32];
                        k.copy_from_slice(&unp);
                        return Ok(k);
                    }
                }
    }
    Err("Local State Electron introuvable".into())
}

fn get_or_create_pbkdf2_key() -> Result<[u8; 32], String> {
    #[cfg(not(test))]
    {
        static CACHED_KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
        if let Some(k) = CACHED_KEY.get() {
            return Ok(*k);
        }
        let derived = derive_pbkdf2_key_from_disk()?;
        let _ = CACHED_KEY.set(derived);
        Ok(derived)
    }
    #[cfg(test)]
    {
        derive_pbkdf2_key_from_disk()
    }
}

fn derive_pbkdf2_key_from_disk() -> Result<[u8; 32], String> {
    let dir = safe_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secret_path = dir.join(".secret_key");
    let salt_path = dir.join(".key_salt");

    let secret = if secret_path.exists() {
        fs::read(&secret_path).map_err(|e| e.to_string())?
    } else {
        let mut rnd = [0u8; 32];
        rand::fill(&mut rnd);
        let hex = hex_encode(&rnd);
        write_atomic(&secret_path, hex.as_bytes())?;
        hex.into_bytes()
    };

    let salt = if salt_path.exists() {
        fs::read(&salt_path).map_err(|e| e.to_string())?
    } else {
        let mut rnd = [0u8; 16];
        rand::fill(&mut rnd);
        write_atomic(&salt_path, &rnd)?;
        rnd.to_vec()
    };

    let mut key = [0u8; 32];
    let _ = pbkdf2::<Hmac<Sha256>>(&secret, &salt, 600_000, &mut key);
    Ok(key)
}

pub fn hash_bytes(bytes: &[u8], algo: &str) -> Result<String, String> {
    match algo.to_lowercase().as_str() {
        "md5" => Ok(hex_encode(&md5_pure(bytes))),
        "sha1" => {
            let mut h = Sha1::new();
            h.update(bytes);
            Ok(hex_encode(&h.finalize()))
        }
        "sha256" => {
            let mut h = Sha256::new();
            h.update(bytes);
            Ok(hex_encode(&h.finalize()))
        }
        "sha512" => {
            let mut h = Sha512::new();
            h.update(bytes);
            Ok(hex_encode(&h.finalize()))
        }
        other => Err(format!("Algorithme non supporté: {}", other)),
    }
}

/// Pure-Rust RFC 1321 MD5 (0 external crate) — used for Minecraft OfflinePlayer UUIDs.
fn md5_pure(input: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];
    let mut msg = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]).rotate_left(S[i]));
            a = temp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

pub fn hash_file(path: &Path, algo: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    hash_bytes(&bytes, algo)
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(target_os = "windows")]
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        p_data_in: *const DataBlob,
        sz_data_descr: *const u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        p_data_in: *const DataBlob,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(h_mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut input = data.to_vec();
    let in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_mut_ptr(),
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0x1,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pb_data.is_null() {
        return Err("CryptProtectData a échoué".into());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize) };
    let res = slice.to_vec();
    unsafe { LocalFree(out_blob.pb_data as *mut _) };
    Ok(res)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut input = data.to_vec();
    let in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_mut_ptr(),
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0x1,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pb_data.is_null() {
        return Err("CryptUnprotectData a échoué".into());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize) };
    let res = slice.to_vec();
    unsafe { LocalFree(out_blob.pb_data as *mut _) };
    Ok(res)
}
