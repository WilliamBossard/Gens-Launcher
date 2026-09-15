# Cloud Providers and Authentication

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Pattern-Provider%20Factory-blue.svg" alt="Pattern" />
  <img src="https://img.shields.io/badge/Providers-Google%20%7C%20Dropbox%20%7C%20OneDrive-green.svg" alt="Providers" />
  <img src="https://img.shields.io/badge/Security-Hardware--Bound%20Tokens-red.svg" alt="Security" />
</div>

Gens-Horizon is built to be completely storage agnostic. By utilizing the **Factory** design pattern in `provider.js`, the engine delegates all network I/O operations to isolated adapters located within the `/providers` directory.

---

## 1. Provider Factory Pattern (`provider.js`)

Each cloud adapter implements an identical standard interface:

```javascript
class BaseCloudProvider {
    async login() {}                           // Launches the OAuth2 authorization flow
    async getQuota() {}                         // Returns { total, used, free }
    async listFiles(prefix) {}                  // Enumerates remote deltas and metadata
    async uploadFile(localPath, remoteName) {}  // Uploads with stream chunking
    async downloadFile(remoteName, destPath) {} // Direct stream download
    async deleteFile(fileId) {}                 // Removes remote cloud artifact
    async refreshTokenIfNeeded() {}             // Silently refreshes bearer tokens
}
```

The factory function `getProvider(name)` dynamically instantiates the appropriate adapter based on settings in `horizon_settings.json`:
- `'google'` -> `providers/google.js`
- `'dropbox'` -> `providers/dropbox.js`
- `'onedrive'` -> `providers/onedrive.js`

---

## 2. Provider Implementations

### Google Drive (`providers/google.js`)
- Interfaces directly with Google Drive REST API v3 without heavy external SDK packages.
- Stores game data in an isolated root folder (`GensHorizon/`) or within private application data storage (`appDataFolder`).
- Leverages multipart uploads for rapid delta transfer and resumable upload sessions for larger snapshots.

### Dropbox (`providers/dropbox.js`)
- Uses official Dropbox v2 REST endpoints (`/2/files/upload`, `/2/files/download`).
- Validates file integrity using Dropbox's native block-level content hashing.
- Handles short-lived token refreshing seamlessly via standard OAuth2 exchange.

### Microsoft OneDrive (`providers/onedrive.js`)
- Interfaces with the Microsoft Graph API (`/me/drive/special/approot` or designated subfolders).
- Supports chunked multi-part upload sessions (`createUploadSession`) to ensure reliability over slower networks.

---

## 3. Resilience and Adaptive Retries (`retry.js`)

To withstand transient network interruptions, rate limits (HTTP 429), or temporary server unavailability (HTTP 503), cloud operations are governed by an adaptive retry wrapper:
- **Exponential Backoff:** Base delay (`retryBaseDelay: 1500 ms`) increases exponentially, modulated with random jitter to prevent thundering herd conditions.
- **Configurable Attempt Limit:** Configured by default for 3 automatic attempts.
- **Fail-Fast for Fatal Errors:** Non-recoverable authorization failures (such as revoked credentials) exit immediately without exhausting API quotas.

---

## 4. Hardware-Bound Token Storage (`Auth.js`)

Cloud credentials and OAuth2 refresh tokens are **never stored in plaintext** on disk:

1. Upon first execution, Gens-Horizon generates a permanent 256-bit cryptographically secure identifier (`crypto.randomBytes(32)`) saved to `.machine_id`.
2. A distinct 16-byte random salt is generated in `salt.key` with restricted file permissions (`mode: 0o600`).
3. A 256-bit symmetric encryption key is derived using **PBKDF2** across 600,000 iterations using the `.machine_id` as the password.
4. Tokens are encrypted using **AES-256-GCM** with a unique 12-byte initialization vector (IV) generated for each write operation.

::: tip Anti-Theft Protection
Copying the Gens-Horizon directory to an external drive will not expose stored credentials. Decrypting tokens on another machine is cryptographically impossible without the original host machine's hardware-bound `.machine_id`.
:::
