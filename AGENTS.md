# ChainSpot agent notes

Browser-only SvelteKit app (Svelte 5 runes, static adapter, Node >= 22). No backend or runtime server. GitHub Actions is used for Pages deployment; do not assume a general-purpose test CI gate exists.

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
- Try not to run E2E tests or tests involving browser control for now unless they are the highest-value proof for the task. This is still a build-out and the user frequently performs manual browser acceptance. Never substitute unit/type checks for a browser interaction that they cannot prove.

## Task workflow — defer to Linear

The single canonical workflow definition lives in Linear: **ChainSpot Development Workflow**
(https://linear.app/chainspot/document/chainspot-development-workflow-fe350a97c5b9).
Read it before starting any task. This file deliberately does not mirror it; if the two ever
appear to disagree, the Linear document wins and this pointer gets fixed.

The non-negotiables you will find defined there:

- Linear ticket first; then a branch **from the intended base** — normally current `main`,
  with the document defining how the base is chosen for work that depends on an unmerged
  branch, and why `staging/*` accumulation branches are never a base. Prefer Linear's
  generated branch name.
- The first task-specific commit is `.task/<LINEAR-ID>.md` (task definition + implementer
  Proof Plan before any production code).
- Then: implementation → implementer Review Brief → fresh independent review → merge prep
  (delete `.task`, update `CHANGELOG-dev.md`) → staging deployment → manual acceptance →
  merge to `main` → production.
- Any external write — a push, a Linear issue/comment/doc, a GitHub comment, a deploy —
  requires showing the user the verbatim content first and getting explicit approval.
  The document defines the full rule.

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

- `/` redirects to `/annotate-course`; the real pages are `src/routes/annotate-course`, `src/routes/map-round`, `src/routes/create-graphics`, and `src/routes/stitch-map`. `prerender = true` (static adapter). Annotate Course (course geometry) and Map Round (a played round's throws/walk path) are two routes sharing one implementation, `src/lib/components/AnnotationWorkspace.svelte`, parameterized by a fixed `mode` prop set by whichever thin route mounts it — there is no runtime mode toggle. Either route produces an `AnnotatedRound` artifact (`src/lib/domain/annotatedRound.ts`) that Create Graphics consumes via `src/lib/session.ts`; Create Graphics also still accepts a direct image upload with no `AnnotatedRound` present (soft boundary).
- The live editor for each stage survives client-side navigation via `src/lib/session.ts` (in-memory `ProjectEditor`, keyed per stage — Annotate Course and Map Round each get their own independent key, so they never share an in-memory editor; Course Memory recognition is what carries course geometry from one to the other); only a full reload resets it. Don't move project state into page components or URL.
- Shared viewport behavior lives in `ImageViewport.svelte` / `src/lib/viewport.svelte.ts`; all panes use it.
- Persistence: `fflate` is the only runtime archive dependency; save format is `*.chainspot.zip` with `project.json` (schema v1, `src/lib/schemaV1.ts`) plus original images. Coordinates in original image pixels are authoritative; normalized coords are derived.
- `konva` is used for raster drawing; browser File/Web Crypto APIs for persistence (no hashing libraries).
