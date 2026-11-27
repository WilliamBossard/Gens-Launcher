# Static Typing Architecture (Rust + Strict TypeScript)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Backend-Rust%202024%20(0%20Warnings)-orange.svg" alt="Rust" />
  <img src="https://img.shields.io/badge/Frontend-TypeScript%20Strict-blue.svg" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/UI%20Runtime-Zero%20Build%20Step-green.svg" alt="Zero Build Step" />
</div>

Gens-Launcher combines a **statically compiled, zero-warning Rust backend** (`src-tauri/`) with a **Zero-Build-Step TypeScript-checked frontend** (`frontend/tsconfig.json` with `allowJs: true`, `checkJs: true`, `strict: true`, `noEmit: true`).

---

## 1. Architectural Philosophy

1. **Memory & Type Safety in the Backend:** All filesystem, network, crypto, archive, and process-spawning logic is compiled by `rustc` and verified by `cargo clippy --all-targets -- -D warnings`.
2. **Zero Transpilation Overhead in the Frontend:** The WebView loads ES `.js` modules directly from `frontend/`, keeping UI iteration instant and stack traces identical to source files.
3. **100% Strict Frontend Coverage:** `frontend/tsconfig.json` enforces `"strict": true` and `"checkJs": true` across `renderer.js`, `src/tauri-bridge.js`, `src/ui/*`, `src/launch/*`, `src/archives/*`, and `src/local/*`.

---

## 2. Frontend Type Contracts (`frontend/src/types/`)

| File | Role |
| --- | --- |
| `frontend/src/types/ipc.ts` | Defines `SEND_CHANNELS`, `INVOKE_CHANNELS`, `RECEIVE_CHANNELS`, `WindowApi`, and the `HorizonEvent` JSON protocol. |
| `frontend/src/types/models.ts` | Domain interfaces: `MinecraftInstance`, `MinecraftAccount` (`OfflineAccount` \| `MicrosoftAccount`), `GlobalSettings`, `ThemeSettings`. |
| `frontend/src/types/global.d.ts` | Declares typed globals on `Window` (`window.api`, `window.store`, UI managers, and helper functions). |

---

## 3. Verification & Contributor Workflow

Every commit and Pull Request is automatically validated by GitHub Actions (`.github/workflows/ci.yml`).

Before submitting changes, run locally:

```bash
# 1. Rust strict lint (0 warnings allowed)
cd src-tauri
cargo clippy --all-targets -- -D warnings

# 2. Rust automated unit & security tests
cargo test

# 3. Frontend TypeScript static analysis (0 errors allowed)
cd ../frontend
npx -y typescript@latest -p tsconfig.json --noEmit
```
