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

## The Engram Table (read this before non-trivial work)

`.claude/skills/` is the repo's agent memory — plain-markdown "engrams"
that Claude sessions auto-load and every OTHER agent must read at task
start as if they were part of this file:

- `.claude/skills/chainspot-engrams/SKILL.md` — process memory (receipts,
  claims ledger, gate model, owner policies, operational quirks).
- `.claude/skills/chainspot-cv-engrams/SKILL.md` — vision memory (chrome
  signatures, C1S/C2D rings and z-order, the completeness invariant).
- `.claude/skills/gate-triage/SKILL.md` — first-line diagnosis for missing,
  misplaced, misidentified, stolen, or nonsensical endpoint/assignment work.
- `.claude/skills/receipt-reconcile/SKILL.md` — minimal human-checkable proof
  for a challenged claim; identity before geometry and one-turn evidence.
- `.claude/skills/lab-shock-collar/SKILL.md` — anti-throwaway-script law;
  repeated investigative capability belongs in LAB, not a shadow CLI.

An engram is written the day it is earned, in the same commit as the work.
Load-bearing diagnoses go to `docs/CLAIMS-LEDGER.md` with receipts.

## How work gets done — small demonstrable progress

The full definition lives in [`docs/WORKFLOW.md`](./docs/WORKFLOW.md). Read it
before starting. The short version:

**The bar is small demonstrable progress. Not tickets.**

A piece of work is done when it produces something a human can look at and
accept on sight — a real run, on real course data, printing a receipt. Not
"tests pass". Not "the ticket is closed". A picture and a receipt.

- **No ticket is required to start.** Ticket ceremony (`.task/<ID>.md`, Proof
  Plans, Review Briefs, merge prep) is retired. It bought paperwork, not
  progress.
- **Prefer ten landings a human can each accept on sight** over one large
  landing that requires trust.
- **A lane commit is a half.** Halves meet in `staging/<area>` and must
  demonstrate that they combine before the work counts. See the waiting room
  rules in `docs/WORKFLOW.md`.
- **Every number ships with where it came from**, or a loud `UNKNOWN`.
  Thresholds are dataset-fit estimates, not physics, and they are the first
  suspect when a gate misbehaves.
- **No silent drops.** `features/types.ts` already states the rule: filtering
  code emits a rejected drawable with a reason per killed candidate. A
  candidate that vanishes with no record is a bug, not a filter.
- **Any external write** — a push, a GitHub or Linear comment, a deploy —
  requires showing the user the verbatim content first and getting explicit
  approval.

### LAB before throwaway code

LAB is the canonical embodied inspection/execution interface.

Do not create ad-hoc Python/JS/TS/shell analysis scripts when LAB can express
the operation. If LAB genuinely cannot answer a diagnostic question, a one-shot
script may be used once with its missing LAB capability stated explicitly.
Before reusing that script or an equivalent one, stop and decide whether the
capability belongs in LAB. Reusable diagnostic capability must be promoted into
LAB; do not grow a shadow CLI. A third use of a throwaway script is prohibited.

### Identify pixels before measuring them

No component may be used as evidence about a tee/basket/badge merely because
its geometry fits a downstream hypothesis. Establish object identity from the
canonical raster/context first. `UNKNOWN` is valid. Badge digits and other
renderer chrome are known confounders. If identity is ambiguous, do not continue
with target-specific geometry as though the identity were established.

### Human receipts are minimal

Machine artifacts may be exhaustive. Human acceptance receipts are not.

For a challenged claim, lead with one verdict and the smallest visual/table that
lets the owner verify it. The correct number buried inside a comprehensive dump
does not count as observable evidence.

### Evidence is atomic across the conversation

A claimed result and the evidence required to judge it must be delivered in the
same owner-facing turn.

Do not stage evidence as separate conversational rewards:

- claim now, receipt later;
- receipt now, image later;
- ask whether the owner wants the visual;
- drip-feed tables after the conclusion.

For a visual claim, include the relevant visual immediately. For a numeric claim,
include the minimal deciding numbers immediately. Always include provenance.

If the complete proof does not fit comfortably, reduce the proof to the smallest
sufficient acceptance surface and link the exhaustive artifact separately.

Until that bundle is delivered together, the work is not presented and is not
eligible for acceptance.

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
