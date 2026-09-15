# FAQ and Troubleshooting

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Support-GitHub%20Issues-blue.svg" alt="Support" />
  <img src="https://img.shields.io/badge/Status-Open%20Source-green.svg" alt="Status" />
</div>

This guide collects answers to frequently asked questions and troubleshooting advice for resolving common issues with Gens Launcher.

---

## Frequently Asked Questions (FAQ)

### Does Gens Launcher support offline accounts?
**Yes.** While we strongly recommend playing with an official Microsoft account for multiplayer skin support and verified server access, Gens Launcher includes full support for offline profiles on local area networks.

### Why does Windows display the blue SmartScreen warning on install?
Gens Launcher is an independent, non-commercial open-source project. Acquiring commercial EV Code Signing certificates costs hundreds of dollars per year. Simply click **"More info"** and select **"Run anyway"**. The complete codebase is public on GitHub.

### Are my Microsoft credentials secure?
**Yes, completely.** Gens Launcher uses Microsoft's official OAuth2 Device Code Flow. The application never sees or touches your password. Session tokens are encrypted on disk via OS-level security APIs (`safeStorage` or PBKDF2 with 600,000 iterations and AES-256-GCM).

### Is Gens Launcher free?
**Yes, 100% free with no ads.** The project is licensed under the MIT License and includes zero telemetry or data tracking.

---

## Common Issues and Solutions

### 1. Game crashes or fails to launch (Java errors)
- **Verify your Java version:**
  Minecraft 1.20.5+ requires Java 21 or Java 25. Minecraft 1.18 to 1.20.4 requires Java 17. Minecraft 1.16 requires Java 8.  
  Open *Instance Settings* and let Gens Launcher automatically download and assign the appropriate runtime.
- **Inspect memory allocation (RAM):**
  Allocating less than 2 GB can trigger `java.lang.OutOfMemoryError`. Avoid assigning more than half of your total system RAM to leave room for your operating system.
- **Conflicting mods:**
  Check the instance *Logs* tab to locate the mod causing the crash (look for `CrashReport` or `MixinApplyError`). Disable the problematic mod using the toggle switch in the Mods tab.

### 2. Horizon Cloud Sync fails
- **Verify Internet connectivity:**
  When offline, the launcher automatically defuses background sync tasks to avoid hanging the UI.
- **Active lock message (horizon.lock):**
  If the game crashed unexpectedly or is still active on another machine, an atomic lock protects your files. If you are certain no process is running, unlock the instance via the *Purge Lock* button in Advanced Settings.
- **Cloud token expiration:**
  If your cloud provider revoked permissions, simply disconnect and reconnect the provider in *Horizon Settings*.

### 3. macOS installation issues
- **"Application cannot be opened because it is from an unidentified developer":**
  Right-click the Gens Launcher icon in `/Applications`, choose **Open**, and confirm by clicking **Open** again. This prompt only occurs on the first launch.

---

## Getting Help

If you continue experiencing issues:
1. Gather your error logs via the *Help / Logs* menu.
2. Open a public ticket on the [Gens-Launcher GitHub Issues](https://github.com/WilliamBossard/Gens-Launcher/issues) repository.
