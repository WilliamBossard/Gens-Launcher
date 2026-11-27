# Compilation, Packaging et CI/CD

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Outil-Tauri%20v2%20CLI-orange.svg" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-green.svg" alt="GitHub Actions" />
  <img src="https://img.shields.io/badge/D%C3%A9p%C3%B4t-APT%20Sign%C3%A9-red.svg" alt="APT" />
</div>

Gens-Launcher s'appuie sur **Cargo + Tauri v2 (`tauri-action`)** pour produire des installeurs natifs ultra-légers pour Windows, macOS et Linux.

---

## 1. Prérequis de Développement

- **Chaîne Rust :** Rust stable (édition 2024) via `rustup`, avec `clippy` et `rustfmt`.
- **Tauri CLI v2 :** `cargo install tauri-cli --version "^2"`.
- **Node.js :** Version 22+ (uniquement requis pour la vérification TypeScript du frontend et la compilation de la documentation VitePress).
- **Dépendances spécifiques par OS :**
  - **Windows :** Visual Studio C++ Build Tools + WebView2 (pré-installé sur Windows 10/11).
  - **Linux (Debian/Ubuntu) :** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`.
  - **macOS :** Xcode Command Line Tools.

---

## 2. Commandes Locales de Build et Vérification

```bash
# Lancer le launcher en mode développement
cargo tauri dev

# Lint strict Rust (0 warning toléré)
cd src-tauri && cargo clippy --all-targets -- -D warnings

# Lancer les tests unitaires et de sécurité Rust
cd src-tauri && cargo test

# Vérification TypeScript stricte du frontend (0 erreur tolérée)
cd frontend && npx -y typescript@latest -p tsconfig.json --noEmit

# Générer les installeurs de production pour l'OS courant
cargo tauri build
```

Les installeurs générés se trouvent dans `src-tauri/target/release/bundle/` :
- **Windows :** `nsis/*-setup.exe` (inclut le hook `src-tauri/nsis/hooks.nsh` qui désinstalle silencieusement l'ancienne version Electron sans perdre les données)
- **Linux :** `deb/*.deb` et `appimage/*.AppImage`
- **macOS :** `dmg/*.dmg`

---

## 3. Configuration du Packaging (`src-tauri/tauri.conf.json`)

Le profil release de `src-tauri/Cargo.toml` optimise la taille du binaire (`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`), produisant un exécutable Windows d'environ 11 Mo.

```json
{
  "productName": "Gens Launcher",
  "identifier": "com.gens.launcher",
  "build": {
    "frontendDist": "../frontend"
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "windows": {
      "nsis": {
        "installerHooks": "nsis/hooks.nsh"
      }
    }
  }
}
```

---

## 4. Pipelines CI/CD (`.github/workflows/`)

Gens-Launcher utilise trois workflows GitHub Actions automatisés :

1. **`ci.yml` (Intégration Continue) :** Déclenché sur chaque `push` et `pull_request` vers `main`/`master`. Exécute `cargo clippy --all-targets -- -D warnings` et `cargo test` sur `ubuntu-latest`, `windows-latest` et `macos-latest`, ainsi que `tsc --noEmit` sur `frontend/`.
2. **`release.yml` (Release Multi-OS) :** Exécute Clippy et les tests Rust, compile les paquets Windows/Linux/macOS via `tauri-apps/tauri-action@v0`, puis génère et publie les manifestes `latest.yml`, `latest-linux.yml` et `latest-mac.yml` (SHA-512) compatibles avec la migration Electron → Rust et les mises à jour Rust → Rust.
3. **`apt.yml` (Dépôt APT & Documentation) :** Déclenché lors de la publication d'une release, compile la documentation VitePress (`npm --prefix docs run docs:build` → `website/`), télécharge le `.deb`, signe le dépôt APT via GPG (`Release.gpg`, `InRelease`) et déploie sur GitHub Pages :

```text
[ Événement Release GitHub ]
            |
            v
 [ Compilation Docs VitePress (npm --prefix docs run docs:build -> website/) ]
            |
            v
 [ Téléchargement du paquet .deb ]
            |
            v
 [ Préparation de apt-workspace/ ]
   - Copie de la clé publique GPG (public.key)
   - Copie du site et de la doc compilée (website/*)
            |
            v
 [ Génération de l'index APT Debian ]
   - dpkg-scanpackages --multiversion . > Packages
   - gzip -k -f Packages
   - apt-ftparchive release . > Release
            |
            v
 [ Signatures Cryptographiques GPG ]
   - gpg -abs -o Release.gpg Release
   - gpg --clearsign -o InRelease Release
            |
            v
 [ Déploiement GitHub Pages ]
   - Publication atomique sur williambossard.github.io/Gens-Launcher/
```
