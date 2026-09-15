# Horizon Cloud Sync (Player Guide)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Technology-Delta%20Sync-blue.svg" alt="Delta Sync" />
  <img src="https://img.shields.io/badge/Providers-Google%20Drive%20%7C%20Dropbox%20%7C%20OneDrive-green.svg" alt="Providers" />
  <img src="https://img.shields.io/badge/Encryption-AES--256--GCM-red.svg" alt="Encryption" />
</div>

The **Horizon Cloud Sync** technology is a marquee innovation in Gens Launcher. It enables you to automatically synchronize your Minecraft instances (singleplayer worlds, keybindings, inventories, resource packs, and mods) across multiple computers using your own personal cloud storage.

---

## How Does Cloud Sync Work?

Unlike traditional tools that re-upload an entire 500 MB game directory each time you play, Gens-Horizon utilizes differential synchronization (**Delta Sync**):
- Only files modified since your last session are processed.
- Unaltered files are never re-transferred over the network.
- An average gaming session consumes only a few megabytes of bandwidth and syncs in mere seconds.

---

## Connecting a Cloud Provider

1. Open **Settings** in Gens Launcher -> switch to the **Horizon Cloud** tab.
2. Choose your preferred storage provider:
   - **Google Drive**
   - **Dropbox**
   - **Microsoft OneDrive**
3. Click **Connect**. A secure official authentication page will open in your web browser.
4. Grant access permissions to the application. Gens-Horizon encrypts access tokens locally on your disk using a hardware-bound key (**PBKDF2** with 600,000 iterations + **AES-256-GCM**).
5. Once connected, your remaining storage quota is displayed directly in the launcher interface.

---

## Enabling Synchronization on an Instance

1. Right-click any instance -> **Instance Settings**.
2. Check the box **Enable Horizon Cloud Sync**.
3. Select your sync strategy:
   - **Smart Sync (Recommended):** Gens Launcher verifies whether a newer remote save exists before starting the game, and automatically uploads modifications when you quit playing.
   - **Manual Mode:** You trigger upload or restore actions on demand using the *Upload to Cloud* and *Restore from Cloud* buttons.

---

## Version History and Rollback

If a game world becomes corrupted or a buggy mod damages your save data:
1. Open the instance's **Cloud** tab.
2. Review the chronological history of past sessions and snapshots.
3. Click **Rollback to this point** to restore the exact state of your instance files at that point in time.

---

## Data Privacy and Security

- **Your Personal Storage:** Backups are hosted exclusively on your personal cloud account (Google Drive, Dropbox, or OneDrive). No third-party servers store your files.
- **Atomic Lockfile Protection:** If your game is currently running on one PC, an atomic lockfile (`horizon.lock`) prevents conflicting writes or accidental overwrites from a second computer.
