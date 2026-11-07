# Architecture TypeScript & Typage Statique

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/TypeScript-Mode%20Strict-blue.svg" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Runtime-Z%C3%A9ro%20Transpilation-green.svg" alt="Zéro Transpilation" />
  <img src="https://img.shields.io/badge/Couverture-100%25%20V%C3%A9rifi%C3%A9-orange.svg" alt="100% Vérifié" />
</div>

Gens-Launcher repose sur une **architecture TypeScript sans étape de compilation (Zero-Build-Step)**, combinant des contrats de types `.ts` / `.d.ts` avec une vérification statique stricte par annotations JSDoc (`checkJs: true`, `strict: true`) sur l'intégralité du code exécuté.

---

## 1. Philosophie d'Architecture

1. **Zéro surcharge de transpilation :** Electron exécute directement les fichiers `.js` natifs sans bundler intermédiaire, garantissant un démarrage à froid instantané et des traces d'appels (*stack traces*) fidèles au code source.
2. **Sûreté de bout en bout des canaux IPC :** Tous les canaux IPC (`send`, `invoke`, `receive`) entre `main.js`, `preload.js` et `renderer.js` sont définis dans une source unique de vérité (`src/types/ipc.ts`) et vérifiés automatiquement face à la whitelist de sécurité par les tests unitaires (`tests/ipc-channels.test.js`).
3. **Mode Strict à 100 % :** Le fichier `tsconfig.json` active `"strict": true` et `"checkJs": true` sur l'ensemble des modules (`src/main/*`, `src/gens-core/*`, `src/ui/*`, `src/launch/*`, `src/archives/*`, `src/local/*`).

---

## 2. Contrats de Types Centraux (`src/types/`)

| Fichier | Rôle |
| --- | --- |
| `src/types/ipc.ts` | Définit `SEND_CHANNELS`, `INVOKE_CHANNELS`, `RECEIVE_CHANNELS`, l'interface `WindowApi` ainsi que le protocole JSON complet `HorizonEvent`. |
| `src/types/models.ts` | Modèles métier : `MinecraftInstance`, `MinecraftAccount` (`OfflineAccount` \| `MicrosoftAccount`), `GlobalSettings`, `ThemeSettings`, `MainContext`. |
| `src/types/global.d.ts` | Typage strict de l'objet global `Window` (`window.api`, `window.store`, contrôleurs UI et utilitaires partagés). |

---

## 3. Hygiène de Packaging

Les fichiers `.ts` et `.d.ts` servant exclusivement à l'analyse statique en développement et en CI, `electron-builder` les exclut explicitement (`!**/*.ts`, `!**/*.d.ts`, `!**/tsconfig*.json`) lors de la génération de l'archive ASAR de production.

---

## 4. Vérification & Règles de Contribution

Chaque commit et Pull Request est contrôlé automatiquement par GitHub Actions (`.github/workflows/ci.yml` et `.github/workflows/release.yml`).

Avant tout envoi, exécutez systématiquement en local :

```bash
# Analyse statique TypeScript complète (doit retourner 0 erreur)
npm run typecheck

# Mode surveillance continue pendant le développement
npm run typecheck:watch

# Exécution de la suite de tests automatisés (41 tests unitaires et sécurité)
npm test
```
