# Security Model and Sandboxing

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Principle-Defense%20in%20Depth-blue.svg" alt="Defense in Depth" />
  <img src="https://img.shields.io/badge/Encryption-PBKDF2%20%2B%20AES--256--GCM-red.svg" alt="Encryption" />
  <img src="https://img.shields.io/badge/CSP-Dual--Layer-green.svg" alt="CSP" />
</div>

The design of Gens-Launcher is founded on the **Defense in Depth** principle. Multiple layered security boundaries ensure host machine protection, even if a remote resource or third-party mod contains malicious payloads.

---

## 1. Context Isolation and Sealed Exposure

- **`contextIsolation: true`**: The Javascript prototype spaces of the Main Process and Renderer Process are fully separated.
- **`nodeIntegration: false`**: Node.js core modules cannot be accessed from DOM scripts.
- **`window.api` Exposure Surface**: Only methods statically verified in `preload.js` are exposed to the user interface via `contextBridge.exposeInMainWorld`.

---

## 2. Preload Sandbox Shield (Anti-Traversal)

The `preload.js` bridge executes mathematical path boundary inspections:

```javascript
// Strict disk write boundary enforcement
function enforceSandbox(targetPath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedSandbox = path.resolve(APP_DATA_DIR);
    if (!resolvedTarget.startsWith(resolvedSandbox + path.sep) && resolvedTarget !== resolvedSandbox) {
        throw new Error("Sandbox security violation: Disk write operation outside permitted scope.");
    }
    return resolvedTarget;
}
```

- **Zip Slip Mitigation:** When extracting archives or downloaded modpacks, every extracted file path is validated before writing to disk.
- **Read Path Quarantine (`enforceReadSandbox`):** Reading outside the application directory is restricted to verified runtime paths (`.minecraft/`, identified Java directories, and authorized temporary storage). Out-of-bounds attempts fail silently to prevent information leakage.

---

## 3. Dual-Layer Content Security Policy (CSP)

A strict Content Security Policy is applied at two independent structural levels:

1. **Network Header Layer (`main.js`):**
   Injected into all BrowserWindow responses via `session.defaultSession.webRequest.onHeadersReceived`.
2. **DOM Tag Layer (`index.html`):**
   Statically embedded in the application's HTML head.

```http
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https:;
connect-src 'self' https:;
```
- **Zero `unsafe-eval`:** Dynamic string evaluation via `eval()` or `new Function()` is disallowed by the browser engine.
- **HTTPS Enforcement:** Plain HTTP requests are rejected by default.

---

## 4. Cryptographic Primitives and Key Derivation

Token persistence conforms to modern NIST and OWASP guidelines:

```
[ Master Key / Password ]
             |
             v
   +--------------------+
   |  PBKDF2 (SHA-512)  | <--- 16-byte random salt (.key_salt)
   | 600,000 iterations |
   +--------------------+
             |
             v
     [ 256-bit Key ]
             |
             v
   +--------------------+
   |    AES-256-GCM     | <--- 12-byte random initialization vector (IV)
   +--------------------+
             |
             v
 [ Ciphertext + 16-byte Authentication Tag ]
```

- **PBKDF2 Derivation:** Derived through 600,000 iterations using a dedicated 16-byte cryptographically random salt created upon first run in `.key_salt`.
- **Authenticated GCM Mode:** Validates authenticity through an authentication tag, preventing tampering or ciphertext manipulation attacks.
- **Seamless Migration:** Stored files encrypted using legacy algorithms (such as single SHA-256 keys) are silently re-encrypted to the PBKDF2/AES-GCM standard upon their first successful read.

---

## 5. Binary Magic Signature Verification

When users import custom wallpaper backgrounds or instance avatars, Gens-Launcher verifies file headers before storage:
1. The file is read directly in the Main Process (`src/main/fs-utils.js`).
2. Header **Magic Bytes** are verified:
   - **PNG:** `89 50 4E 47 0D 0A 1A 0A`
   - **JPEG:** `FF D8 FF`
   - **GIF:** `47 49 46 38`
   - **WEBP:** `52 49 46 46 ... 57 45 42 50`
   - **BMP:** `42 4D`
   - **ICO:** `00 00 01 00`
3. Files with mismatched extensions or executable binary signatures are rejected immediately.
