# TypeScript Migration

Gens-Launcher is moving from JavaScript to a TypeScript-first codebase.

This page tracks the migration goals, current status, and contributor rules.

---

## Why This Migration

- Improve safety for IPC boundaries (`main` <-> `preload` <-> `renderer`).
- Catch regressions earlier with static typing.
- Make refactors safer in security-sensitive modules.

---

## Migration Principles

1. No behavior regression.
2. Keep Electron security model unchanged.
3. Migrate in small pull requests.
4. Keep JavaScript runtime entrypoints working during transition.

---

## Current Baseline

- Dedicated branch: `feat/typescript-migration`
- Tooling in place:
  - `npm run typecheck`
  - `npm run typecheck:watch`
- Existing automated tests must stay green before and after each migration batch.

---

## Recommended Order

1. Shared IPC types and preload API typing.
2. `src/main` IPC handlers.
3. Renderer core modules.
4. UI modules and strictness ramp-up.

---

## Contributor Rules During Migration

- Prefer `.ts` for new modules.
- If a file remains in `.js`, avoid broad rewrites in the same PR.
- Keep security-related logic changes isolated and test-backed.
- Run both:

```bash
npm run typecheck
npm test
```
