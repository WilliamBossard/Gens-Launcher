# TypeScript & Static Typing Architecture

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/TypeScript-Strict%20Mode-blue.svg" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Runtime-Zero%20Build%20Step-green.svg" alt="Zero Build Step" />
  <img src="https://img.shields.io/badge/Coverage-100%25%20Checked-orange.svg" alt="100% Checked" />
</div>

Gens-Launcher uses a **Zero-Build-Step TypeScript Architecture** combining pure `.ts` / `.d.ts` contract definitions with strict JSDoc type checking (`checkJs: true`, `strict: true`) across the entire JavaScript runtime.

---

## 1. Architectural Philosophy

1. **Zero Transpilation Overhead:** Electron executes `.js` files directly without bundlers or build steps, keeping cold startup instant and stack traces identical to source files.
2. **End-to-End IPC Type Safety:** All IPC channels (`send`, `invoke`, `receive`) between `main.js`, `preload.js`, and `renderer.js` are typed in a single source of truth (`src/types/ipc.ts`) and cross-checked against the runtime security whitelist by automated unit tests (`tests/ipc-channels.test.js`).
3. **100% Strict Mode:** `tsconfig.json` enforces `"strict": true` and `"checkJs": true` across all application modules (`src/main/*`, `src/gens-core/*`, `src/ui/*`, `src/launch/*`, `src/archives/*`, `src/local/*`).

---

## 2. Core Type Definitions (`src/types/`)

| File | Role |
| --- | --- |
| `src/types/ipc.ts` | Defines `SEND_CHANNELS`, `INVOKE_CHANNELS`, `RECEIVE_CHANNELS`, `WindowApi`, and the complete `HorizonEvent` JSON protocol. |
| `src/types/models.ts` | Domain interfaces: `MinecraftInstance`, `MinecraftAccount` (`OfflineAccount` \| `MicrosoftAccount`), `GlobalSettings`, `ThemeSettings`, `MainContext`. |
| `src/types/global.d.ts` | Declares typed globals on `Window` (`window.api`, `window.store`, UI managers, and helper functions). |

---

## 3. Packaging Hygiene

Because `.ts` and `.d.ts` files are only used for static verification during development and CI, `electron-builder` explicitly excludes them (`!**/*.ts`, `!**/*.d.ts`, `!**/tsconfig*.json`) when generating production ASAR archives.

---

## 4. Verification & Contributor Workflow

Every commit and Pull Request is automatically validated by GitHub Actions (`.github/workflows/ci.yml` and `.github/workflows/release.yml`).

Before submitting changes, always run locally:

```bash
# Run full TypeScript static analysis (must report 0 errors)
npm run typecheck

# Watch mode during development
npm run typecheck:watch

# Run the automated test suite (41 unit & security tests)
npm test
```
