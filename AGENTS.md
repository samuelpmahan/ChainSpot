# ChainSpot agent notes

Browser-only SvelteKit app (Svelte 5 runes, static adapter, Node >= 22). No backend, no network, no CI.

## Commands

- `npm run check` — typecheck (runs `svelte-kit sync` first; required since tsconfig extends `.svelte-kit/tsconfig.json`)
- `npm run test:unit` — Vitest (jsdom); single test: `npx vitest run tests/unit/<file>.test.ts`
- `npm run test:e2e` — Playwright (Chromium only); single spec: `npx playwright test tests/e2e/<spec>.spec.ts`
- `npm run build` — static site to `build/`
- There is no lint or formatter configured.

## Working mode

- In Codex desktop, use a Codex-managed Git worktree by default for coding tasks. The desktop UI controls whether a chat starts in Worktree, so select Worktree in the new-chat composer when creating a task.
- If a task starts in Local, ask before modifying files unless the user explicitly requests Local work.
- Before making changes, inspect `git status --short` and preserve unrelated user changes.
- Try not to run E2E tests or tests involving browser control for now. This is a build out, there are no users to worry about. Instead give the user manual browser tasks to carry out themselves.
- Default to focused unit tests only: run the specific file(s) touched by your change (`npx vitest run tests/unit/<file>.test.ts`), not the full `npm run test:unit` sweep, plus `npm run check` for type errors. Only run the full unit suite or `test:e2e` when the user directs you to — dev machines here are resource-constrained and a full run competes with the agent session for CPU.

## Long-running tasks

- Long-running tasks must emit progress logs so work can be monitored.
- Rotate progress logs and keep each log file at approximately 1 MB or less.

## Agent orchestration and communication

- When orchestrating subagents, check the status of every active subagent at least once every five minutes. Treat a subagent as failure-prone until its final result has been verified; an agent that appears nearly finished can still fail or stop unexpectedly.
- Timestamp orchestration updates in a readable format such as `[2026-08-10 16:42 CDT]`. Include the subagent name or ID, current state, most recent meaningful progress, blockers, and next action.
- Make status updates easy to scan. Lead with the state or outcome, use plain language, spell out jargon or acronyms on first use, and explain terms that a reader outside the immediate implementation area may not know.
- If a subagent is silent, blocked, or fails near completion, investigate promptly and recover or restart it when safe. Do not assume that silence means success.

## Testing layout & quirks

- Vitest only picks up `tests/**/*.test.ts` (unit tests are `tests/unit/*.test.ts`; e2e specs are `tests/e2e/*.spec.ts`). Setup file `tests/setup.ts` shims `HTMLCanvasElement.getContext` to return `null`.
- Canvas raster output is deliberately untestable in jsdom; Konva rendering is verified only in Playwright. Don't add canvas mocks or native canvas packages.
- E2e must wait for `document.documentElement.dataset.appReady === 'true'` before simulating input — events dispatched before hydration are not delegated.
- Fixtures are synthetic and repo-controlled (`tests/fixtures/`); regenerate with `node scripts/generate-acceptance-fixtures.mjs`, `generate-test-fixtures.mjs`, or `generate-smart-import-fixtures.mjs`. Never hand-edit fixture PNGs. Smart-import fixture rasters all derive from the seeded scene in `tests/helpers/smartMap.js`.

## Architecture

- `/` redirects to `/annotate-round`; the real pages are `src/routes/annotate-round`, `src/routes/create-graphics`, and `src/routes/stitch-map`. `prerender = true` (static adapter). Annotate Round produces an `AnnotatedRound` artifact (`src/lib/domain/annotatedRound.ts`) that Create Graphics consumes via `src/lib/annotatedRoundSession.ts`; Create Graphics also still accepts a direct image upload with no `AnnotatedRound` present (soft boundary).
- The live editor for each stage survives client-side navigation via `src/lib/editorSession.ts` (in-memory `ProjectEditor`, keyed per stage); only a full reload resets it. Don't move project state into page components or URL.
- Shared viewport behavior lives in `ImageViewport.svelte` / `src/lib/viewport.svelte.ts`; all panes use it.
- Persistence: `fflate` is the only runtime archive dependency; save format is `*.chainspot.zip` with `project.json` (schema v1, `src/lib/schemaV1.ts`) plus original images. Coordinates in original image pixels are authoritative; normalized coords are derived.
- `konva` is used for raster drawing; browser File/Web Crypto APIs for persistence (no hashing libraries).
