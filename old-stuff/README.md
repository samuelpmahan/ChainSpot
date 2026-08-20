# old-stuff — quarantined previous application (CHSPT-82)

This directory is the complete previous ChainSpot application implementation,
moved here unmodified as part of the CHSPT-82 clean-room frontend rebuild.

## Rules

- **This is reference material, not architecture.** It exists as evidence of prior
  behavior, edge cases, domain concepts, algorithms, data formats, and lessons.
- **New application code must never import from `old-stuff/`.** No path aliases,
  no compatibility wrappers, no build config reaching in here.
- Agents and humans **may read it freely** to understand what the old app did and why.
- A capability returns to the new app only deliberately: inspect the old behavior,
  understand the real data flow and edge cases, define the clean contract wanted now,
  then reimplement — copying old code back is acceptable only after that reasoning
  shows it is already exactly right.

## Contents

Everything that described or powered the old application/build: `src/`, `tests/`,
`scripts/`, `resources/`, `static/`, `docs/`, package manifests, Svelte/Vite/
TypeScript/Vitest/Playwright config, `.node-version`, the old root `README.md`
(now `README-old-app.md`), the old `.gitignore` (as `gitignore-old`), and stale
`.task/` working files from pre-rebuild branch work (`stale-task-files/`).

Nothing here is expected to build or run in place.
