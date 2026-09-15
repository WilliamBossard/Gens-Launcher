# Atomic Locks and Data Integrity Security

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Concurrency-Atomic%20Lock%20%2B%20Heartbeat-blue.svg" alt="Concurrency" />
  <img src="https://img.shields.io/badge/Safety-Anti--Zip%20Slip-green.svg" alt="Anti-Zip Slip" />
  <img src="https://img.shields.io/badge/Recovery-Deterministic%20Rollback-orange.svg" alt="Recovery" />
</div>

In a multi-device setup where distinct computers can access the same cloud instance profile, preventing state corruption, race conditions, and unsafe archive decompression is paramount.

---

## 1. Atomic Lockfile Protocol (`lock.js`)

To prevent two synchronization sessions from running concurrently on the same Minecraft directory, Gens-Horizon enforces an atomic physical lockfile protocol:

```
[ Synchronization Starts ]
            |
            v
    Attempt atomic creation:
    fs.open('horizon.lock', O_CREAT | O_EXCL)
            |
     +------+------+
     |             |
 [ SUCCESS ]   [ FAILURE (EEXIST) ]
     |             |
     |             v
     |    Inspect Existing Lock:
     |    - Is the master PID still alive? (kill(pid, 0))
     |    - Has the lock been silent for > 2 hours? (STALE_LOCK_MS)
     |             |
     |      +------+------+
     |      |             |
     |  [ ACTIVE ]   [ ORPHAN / DEAD ]
     |      |             |
     |   Concurrency      v
     |   Abort       Purge stale lock
     |   (Stop)      & recreate
     |                    |
     +--------------------+
            |
            v
[ Active Heartbeat Loop every 5 seconds ]
fs.promises.utimes('horizon.lock')
            |
            v
[ Synchronization Finishes: Unlink horizon.lock ]
```

### The 5-Second Heartbeat
Throughout the lifecycle of a synchronization operation (scanning, compression, network transfer), the master process touches the modification time (`mtimeMs`) of `horizon.lock` every 5 seconds.

### Stale Lock Detection
If an unexpected shutdown or hard kill (`SIGKILL`) leaves `horizon.lock` lingering on disk, Gens-Horizon evaluates lock status on its next launch:
1. **Process Liveness Test (`process.kill(pid, 0)`):** If the OS confirms the PID no longer exists (`ESRCH`), the lock is declared orphaned and purged immediately.
2. **Inactivity Threshold (2 Hours):** Even if the PID was subsequently reassigned to another unrelated OS task, a lock whose heartbeat has not updated for over 2 hours (`STALE_LOCK_MS = 7200000`) is automatically discarded.

### Process Coupling with Gens-Launcher (`ipc-horizon.js`)
The parent launcher reads `mtimeMs` of `horizon.lock` before permitting cloud interactions in the GUI. Lock parameters (5s heartbeat interval and 2h stale threshold) are strictly aligned across both repositories.

---

## 2. Secure Archive Extraction and Zip Slip Defenses (`zip-utils.js`)

Decompressing remote zip archives carries inherent risks if an archive contains malicious relative paths (such as `../../../../Windows/System32`). Gens-Horizon mitigates this threat:

1. **Extraction Path Boundary Inspection:**
   ```javascript
   const resolvedTarget = path.resolve(destDir);
   const resolvedDest = path.resolve(destDir, entry.fileName);
   if (!resolvedDest.startsWith(resolvedTarget + path.sep) && resolvedDest !== resolvedTarget) {
       throw new Error(`Zip Slip security violation: ${entry.fileName}`);
   }
   ```
2. **Binary Signature Verification:**
   Before initiating decompression, the engine confirms the presence of the standard ZIP magic header `0x504B0304` (`PK\x03\x04`) and verifies that the Central Directory is readable.
3. **Stream Decompression via `yauzl`:**
   Extraction streams data on the fly rather than buffering the entire archive into memory, ensuring stability on large modpack archives.

---

## 3. Deterministic Historical Rollback (`rollback.js`)

If a world save is damaged by gameplay errors or a faulty mod:
- Each cloud synchronization session creates a unique historical snapshot identified by its timestamp and manifest hash.
- Running `--rollback --instance "Name" --target "<timestamp>"` reconstructs the exact directory structure as it existed at that precise moment by chronologically reverting or replaying deltas.
