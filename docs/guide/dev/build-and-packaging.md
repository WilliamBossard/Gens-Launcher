# Build, Packaging, and CI/CD

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Tool-electron--builder-blue.svg" alt="electron-builder" />
  <img src="https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-green.svg" alt="GitHub Actions" />
  <img src="https://img.shields.io/badge/Repository-Signed%20APT-red.svg" alt="APT" />
</div>

Gens-Launcher relies on **`electron-builder`** to produce production-grade installers for Windows, macOS, and Linux.

---

## 1. Development Prerequisites

- **Node.js:** Version 20 LTS or 24 recommended.
- **Package Manager:** `npm` (version 10 or newer).
- **Target OS Nuances:**
  - Windows builds (`.exe` NSIS) can be generated natively on Windows or via Wine/Docker.
  - macOS builds (`.dmg`) require macOS or GitHub Actions runners (`macos-latest`).
  - Linux packages (`.AppImage`, `.deb`) build natively on Linux distributions.

---

## 2. Local Build Scripts

The root `package.json` provides standard automation commands:

```bash
# Start the launcher in development mode
npm start

# Run unit tests (Node.js test runner)
npm test

# Build the Windows NSIS installer (.exe in dist/)
npm run dist:win

# Build Linux packages (.deb and .AppImage in dist/)
npm run dist:linux

# Build the macOS disk image (.dmg in dist/)
npx electron-builder --mac

# Compile all available targets
npm run dist:all
```

---

## 3. Packaging Configuration

The `build` object in `package.json` defines metadata and packaging rules:

```json
{
  "build": {
    "appId": "com.gens.launcher",
    "productName": "Gens Launcher",
    "directories": {
      "output": "dist"
    },
    "win": {
      "target": ["nsis"],
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Game",
      "icon": "assets/icon-512.png"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "assets/icon-512.png",
      "category": "public.app-category.games"
    }
  }
}
```

---

## 4. CI/CD and Automated APT Workflow (`apt.yml`)

When a new release tag is published on GitHub, `.github/workflows/apt.yml` handles repo deployment:

```
[ GitHub Release Event ]
            |
            v
 [ Download compiled .deb package ]
            |
            v
 [ Prepare apt-workspace/ staging area ]
   - Copy GPG public key (public.key)
   - Copy showcase website and compiled docs (website/*)
            |
            v
 [ Build Debian APT index ]
   - dpkg-scanpackages --multiversion . > Packages
   - gzip -k -f Packages
   - apt-ftparchive release . > Release
            |
            v
 [ GPG Cryptographic Signatures ]
   - gpg -abs -o Release.gpg Release
   - gpg --clearsign -o InRelease Release
            |
            v
 [ Deploy to GitHub Pages ]
   - Atomically published at williambossard.github.io/Gens-Launcher/
```

This workflow ensures Debian and Ubuntu users receive updates directly via `apt upgrade`.
