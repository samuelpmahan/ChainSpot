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

## Task creation, review, staging, and merge

The canonical product/process definition lives in Linear: **Development Task Creation, Review & Merge Workflow**. These repo rules are the operational mirror. If they drift, update `AGENTS.md` to match Linear rather than inventing a third workflow.

### Artifact ownership

- **Linear ticket** — permanent product intent: problem, desired behavior, scope/non-goals, acceptance criteria, known repros/fixtures.
- **`.task/<LINEAR-ID>.md`** — branch-only implementation contract and implementer Proof Plan. It must not accumulate on `main`.
- **Implementer Review Brief** — short factual handoff for an independent reviewer. Put it in the PR or Linear discussion, not another committed Markdown file.
- **`CHANGELOG-dev.md`** — rolling record of what actually landed and how it was verified. During pre-version development, condense/reset it every few days as useful; Git history preserves prior contents. Once releases matter, promote useful entries into `CHANGELOG.md` and reset the dev log.
- **Code/tests/permanent docs** — durable system truth.

Rule: Linear says what we wanted; `.task` says what the agent was authorized to do; the Review Brief says what the implementer changed and tried to prove; `CHANGELOG-dev.md` says what landed; executable code/tests/docs say how the system really works.

### Task start

For a normal implementation task:

1. Create/read the Linear ticket first.
2. Create a branch from the intended base, normally current `main`; prefer Linear's generated branch name.
3. Before production-code changes, commit `.task/<LINEAR-ID>.md` as the task-definition commit.
4. The task file must state Goal, Required behavior, Non-goals, Known context, Acceptance, and a **Proof Plan** section.
5. Before implementation, the implementer fills the Proof Plan in roughly 3–5 bullets: highest-value invariant, key regression test, whether browser/manual proof is required, nearby regression risk, and important automated-test limitations.
6. If repo reality materially contradicts the task, report the conflict instead of silently redesigning the task.

### Implementation and review

- Stay inside authorized scope unless the task definition becomes invalid.
- Durable discoveries belong in existing permanent docs, not in `.task`.
- After implementation, provide a short **Review Brief** containing: Changed, Proof attempted, Highest-risk assumptions, and Please independently verify.
- The implementer's own correctness explanation is not an independent correctness verdict.
- A fresh reviewer must read the Linear ticket, `.task`, diff/tests, and Review Brief, then independently judge both implementation correctness and whether the proposed proof actually proves the behavior.
- Reproduce the highest-risk behavior where practical. Give extra scrutiny to browser interaction, coordinate transforms, cross-route handoffs, state synchronization, timing, and other integrated behavior that isolated tests can miss.
- Accepted review findings return to the implementation/review loop before merge prep.

### Merge prep

Once review findings are resolved, a merge-prep pass must:

1. update permanent docs only if durable knowledge changed;
2. create or append `CHANGELOG-dev.md` with the behavior that actually landed and the verification/review result;
3. delete `.task/<LINEAR-ID>.md`;
4. run the appropriate verification for the reviewed branch;
5. make no new feature changes during merge prep.

`.task/` should be empty on a merge-ready branch unless multiple already-reviewed tasks are intentionally being merged together. The deleted task definition remains available in Git history.

### Staging and manual acceptance

- Production repo: `samuelpmahan/ChainSpot`; production deploys only from `main`.
- Staging repo: `samuelpmahan/ChainSpot-staging`.
- Preferred gate: `implementation -> fresh review -> merge prep -> staging -> manual acceptance -> merge main -> production`.
- Build the exact reviewed/merge-prep ChainSpot SHA and publish that build to `ChainSpot-staging`. Staging represents the one change/set currently awaiting manual acceptance, not a permanent parallel development branch.
- A staging failure returns to the same Linear task unless required scope materially changes. Fix, re-review as appropriate, then redeploy the new reviewed SHA.
- Merge the manually accepted SHA, or a mechanically rebased equivalent with no behavior changes. Do not make behavior changes between staging acceptance and production merge.

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
