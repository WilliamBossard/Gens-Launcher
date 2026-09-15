# Compilation, Packaging et CI/CD

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Outil-electron--builder-blue.svg" alt="electron-builder" />
  <img src="https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-green.svg" alt="GitHub Actions" />
  <img src="https://img.shields.io/badge/D%C3%A9p%C3%B4t-APT%20Sign%C3%A9-red.svg" alt="APT" />
</div>

Gens-Launcher utilise **`electron-builder`** pour générer les paquets de distribution officiels pour Windows, macOS et Linux.

---

## 1. Prérequis de Développement

- **Node.js :** Version 20 LTS ou 24 recommandée.
- **Gestionnaire de paquets :** `npm` (version 10 ou supérieure).
- **Système d'exploitation :**
  - La compilation Windows (`.exe` NSIS) s'effectue sous Windows ou via Wine/Docker.
  - La compilation macOS (`.dmg`) requiert un environnement macOS (ou une machine virtuelle de build GitHub Actions `macos-latest`).
  - La compilation Linux (`.AppImage`, `.deb`) s'effectue nativement sous Linux.

---

## 2. Commandes de Compilation Locale

À la racine du projet, vous disposez des scripts suivants :

```bash
# Lancer le projet en mode développement avec hot-reloading
npm start

# Exécuter la suite de tests unitaires (Node.js test runner)
npm test

# Générer l'installateur Windows (.exe NSIS dans dist/)
npm run dist:win

# Générer les paquets Linux (.deb et .AppImage dans dist/)
npm run dist:linux

# Générer l'image disque macOS (.dmg dans dist/)
npx electron-builder --mac

# Générer l'ensemble des cibles
npm run dist:all
```

---

## 3. Configuration `electron-builder`

Dans le fichier `package.json`, la section `build` définit les métadonnées de packaging :

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

## 4. Pipeline CI/CD et Dépôt APT Automatisé (`apt.yml`)

Lorsqu'une nouvelle release est publiée sur GitHub, le workflow `.github/workflows/apt.yml` prend le relais automatiquement :

```
[ Déclencheur GitHub Release ]
              |
              v
 [ Téléchargement du .deb compilé ]
              |
              v
 [ Préparation du dossier de staging apt-workspace/ ]
   - Copie de la clé publique GPG (public.key)
   - Copie de l'intégralité du site vitrine et documentation (website/*)
              |
              v
 [ Génération de l'index Debian ]
   - dpkg-scanpackages --multiversion . > Packages
   - gzip -k -f Packages
   - apt-ftparchive release . > Release
              |
              v
 [ Signature Cryptographique GPG ]
   - gpg -abs -o Release.gpg Release
   - gpg --clearsign -o InRelease Release
              |
              v
 [ Déploiement vers GitHub Pages ]
   - Mise en ligne atomique sur williambossard.github.io/Gens-Launcher/
```

Grâce à cette organisation, les utilisateurs de Debian et Ubuntu bénéficient d'un canal de mise à jour sécurisé et automatisé sans intervention manuelle.
