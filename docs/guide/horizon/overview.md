# Gens-Horizon: Cloud Engine Architecture

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Engine-Headless%20CLI-blue.svg" alt="Engine" />
  <img src="https://img.shields.io/badge/Protocol-IPC%20JSON%20Stream-green.svg" alt="Protocol" />
  <img src="https://img.shields.io/badge/Storage-Provider%20Agnostic-orange.svg" alt="Storage" />
</div>

**Gens-Horizon** (`C:\dev\Gens-Horizon`) is the standalone headless cloud synchronization engine of the Gens ecosystem. Designed to run in the background as a child process of Gens-Launcher, it orchestrates bidirectional synchronization, delta versioning, and disaster recovery across major cloud storage providers (Google Drive, Dropbox, OneDrive).

---

## 1. Core Purpose and Philosophy

Traditional Minecraft launchers usually back up instances by compressing an entire 500 MB directory into a single monolithic zip and uploading it to a server. This approach wastes massive bandwidth, introduces sluggish wait times, and rapidly exhausts storage quotas.

Gens-Horizon replaces this model with:
- **Delta Sync Technology:** Only altered blocks and files are compressed and transferred.
- **Headless Isolation:** The engine runs decoupled from the GUI and can execute as a standalone CLI or compiled native binary (`pkg`).
- **Provider Agnostic Design:** Extensible Factory pattern supporting diverse storage providers.
- **Resilience and Concurrency Safety:** Atomic lockfiles and active heartbeats protect instances from concurrent writes and corrupted states.

---

## 2. Component Topology

The internal architecture of Gens-Horizon is organized around focused modules:

```
                                  [ CLI / Launcher IPC ]
                                             |
                                             v
                                        index.js
                                             |
         +-----------------+-----------------+-----------------+
         |                 |                 |                 |
         v                 v                 v                 v
      check.js          sync.js          upload.js        rollback.js
         |                 |                 |                 |
         +-----------------+--------+--------+-----------------+
                                    |
                                    v
                            scanner.js (SHA-256)
                                    |
                                    v
                           provider.js (Factory)
                     /              |              \
                    v               v               v
             providers/google  providers/dropbox  providers/onedrive
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
        v                           v                           v
     lock.js                     Auth.js               cloud-operations.js
  (Atomic Locks)           (PBKDF2 / AES-GCM)        (Index & Cleanup)
```

- **`index.js`**: Main CLI entry point. Intercepts standard loggers (`console.log`, `console.warn`) to redirect library text to `process.stderr`, preserving clean JSON on `process.stdout`.
- **`scanner.js`**: High-performance local file scanner. Computes SHA-256 digests while enforcing concurrency limits (`withConcurrency`) to prevent file descriptor exhaustion (`EMFILE`).
- **`upload.js`**: Analyzes differences against the last known local manifest, builds a targeted delta bundle, and uploads it.
- **`sync.js`**: Queries the remote manifest index, downloads missing deltas in chronological sequence, and applies them locally.
- **`cloud-operations.js`**: Centralizes remote index retrieval and purges obsolete or duplicate cloud backups (`getCloudIndexAndCleanDuplicates`).
- **`rollback.js`**: Reconstructs previous instance states deterministically to restore any historical snapshot.
- **`zip-utils.js`**: High-efficiency in-memory zip decompression using `yauzl`, with Path Traversal defenses and zip header verification (`0x504B0304`).

---

## 3. IPC JSON Communication Protocol

Gens-Horizon communicates with the parent launcher over standard `stdout` and `stdin` streams. Messages on `stdout` are strictly formatted as single-line JSON objects:

```json
{
  "type": "PROGRESS",
  "step": "COMPRESSING",
  "value": 65,
  "instance": "Survival_Folia"
}
```

### Supported Event Types:
- `PROGRESS`: Real-time phase reporting (`SCANNING`, `COMPRESSING`, `UPLOADING`, `APPLYING_DELTA`).
- `INFO`: Informational text messages.
- `SUCCESS`: Operation completion with metadata summary.
- `ERROR`: Typed error payloads.
- `ROLLBACK_LIST`: Chronological enumeration of available restore points.
- `CHECK_RESULT`: Comparison between local and remote state.
- `CLOUD_LIST`: Full inventory of synchronized instances.
