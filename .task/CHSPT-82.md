# CHSPT-82 — Frontend rebuild — rederive the MVP from a clean-room app (bootstrap only)

## Goal

Quarantine the existing application implementation under `old-stuff/` and bootstrap a
genuinely fresh, minimal SvelteKit app at the repository root whose complete visible
product at `/` is `<h1>Stitch Map</h1>`. No feature migration in this task.

## Required behavior

- All old application/build implementation (src, tests, scripts, resources, static
  assets, app docs, package/build/test config) lives under `old-stuff/`, unmodified,
  as read-only reference material with a README stating the archive rule.
- Repository governance/workflow material stays at root: `.git`, `.github`,
  `AGENTS.md`, `CLAUDE.md`, `.task/`, `CHANGELOG-dev.md`.
- A fresh minimal SvelteKit application exists at root: `src/routes/+layout.svelte`
  and `src/routes/+page.svelte`, plus only the config/type files SvelteKit requires,
  all newly written (not restored from the old app).
- `npm install` then `npm run dev` serves `/` rendering only `Stitch Map` as an H1,
  browser-default presentation.
- The new app imports nothing from `old-stuff/`.
- Dependency surface is minimal and each dependency is explainable.

## Non-goals

- No Stitch Map functionality, image loading, viewport, stitching math, persistence,
  session state, CV, Konva, nav, demo tooling, or styling.
- No compatibility wrappers around or imports into `old-stuff/`.
- No preservation of old unit/e2e suites in runnable form.
- No deployment, no merge to main.

## Known context

- Old app: SvelteKit (Svelte 5 runes, static adapter), routes under
  `src/routes/{annotate-course,map-round,create-graphics,stitch-map,demo,ribbon-editor}`,
  large `src/lib` (domain/editor/session/CV/stitch), Vitest + Playwright suites,
  fixture generators in `scripts/`, ~resources and static demo assets.
- `.github/workflows/deploy-pages.yml` deploys only on push to `main`; this branch does
  not trigger it. It will need rework before any future production merge of the rebuild
  (out of scope here; noted so it isn't forgotten).
- Root `README.md` documents the old app and moves to quarantine; a short fresh README
  takes its place.

## Acceptance

- `old-stuff/` contains the old implementation and an archive-rule README.
- Fresh root app: `npm run dev` serves `/` showing only the H1 `Stitch Map`.
- `npm run check` (svelte-check) and `npm run build` pass for the new app.
- `grep` over new `src/` finds no reference to `old-stuff`.
- Governance files remain at root; `CHANGELOG-dev.md` untouched until merge prep.

## Proof Plan

- Highest-value invariant: the served page at `/` contains exactly one `<h1>` with text
  `Stitch Map` and no legacy routes respond. Proof: start `npm run dev`, curl `/`
  and assert the H1; curl a legacy route (e.g. `/annotate-course`) and assert 404.
- Isolation invariant: no new-app import references `old-stuff/`. Proof: grep new
  `src/`, config files, and `package.json` for `old-stuff`; expect zero matches.
- Build health: `npm run check` and `npm run build` succeed from a clean install
  (`npm ci` after lockfile creation) — this is the regression test that fails if the
  minimal config is wrong.
- Manual browser verification is not required for this bootstrap: the behavior is a
  static H1, fully provable by fetched HTML; visual/pointer behavior is out of scope.
- Limitation: automated proof cannot show that quarantine judgment calls (what counted
  as "governance" vs "application") match intent — the file-by-file move list is
  reported for human review instead.
