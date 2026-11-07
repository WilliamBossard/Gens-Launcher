# Compilation, Packaging et CI/CD

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Outil-electron--builder-blue.svg" alt="electron-builder" />
  <img src="https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-green.svg" alt="GitHub Actions" />
  <img src="https://img.shields.io/badge/D%C3%A9p%C3%B4t-APT%20Sign%C3%A9-red.svg" alt="APT" />
</div>

Gens-Launcher utilise **`electron-builder`** pour générer les paquets de distribution officiels pour Windows, macOS et Linux.

---

## 1. Prérequis de Développement

- **Node.js :** Version 22 LTS ou 24 recommandée.
- **Gestionnaire de paquets :** `npm` (version 10 ou supérieure).
- **Système d'exploitation :**
  - La compilation Windows (`.exe` NSIS) s'effectue sous Windows ou via Wine/Docker.
  - La compilation macOS (`.dmg`) requiert un environnement macOS (ou une machine virtuelle de build GitHub Actions `macos-latest`).
  - La compilation Linux (`.AppImage`, `.deb`) s'effectue nativement sous Linux.

---

## 2. Commandes de Compilation Locale

À la racine du projet, vous disposez des scripts suivants :

```bash
# Lancer le projet en mode développement
npm start

# Vérification statique du typage (TypeScript mode strict)
npm run typecheck

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

Dans le fichier `package.json`, la section `build` définit les métadonnées de packaging ainsi que le filtrage strict des fichiers embarqués dans l'archive ASAR (excluant les tests, la documentation et les fichiers de types `.ts` / `.d.ts`) :

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
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Game",
      "icon": "assets/icon-512.png"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "assets/icon-512.png",
      "category": "public.app-category.games"
    },
    "files": [
      "main.js",
      "preload.js",
      "renderer.js",
      "index.html",
      "src/**/*",
      "assets/**/*",
      "!**/tests/**",
      "!**/docs/**",
      "!**/*.test.js",
      "!**/*.map",
      "!**/*.ts",
      "!**/*.d.ts",
      "!**/tsconfig*.json",
      "!**/.git*",
      "!**/.vscode*",
      "!**/*.md"
    ]
  }
}
```

---

## 4. Pipelines CI/CD (`.github/workflows/`)

Gens-Launcher s'appuie sur trois workflows GitHub Actions automatisés :

1. **`ci.yml` (Intégration Continue) :** Déclenché à chaque `push` et `pull_request` sur `main`/`master`. Exécute `npm ci`, `npm run typecheck` et `npm test` sous Ubuntu et Windows (Node.js 22 & 24).
2. **`release.yml` (Compilation & Publication Multi-OS) :** Crée le tag de version depuis `package.json`, vérifie `npm run typecheck` et `npm test`, puis compile et publie les installateurs Windows, Linux et macOS sur GitHub Releases.
3. **`apt.yml` (Dépôt APT Automatisé & Documentation) :** Lorsqu'une nouvelle release est publiée sur GitHub, `.github/workflows/apt.yml` déploie la documentation et met à jour le dépôt Debian signé :

```text
[ Déclencheur GitHub Release ]
              |
              v
 [ Compilation VitePress (docs:build -> website/) ]
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

Grâce à cette organisation, les utilisateurs de Debian et Ubuntu bénéficient d'un canal de mise à jour sécurisé et automatisé via `apt upgrade`.
