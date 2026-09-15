# Delta Sync Algorithm and Incremental Backups

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Algorithm-Differential%20Delta-blue.svg" alt="Algorithm" />
  <img src="https://img.shields.io/badge/Hashing-SHA--256-green.svg" alt="Hashing" />
  <img src="https://img.shields.io/badge/Maintenance-Automatic%20Consolidation-orange.svg" alt="Maintenance" />
</div>

The core technological pillar of Gens-Horizon is its differential synchronization (**Delta Sync**) engine implemented across `scanner.js`, `upload.js`, `sync.js`, and `cloud-operations.js`.

---

## 1. High-Performance Local File Scanning (`scanner.js`)

Scanning a complex Minecraft instance (often containing upwards of 20,000 files spanning world region chunks, textures, and mod jars) must complete rapidly to ensure zero perceivable latency for the player:

1. **Fast Pre-Check (mtime and byte size):**
   Before running heavy SHA-256 cryptographic hashing, the scanner checks the modification timestamp (`mtimeMs`) and file size against the previous local manifest. If both match, the existing digest is preserved without reading the file from disk.
2. **Asynchronous Stream Hashing:**
   When files are new or modified, their SHA-256 digest is calculated using streaming pipes (`fs.createReadStream`).
3. **Concurrency Limiting (`withConcurrency`):**
   To avoid file descriptor exhaustion (`EMFILE: too many open files`), all file read operations are queued through a bounded concurrency worker pool (typically 16 to 32 concurrent handles).

---

## 2. Difference Detection and Delta Packaging (`upload.js`)

When cloud synchronization is initiated:

```
[ Current Local Manifest ]  vs  [ Last Synchronized Manifest ]
             |                                |
             +----------------+---------------+
                              |
                              v
                [ Three-Way Difference Split ]
                - Added files (ADDED)
                - Modified files (MODIFIED)
                - Deleted files (DELETED)
```

1. **Delta Bundle Creation:**
   Only files categorized as `ADDED` or `MODIFIED` are packed into a compact zip archive adhering to the naming standard:
   `GensHorizon_Delta_<timestamp>_<hash>.zip`
2. **Metadata and Deletions Manifest:**
   A companion lightweight metadata descriptor (`GensHorizon_Meta_<timestamp>.json`) explicitly details all `DELETED` file paths that must be removed locally on target machines.
3. **Targeted Upload:**
   The resulting package (usually between a few kilobytes and 2 MB) is transferred to the designated cloud provider folder.

---

## 3. Chronological Delta Application (`sync.js`)

When a player switches to another computer to retrieve their progress:

1. **Remote Index Fetching:**
   `sync.js` queries the cloud provider for all remote delta archives.
2. **Chronological Sorting:**
   All deltas created subsequent to the local machine's recorded state are sequenced chronologically.
3. **Sequential Replay:**
   For each pending delta:
   - The archive is downloaded to a scratch folder.
   - Files are extracted, overwriting outdated local equivalents.
   - Files specified in the deletion manifest are purged from disk.
   - The local manifest index is updated.
4. **Validation:**
   The local instance is now an exact replica of the state saved on the previous machine.

---

## 4. Automatic Pruning and Consolidation (`cloud-operations.js`)

Over months of active gameplay, small delta packages can accumulate. To prevent cloud storage clutter and API rate limiting:

- **`getCloudIndexAndCleanDuplicates()`:** Inspects remote folders, identifies orphaned artifacts, and cleans up accidental duplicates caused by aborted network calls.
- **Consolidation Threshold (`deltaCleanupThreshold`):** When accumulated delta archives exceed the configured threshold (default: 10 sessions), the engine merges the entire history into a fresh standalone baseline archive (`GensHorizon_Backup_<timestamp>.zip`) and removes older redundant delta files.
