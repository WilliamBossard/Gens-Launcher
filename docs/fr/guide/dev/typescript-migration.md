# Migration TypeScript

Gens-Launcher migre progressivement d'un socle JavaScript vers une base orientee TypeScript.

Cette page centralise les objectifs, l'etat actuel et les regles de contribution pendant la migration.

---

## Pourquoi cette migration

- Renforcer la securite des frontieres IPC (`main` <-> `preload` <-> `renderer`).
- Detecter les regressions plus tot avec le typage statique.
- Simplifier les refactors sur les modules sensibles.

---

## Principes de migration

1. Aucune regression fonctionnelle.
2. Conserver le modele de securite Electron existant.
3. Migrer par petites pull requests.
4. Garder les points d'entree JavaScript fonctionnels pendant la transition.

---

## Baseline actuelle

- Branche dediee : `feat/typescript-migration`
- Outillage en place :
  - `npm run typecheck`
  - `npm run typecheck:watch`
- Les tests automatises doivent rester au vert avant et apres chaque lot.

---

## Ordre recommande

1. Types partages IPC et typage de l'API preload.
2. Handlers IPC de `src/main`.
3. Modules coeur du renderer.
4. Modules UI et montee progressive en strict.

---

## Regles de contribution pendant la migration

- Preferer `.ts` pour tout nouveau module.
- Si un fichier reste en `.js`, eviter les refactors larges dans la meme PR.
- Isoler les changements de securite et les couvrir par des tests.
- Executer systematiquement :

```bash
npm run typecheck
npm test
```
