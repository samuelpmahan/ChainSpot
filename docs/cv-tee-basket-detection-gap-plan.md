# Plan: close the tee-pad / basket detection gap to 18/18

Context: this plan targets the CV auto-annotation work on `origin/agent/phase3-cv-integration`
(hole-number detection, tee-pad detection, basket detection, `courseGrammar.ts`). That code
does not exist on this branch yet — this document is the plan for closing the gap, to be
executed against (or merged from) that branch.

## Current state

| Layer | Status | Source |
|---|---|---|
| Hole numbers | 18/18 | production TS (`holeNumberDetection.ts`), commit `c8a8273` |
| Tee pads | 14/18 | production TS (`teePadDetection.ts` fused path), commit `e328970` |
| Baskets | unverified, assumed 18/18 | production TS (`basketDetection.worker.ts`) — never explicitly measured against a truth set |
| Reference (Python probe) | 18/18 numbers, 18/18 baskets, 18/18 tees, 18/18 centerlines | `scripts/cv-probes/static_course_parser.py`, run against a real clean-course screenshot that is **not checked into the repo** |

The Python probe already solves this problem on a real fixture. The gap is a **porting/wiring
gap into the production TypeScript/OpenCV.js pipeline**, not an unsolved CV problem — `docs/cv-clean-course-pipeline.md` (on the CV branch) already says as much in its "Immediate order"
section ("port proven pieces to the existing OpenCV.js/WASM runtime").

## Root causes found by diffing production TS against the proven Python probe

Comparing `detectCourseCandidates` in `basketDetection.worker.ts` (the actual production
call path) against `scripts/cv-probes/static_course_parser.py` and against the TS experiment
surface (`scripts/detect-tees.ts`, `detectTeePadVariants`) turned up three concrete,
verifiable divergences — all in the tee-pad path:

1. **The `occluded-edge-loop` detector is orphaned.** `teePadDetection.ts` has a third
   detector (`detectOccludedEdgeLoopCandidates`) purpose-built to recover pads whose outline
   is broken by the C2 putting circle or the basket icon — exactly the failure mode the Python
   probe's fusion strategy was designed around. It is wired into the CLI (`scripts/detect-tees.ts`,
   `--mode occluded-edge-loop`) but **`detectCourseCandidates` in `basketDetection.worker.ts`
   only calls `detectTeePadCandidates`, which fuses `gray-center` + `edge-loop` and never
   touches occluded-edge-loop.** This is the highest-confidence, lowest-risk fix: the code to
   recover occluded pads already exists and is tested, it just isn't in the production fusion.

2. **Production runs on a downscaled raster.** `grayscaleRaster()` caps analysis at
   `MAX_ANALYSIS_DIM = 2200px` before any detector runs. Tee-pad rectangles are tiny
   (~13×8 UI px), and `teePadDetection.ts`'s thresholds (`5*scale`, `12*scale`, `0.06*perimeter`,
   etc.) are tuned tight against the Python probe's full-resolution `cv2.imread`. Downsampling
   first pushes some real pads' measured area/aspect just outside those windows. `teePadDetection.ts`
   already has a `fullResolution` raster path (used by the CLI/experiment surface) — production
   does not use it.

3. **Production never restricts tee-pad search to the course-map band.** `detectCourseCandidates`
   calls `detectTeePadCandidates(cv, raster, { uiScalePx })` with **no `mapBoundsPx`**, so
   `mapRows()` defaults to the full image height instead of the fairway-map row band the Python
   probe (`map_y = (400, 1350)`) and the CLI's `deriveMapBoundsFromNumbers()` both use. Any
   rectangle in the UI chrome (header, score panel, hole list) that happens to pass the
   gray-center/edge-loop filters becomes a false-positive candidate competing for the
   `maxCandidates = 18` slice in `sortAndSliceFused`, which can silently displace a real pad.

None of these are basket-detection problems per se, but (3) in particular means the current
14/18 number may be partly **precision-limited, not recall-limited** — i.e. some of the 4
"missing" pads may actually have been detected and then crowded out by off-map junk. That
needs to be checked before assuming detector sensitivity is the bottleneck.

Basket detection also structurally diverges from the proven probe (fixed absolute
`SEARCH_SCALES = [0.65, 0.8, 0.95, 1.1, 1.3]` instead of `uiScale`-relative
`linspace(uiScale*0.90, uiScale*1.10, 9)`, `MIN_SCORE = 0.42` vs the probe's `0.50`, and the
same downscaled-raster issue as (2)) — flagged in Phase 2 below because its output feeds
`courseGrammar`'s tee/basket polarity cost, so a basket error can look like a tee-assignment
error downstream.

## Phase 0 — Shared fixture + reproducible measurement (blocking prerequisite)

Nothing below can be verified without this. The Python probe's 18/18 was measured against a
real clean-course screenshot that lives only in a local/session path
(`/mnt/data/36F73C46-...jpeg` in `run_full_rerun.py`), not in the repo.

1. Get Sam's sign-off and check a clean, de-identified course-map screenshot into the repo
   (e.g. `tests/fixtures/cv/clean-course-01.png`), or otherwise make it available to CI.
2. `scripts/detect-tees.ts` already has `truthEvaluation` scaffolding (matched/missed/false-positive
   counts against a truth set). Extend the same pattern to numbers and baskets so a single CLI
   run reports all three counts against the shared fixture — turning "14/18" into a number any
   agent or CI run can reproduce, not a one-off manual observation.

## Phase 1 — Tee pads: 14/18 → 18/18

1. Wire `detectOccludedEdgeLoopCandidates` into the production fused path used by
   `detectCourseCandidates` (currently only `detectTeePadCandidates`, i.e. gray-center +
   edge-loop). Re-run against the Phase 0 fixture — expected to recover several of the 4 misses,
   since this detector exists specifically for pads broken by C2/basket occlusion.
2. Pass `mapBoundsPx` into the production tee-pad call, using the same
   `deriveMapBoundsFromNumbers()` heuristic already implemented for the experiment/CLI path
   (`basketDetection.worker.ts`'s `deriveUiScaleAndMapBounds`). Re-measure to see how much of
   the gap was false-positive crowding vs. genuine misses.
3. Route tee-pad detection through the full-resolution raster path (`fullResolution: true`)
   instead of the `MAX_ANALYSIS_DIM`-downscaled one production currently uses, given how tight
   the size/aspect thresholds are relative to raw pad size.
4. After each change, re-run the Phase 0 harness and log the score/support/stage-counts for any
   pad still missed (`TeePadStageCounts` already exposes per-stage rejection counts) — iterate
   on genuinely missed pads only, not by loosening thresholds broadly, to avoid trading misses
   for new false positives.

## Phase 2 — Verify (and if needed, close) the basket gap

1. Run the Phase 0 harness against baskets specifically and get a real number — do not assume
   18/18 holds in production; it has never been measured against a truth set.
2. If short of 18/18, port the `uiScale`-relative multiscale search
   (`linspace(uiScale*0.90, uiScale*1.10, 9)`) and NMS radius (`22*scale`) from the Python
   probe/tee-pad precedent, replacing the current fixed `SEARCH_SCALES` ladder and `MIN_SCORE = 0.42`.
3. Confirm the basket's semantic endpoint (bottom-center stem base, `y + 0.96*height`, not
   glyph/icon center) survives unchanged into `courseGrammar`'s basket-assignment cost, since
   that's the anchor the tee/basket polarity penalty depends on.

## Phase 3 — Course grammar: clarify what "bumps to 18/18" can mean

`courseGrammar.ts` performs one-to-one Hungarian assignment over whatever candidates the
detectors hand it — it cannot fabricate a tee or basket it was never given. So "18/18" out of
grammar can only ever mean **18/18 holes received *some* assignment**, not that grammar
recovers detector misses. If the expectation is that grammar itself closes the gap, that's a
mismatch with what the module does today — worth confirming before spending time on Phase 1/2.

1. Surface the existing `CourseGrammarFailure` reasons (`missing-tee`, `missing-basket`, etc.,
   already modeled) per-hole in the CLI/report output, so a run's true count is visible with
   *why*, not just an aggregate "14/18".
2. Once Phase 1/2 push both raw detector counts near 18/18, re-check the basket/tee polarity
   cost (`basketCost`, 80px opposite-direction penalty) on dense clusters (the documented H5/H6
   case) — that's the layer most likely to still mis-assign a *present* candidate.

## Phase 4 — Lock in the recovered accuracy

1. Add a hard assertion (numbers=18, tees=18, baskets=18 on the Phase 0 fixture), mirroring
   `run_full_rerun.py`'s `RuntimeError` gate in the Python probe, so future threshold tuning
   can't silently regress recall.
2. Add regression tests for whichever specific pads/baskets were recovered (extend
   `tests/unit/basketDetection.test.ts`, add `tests/unit/teePadDetection.test.ts`) so each fix
   is locked in individually.

## Suggested order

Phase 0 (need a measurable baseline) → Phase 1 (highest-confidence, lowest-risk: wire in
already-built code) → Phase 2 (verify baskets aren't secretly the real bottleneck) → Phase 3
(grammar visibility) → Phase 4 (regression safety).
