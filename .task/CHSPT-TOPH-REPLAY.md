# CHSPT-TOPH-REPLAY — ChainSpot side of counterfactual CV-replay slice

> No Linear ticket exists for this work in this environment. `CHSPT-TOPH-REPLAY`
> is a placeholder ID used only to satisfy the `.task/<LINEAR-ID>.md` convention;
> replace with the real Linear ID if/when one is created, and file this task
> properly in Linear before merging to `main` per the standard workflow.

## Goal

Give ChainSpot's Pancake CV pipeline (P1 → P6.2 → final display grammar) a
config-driven replay seam so a counterfactual-replay tool (Toph, developed in
a sibling repo against a pinned cross-repo contract) can re-execute the whole
pipeline against a fixed image with different parameter values and observe
each stage's inputs/outputs, without ChainSpot ever depending on Toph.

This is the ChainSpot-owned half of a pinned contract
(`replay-contract.md`, sections 1, 3, 7, 8, 10 assigned to ChainSpot):
a config root (`cvConfig.ts`), a parameter schema Toph can render controls
from, a stage seam extracted from the worker's pipeline, P6 config threading
(the only stage with real runtime levers today), a scoring module, a
canonical fixture image + truth manifest, and a headless Node runner that
exercises the whole thing without a browser.

## Required behavior

- `src/lib/autoAnnotation/cvConfig.ts` exports `ChainSpotCvConfig`,
  `P6Config`, `P1Config`..`P5Config` (reserved, empty), `DEFAULT_CV_CONFIG`
  (deep-frozen, values equal to today's hidden constants exactly:
  `forwardGateAngleDeg: 80`, `swap.enabled: true`,
  `swap.minRibbonImprovementPx: 20`), `ParamSpec`, and `CV_PARAM_SCHEMA`
  covering `p6.swap.enabled`, `p6.swap.minRibbonImprovementPx`,
  `p6.forwardGateAngleDeg`.
- `deriveP6LowParBasketAssignment` (and its two newly-exported phase
  functions, `deriveP6GatedSnapshotPhase` / `deriveP6SwapPhase`) accept an
  optional trailing `p6Config: P6Config = <today's constants>`, threading
  `forwardGateAngleDeg` into the forward gate and `minRibbonImprovementPx`
  into the swap-eligibility check. `swap.enabled = false` skips the swap
  phase entirely and returns an explicit empty `P6SwapAdjudicationResult`
  (`{ pairsConsidered: 0, swapsApplied: 0, changedHoleNumbers: [], ms: 0,
  pairs: [] }`), never `undefined`.
- `src/lib/autoAnnotation/cvPipeline.ts` extracts the worker's
  `PANCAKE_STACK_ONLY` chain (P1 → final display grammar) into
  `runPancakePipeline(input, config, observer?)`, emitting one
  `StageExecutionRecord` per canonical stage id (`source`,
  `p1.rawObjectMask`, `p2.holeNumbers`, `p3.ownership`,
  `p4.ribbonSegmentation`, `p4.ribbonOwnership`, `p5.sparseAssignment`,
  `p6.lowParAssignment`, `p6.swapAdjudication`, `final.displayGrammar`).
  `basketDetection.worker.ts` delegates to this instead of running the chain
  inline; the worker still owns all browser-only rasterization
  (`OffscreenCanvas`/`ImageBitmap`) and reassembles its existing
  `performanceReport`/result shape around the pipeline's output so the app
  sees byte-identical behavior.
- `CourseDetectionRequest` gains an optional `cvConfig?: ChainSpotCvConfig`
  field, defaulting to `DEFAULT_CV_CONFIG` when absent.
- A canonical fixture (`resources/cv-fixtures/TheRec-stitched.png` +
  `the-rec.json`) records the observed (not independently verified) P6
  baseline behavior for a real 9-hole course, for use by replay tooling and
  regression comparison.
- A headless, config-driven runner (`scripts/cv-replay-run.ts`) runs the
  real pipeline against an image or `.chainspot.zip` with an arbitrary
  config and emits a single JSON result including per-stage records, the
  full P6 result, and (when truth is available) a correctness score from
  the new `src/lib/autoAnnotation/p6AssignmentScoring.ts`.

## Non-goals

- No Toph adapter, viewer, or trace-synthesis code lives in this repo or
  this task. `src/lib` never imports Toph and never gains `@toph`
  annotations — trace synthesis from `StageExecutionRecord`s is entirely a
  concern of a future Node harness (or Toph itself), built from the pipeline's
  own rich diagnostics after the fact.
- No config patch/diff/run-store machinery (Toph sections 2, 4, 5, 6 of the
  pinned contract) — that is Toph's responsibility.
- No "zero-bend shortcut" P6 lever. It was investigated and found to not be
  a real P6 runtime option (see `cvConfig.ts` comment) — do not add it.
- No behavior change to production output under `DEFAULT_CV_CONFIG`. This is
  a pure refactor-plus-additive-surface change; every existing call site's
  observable output must stay identical.
- No change to the non-`PANCAKE_STACK_ONLY` detection branch (still used
  when the dev-only flag is off) beyond what's required to keep it
  type-checking against shared imports.

## Known context

- `PANCAKE_STACK_ONLY` is a `TEMP DEV ONLY` flag in
  `basketDetection.worker.ts`; only that branch is in scope for the stage
  seam.
- The existing `scripts/pancake-harness.ts` already runs the real worker
  headlessly in Node via thin identity-copy shims for
  `OffscreenCanvas`/`ImageBitmap`/`self.postMessage`; this task's new
  `scripts/cv-replay-run.ts` shares that plumbing rather than reimplementing
  it.
- `TheRec-stitched.png` was produced (in a prior investigation, outside this
  task) by headlessly stitching `resources/stitch-annotate/TheRec/TheRec-L.PNG`
  + `TheRec-R.PNG` through the repo's `smartImportFiles` crop and
  `renderStitchedPng` math. A previously-referenced 2244×2212 artifact from
  that investigation was not bit-reproducible from a fresh run and is
  superseded by this fixture; there is currently no independent
  human-verified basket ground truth for this image — `the-rec.json` records
  observed pipeline behavior, explicitly labeled as such, not verified truth.
- Six pointer-interaction UI test files are pre-existing red in this
  container (documented in `CHANGELOG-dev.md`); this task must not add any
  new failures beyond those.

## Acceptance

- `npm run check` — 0 errors.
- `NODE_OPTIONS=--experimental-require-module npx vitest run` — no new
  failures versus the documented 44 pre-existing pointer-test failures in 6
  UI files.
- `scripts/pancake-harness.ts` run against `resources/AlexClarkSet.chainspot.zip`
  before and after this change produces semantically identical JSON (all
  fields except wall-clock/performance timing fields).
- `scripts/cv-replay-run.ts --image resources/cv-fixtures/TheRec-stitched.png`
  with default config reproduces the documented observed P6 behavior: P6.1
  gated hole7→basket4, hole8→basket3; P6.2 swaps to hole7→basket3,
  hole8→basket4 (swapsApplied 1).
- The same run with `p6.swap.enabled=false` in the config file keeps
  hole7→basket4, hole8→basket3, with `swapAdjudication.pairsConsidered = 0`.
- New unit tests cover `cvConfig` defaults/frozenness/schema-path validity,
  P6 toggle semantics (swap enabled/disabled, threshold boundary), and the
  new scorer.

## Proof Plan

- **Highest-value invariant — production parity under `DEFAULT_CV_CONFIG`.**
  The stage-seam extraction (`cvPipeline.ts`) is the riskiest change in this
  task: it moves ~200 lines of call-and-assemble logic out of the worker
  without being allowed to alter behavior. Proof: capture the real
  `pancake-harness.ts` JSON output against `resources/AlexClarkSet.chainspot.zip`
  before touching `src/`, capture it again after all changes land, and diff
  the two (ignoring only timing fields) — they must be identical. This is
  the single most load-bearing piece of evidence in this task and is run and
  saved verbatim as part of the final report.
- **P6 config-threading correctness.** Unit tests exercise
  `deriveP6GatedSnapshotPhase`/`deriveP6SwapPhase` (or, where the ribbon
  segmentation/corridor evidence plumbing is too entangled to fabricate
  cheaply, the pure swap-eligibility boundary directly) to confirm: a
  ribbon-improvement value at/above `minRibbonImprovementPx` is eligible,
  just below is not; `swap.enabled=false` short-circuits to the documented
  empty `P6SwapAdjudicationResult` with the gated snapshot passed through
  unchanged; changing `forwardGateAngleDeg` changes which candidates pass
  the gate.
- **Real-image reproduction of the documented Rec baseline.** Running
  `cv-replay-run.ts` against the new `TheRec-stitched.png` fixture with
  default config must reproduce the exact documented P6.1/P6.2 outcome
  (hole7/hole8 swap, `ribbonImprovementPx ≈ 236.05`) captured from the same
  pipeline in a prior investigation, and running it again with
  `p6.swap.enabled=false` must suppress the swap. Both outputs are saved
  under the scratchpad as proof artifacts.
- **Config/schema surface.** Unit tests assert `DEFAULT_CV_CONFIG` is frozen
  (mutation throws or is silently rejected in strict mode), its `p6` values
  equal the pre-existing module constants by direct import, and every
  `CV_PARAM_SCHEMA` entry's `path` resolves to a real leaf in
  `DEFAULT_CV_CONFIG` with a `default` matching the value found there —
  catching schema/config drift automatically rather than by inspection.
- **Regression gate.** `npm run check` (0 errors) and
  `NODE_OPTIONS=--experimental-require-module npx vitest run` compared
  failure-by-failure against the documented 44 pre-existing pointer-test
  failures in 6 UI files — any new failure blocks this task.
- **Out of scope for automated proof.** Whether Toph can actually consume
  this seam end-to-end is not provable from this repo alone; that is proven
  on the Toph side against the same pinned contract and is out of scope for
  this Proof Plan.
