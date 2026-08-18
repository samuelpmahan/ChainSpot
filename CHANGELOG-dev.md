# ChainSpot dev changelog

One line per landed feature. Condensed/reset periodically; Git history keeps
prior contents.

## 2026-08-18 — CHSPT-TOPH-REPLAY: counterfactual CV-replay slice (ChainSpot side)

- `cvConfig.ts`: `ChainSpotCvConfig` / `P6Config` config root + `CV_PARAM_SCHEMA`, deep-frozen `DEFAULT_CV_CONFIG` matching today's hidden P6 constants exactly (forwardGateAngleDeg 80, swap enabled/minRibbonImprovementPx 20)
- P6: `deriveP6LowParBasketAssignment` (+ new `deriveP6GatedSnapshotPhase`/`deriveP6SwapPhase` exports) now take an optional `p6Config`; `swap.enabled=false` skips P6.2 with an explicit empty result
- `cvPipeline.ts`: `runPancakePipeline` — Pancake P1 through final display grammar extracted from `basketDetection.worker.ts`'s `PANCAKE_STACK_ONLY` branch into an observable stage seam (`StageExecutionRecord` per stage); the worker now delegates to it and accepts an optional `cvConfig` on `detect-course`
- `p6AssignmentScoring.ts`: scores a P6 result's assigned basket positions against supplied truth within a tolerance
- `scripts/cv-replay-run.ts`: headless, config-driven CLI that runs the real pipeline against an image or `.chainspot.zip` and emits stage records, the full P6 result, and correctness scoring when truth is available
- `scripts/lib/fakeBrowser.ts`: shared Node fake-browser plumbing, extracted out of `pancake-harness.ts` and reused by `cv-replay-run.ts`
- `resources/cv-fixtures/`: `TheRec-stitched.png` (2242x2215, real 9-hole course) + `the-rec.json` observed-baseline manifest (no independent basket ground truth yet — explicitly labeled as such)
- No production behavior change: `pancake-harness.ts` run against `AlexClarkSet.chainspot.zip` before/after this slice is byte-identical modulo timing fields

Verified: `npm run check` 0 errors; `NODE_OPTIONS=--experimental-require-module npx vitest run` — only
the same 44 pre-existing pointer-test failures in 6 UI files, zero new failures; new unit coverage for
config defaults/frozenness/schema-path validity, P6 forward-gate and swap-threshold threading (synthetic
fixtures), and the scorer. This is a ChainSpot-only slice of a larger cross-repo (Toph) contract; no
Toph adapter/viewer code lands here.

## 2026-08-18 — CHSPT-TOPH-REPLAY: Toph integration (adapter, viewer launcher, proof)

- `scripts/lib/cvReplayCore.ts`: extracted `cv-replay-run.ts`'s image/template loading and
  pipeline-execution machinery into importable `loadCvReplayContext`/`runCvReplayPipeline`; the CLI is
  now a thin wrapper around it (behavior unchanged, verified byte-identical output)
- `scripts/toph-replay-adapter.ts`: `createChainSpotReplayAdapter` — Toph `ReplayAdapter` implementation
  that runs the real pipeline headlessly and synthesizes a Toph trace from `StageExecutionRecord`s and
  P6's own gate/swap diagnostics (hole/basket/tee entities, P6.1 `assigned` and P6.2 `reassigned` relate
  events, per-pair `gte(ribbonImprovementPx, minRibbonImprovementPx)` checks); no `@toph`/toph imports in
  `src/lib` per the contract — synthesis happens only in this Node harness, after execution
- `scripts/toph-viewer.ts`: CLI launcher for Toph's diagnostic viewer wired to the adapter (see
  `docs/toph-replay.md`)
- `scripts/toph-replay-proof.ts`: end-to-end proof driven through `openReplaySession`/`replay`/`grid`/
  `firstDivergentStage` — confirms `p6.swap.enabled=false` diverges baseline exactly at
  `p6.swapAdjudication`, the grid over `minRibbonImprovementPx=[0,100,300]` swaps at 0/100 and not at 300,
  and a one-point grid toggle is equivalent to the same manual `replay()` call
- Screenshots of the viewer driven via Playwright confirm real entity/relate overlays (not an empty
  shell) and the A/B first-divergent-stage panel

Verified: `npm run check` 0 errors; CV/replay unit suites green, same 6 known-red UI pointer files as
before (no new failures). Production Svelte app untouched — this is a dev-tool surface only.

## 2026-08-17 — CHSPT-65: course + thrown-round inputs into Create Graphics

- Stitch Map: import prompt with thumbnails — pick the thrown round BEFORE any crop/stitch
- Stitch Map: "Thrown round" button on each loaded tile slot
- Stitch Map: pick the thrown round from a stitched result (clean map re-stitches without it)
- Stitch Map: "Keep as thrown round" for a single-capture result
- Stitch Map: persistent held-round banner with Discard
- Session: thrown-round slot, distinct from clean-source handoff, survives into Create Graphics
- Session: stale thrown round auto-cleared when a new course workflow starts
- Annotate Course: completion panel button "Continue to Create Graphics" (skips Map Round)
- Annotate Course: Holes selector 9/18 — 9-hole courses can now complete
- Annotate Course: completion blocked if confirmed holes exist beyond selected length
- Annotate Course: CV detection auto-selects 9 when all evidence is in holes 1–9
- Create Graphics: banner showing the carried thrown round
- Create Graphics: Fetch Clean Target moves above the panes until a clean target is committed
- Unchanged: Map Round route, direct image upload, correspondence/registration flow

Verified: `npm run check`; unit suites `thrownRoundFlow` + `annotateCourseCompletionHandoff`;
26/26 scripted Chromium checks; independent review addressed; staged for manual acceptance.
No unit coverage for detection→9 (needs real Worker). Six pointer-test suites red at clean
HEAD in the work container — pre-existing, unrelated.
