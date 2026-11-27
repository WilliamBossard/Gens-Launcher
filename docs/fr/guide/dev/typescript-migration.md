# Architecture de Typage Statique (Rust + TypeScript Strict)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Backend-Rust%202024%20(0%20Warning)-orange.svg" alt="Rust" />
  <img src="https://img.shields.io/badge/Frontend-TypeScript%20Strict-blue.svg" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/UI-Z%C3%A9ro%20Build%20Step-green.svg" alt="Zéro Build Step" />
</div>

Gens-Launcher combine un **backend Rust compilé statiquement à zéro warning** (`src-tauri/`) avec un **frontend vérifié statiquement par TypeScript sans étape de build** (`frontend/tsconfig.json` avec `allowJs: true`, `checkJs: true`, `strict: true`, `noEmit: true`).

---

## 1. Philosophie Architecturale

1. **Sûreté mémoire et typage fort côté Backend :** Toute la logique système (fichiers, réseau, crypto, archives, lancement Java) est compilée par `rustc` et validée par `cargo clippy --all-targets -- -D warnings`.
2. **Zéro surcharge de transpilation côté Frontend :** La WebView charge directement les modules ES `.js` depuis `frontend/`, conservant des temps d'itération instantanés et des stack traces fidèles au code source.
3. **Couverture stricte à 100 % :** `frontend/tsconfig.json` impose `"strict": true` et `"checkJs": true` sur `renderer.js`, `src/tauri-bridge.js`, `src/ui/*`, `src/launch/*`, `src/archives/*` et `src/local/*`.

---

## 2. Contrats de Types Frontend (`frontend/src/types/`)

| Fichier | Rôle |
| --- | --- |
| `frontend/src/types/ipc.ts` | Définit `SEND_CHANNELS`, `INVOKE_CHANNELS`, `RECEIVE_CHANNELS`, `WindowApi` et le protocole JSON `HorizonEvent`. |
| `frontend/src/types/models.ts` | Interfaces métier : `MinecraftInstance`, `MinecraftAccount` (`OfflineAccount` \| `MicrosoftAccount`), `GlobalSettings`, `ThemeSettings`. |
| `frontend/src/types/global.d.ts` | Déclare les globaux typés sur `Window` (`window.api`, `window.store`, gestionnaires UI et helpers). |

---

## 3. Vérification et Workflow Contributeur

Chaque commit et Pull Request est validé automatiquement par GitHub Actions (`.github/workflows/ci.yml`).

Avant de soumettre vos modifications, exécutez localement :

```bash
# 1. Lint strict Rust (0 warning toléré)
cd src-tauri
cargo clippy --all-targets -- -D warnings

# 2. Suite de tests unitaires et de sécurité Rust
cargo test

# 3. Analyse statique TypeScript du frontend (0 erreur tolérée)
cd ../frontend
npx -y typescript@latest -p tsconfig.json --noEmit
```
