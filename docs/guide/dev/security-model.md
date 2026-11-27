# Security Model and Sandboxing

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Principle-Defense%20in%20Depth-blue.svg" alt="Defense in Depth" />
  <img src="https://img.shields.io/badge/Encryption-DPAPI%20%2B%20AES--256--GCM-red.svg" alt="Encryption" />
  <img src="https://img.shields.io/badge/CSP-Strict%20Tauri%20v2-green.svg" alt="CSP" />
</div>

The design of Gens-Launcher is founded on the **Defense in Depth** principle. Multiple layered security boundaries in Rust (`src-tauri/src/`) and Tauri v2 ensure host machine protection, even if a remote resource or third-party mod contains malicious payloads.

---

## 1. Native WebView Isolation & Sealed Exposure

- **Zero Node.js Runtime in UI:** The frontend runs inside the OS WebView with no direct access to the filesystem, environment, or shell.
- **Static IPC Whitelist (`frontend/src/tauri-bridge.js`):** Only channels explicitly listed in `VALID_SEND_CHANNELS`, `VALID_INVOKE_CHANNELS`, and `VALID_RECEIVE_CHANNELS` can be invoked.
- **Scoped Asset Protocol (`tauri.conf.json`):** `asset://` file serving is strictly confined to `$APPDATA/GensLauncher/**`.

---

## 2. Rust Sandbox Shield (Anti-Traversal & Anti-Symlink)

Every filesystem and archive operation is validated in `src-tauri/src/sandbox.rs`:

- **Lexical + Canonical Verification:** Paths are normalized lexically and verified via canonical `realpath` resolution to defeat `..` traversal, symlinks, Windows junctions, and UNC shares (`\\server\share`).
- **Write Confinement:** Disk writes are strictly restricted to `$APPDATA/GensLauncher`.
- **Renderer Denylist:** Sensitive files (`.secret_key`, `.key_salt`, `horizon_seal.key`, `trusted_external_domains.json`, `github_release_cache.json`) and protected roots (`horizon`, `bin`, `java`, `runtime`, `msa-cache`) cannot be modified or deleted by the renderer.
- **Zip-Slip & Tar-Slip Mitigation (`archive.rs`):** Every archive entry is checked against `dst`, Unix symlinks (`0o120000`) and hardlinks are rejected, and total uncompressed extraction is capped at 4 GiB (anti-Zip-Bomb).

---

## 3. Strict Content Security Policy (CSP)

Enforced globally by Tauri v2 in `src-tauri/tauri.conf.json`:

- `script-src 'self'` and `style-src 'self'` (zero `unsafe-inline` or `unsafe-eval`).
- `object-src 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.
- Explicit HTTPS domain allowlists for `img-src` and `connect-src` (Modrinth, CurseForge, Mojang, Fabric, Quilt, Forge, NeoForge, Adoptium, GitHub).

---

## 4. Cryptographic Primitives and Electron Migration (`crypto.rs`)

Token persistence conforms to modern NIST and OWASP guidelines:

```text
[ Windows ] -> CryptProtectData (DPAPI) -> safeStorage:<hex>
               (also decrypts legacy Chromium/Electron Local State os_crypt v10/v11)

[ Fallback / Cross-OS ]
   .secret_key + 16-byte random .key_salt
                     |
                     v
       +--------------------------+
       |  PBKDF2-HMAC-SHA256      |
       |  600,000 iterations      |
       +--------------------------+
                     |
                     v
             [ 256-bit Key ]
                     |
                     v
       +--------------------------+
       |  AES-256-GCM (12B nonce) |
       +--------------------------+
                     |
                     v
   aes-gcm:<iv>:<tag>:<ciphertext>
```

- **Windows Migration:** Existing Windows Electron users retain their Microsoft sessions automatically via `read_chromium_os_crypt_key()` + DPAPI.
- **Authenticated GCM Mode:** Validates integrity via a 16-byte authentication tag, rejecting tampered ciphertexts.

---

## 5. JVM, Download & Upload Hardening

- **JVM & Launch Argument Guard (`game_validation.rs`):** Blocks dangerous JVM flags (`-javaagent`, `-agentlib`, `-XX:OnOutOfMemoryError`, `--add-opens`, `-Djava.security.policy`, etc.) and sensitive Minecraft flags (`--accessToken`, `--proxyHost`).
- **HTTPS Domain Allowlists:** Remote downloads enforce `https:` and trusted domains; multi-tenant hosts (`github.com`, `gitlab.com`) require cryptographic hash verification.
- **Binary Magic Bytes Verification (`network.rs`):** Uploaded wallpapers, icons, and archives are validated by both extension and binary header signature (`PNG`, `JPEG`, `GIF`, `WEBP`, `BMP`, `ICO`, `ZIP`) before entering the sandbox.
