# Plan: close the tee-pad / basket detection gap to 18/18

Context: this plan targets the CV auto-annotation work originally on `agent/phase3-cv-integration`
(hole-number detection, tee-pad detection, basket detection, `courseGrammar.ts`), merged into
this branch to implement against.

**Status:** Phase 1 tee-pad work remains documented below. The approved Phase 2 basket detector
transplant is implemented and truth-scored against `resources/GoldenBasketSet.chainspot.zip`; the
browser worker uses the bounded production path and the broad scale sweep remains CLI-only.

## Current state

| Layer | Status | Source |
|---|---|---|
| Hole numbers | 18/18 | production TS (`holeNumberDetection.ts`), commit `c8a8273` |
| Tee pads | 14/18 | production TS (`teePadDetection.ts` fused path), commit `e328970` |
| Baskets | 18/18, 0 false positives | production TS (`basketDetection.worker.ts`) plus `npm run detect:baskets` against `GoldenBasketSet` |
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

## Progress

**Phase 0 fixture landed:** `resources/GoldenTeeSet.chainspot.zip` (+ `resources/TeeTestBlank.jpg`)
is a real course capture with ground-truth tee coordinates for all 18 holes
(`project.json`'s `holes[].tee`), checked in via `agent/phase3-cv-integration` and merged into
this branch. This unblocked actually measuring instead of guessing. Source image
(`images/source-original.jpg`, 1290x2091) is a phone photo of a satellite/map view with hand
overlays, not a UDisc in-app screenshot — a different visual domain than the Python probe's
clean-course fixture, and that difference explains most of what follows.

**Step 1 (full-resolution raster) and step 2 (map-bounds restriction) are implemented and kept**
in `detectCourse` (`basketDetection.worker.ts`).

**Step "wire in occluded-edge-loop" was implemented, measured, and reverted.** Against
`GoldenTeeSet`, it made zero difference to recall (still 12/18 matched, same 6 misses) — its one
contribution was to add a second support tag to an already-found gray-center candidate, which
promoted a false positive over a different false positive in the final ranked slice. Net neutral
here, but a real fragility (support-count ranking can promote a coincidentally-double-tagged wrong
candidate over a correct single-support one) with no offsetting benefit on real data. Dropped from
`detectTeePadCandidates` per direct instruction after seeing the measurement.

**New finding, not in the original plan: C2 dash false positives, fixed via size-consistency
filtering.** Every false positive in the `GoldenTeeSet` fused output turned out to be a Canny
fragment of a C2 putting-circle dash — passes the gray-center/edge-loop rectangle filters, but its
minor axis is roughly half a real pad's (~6-8px vs ~15.5px measured on this fixture). A first
attempt filtered by `heightPx < 0.75 * median(heightPx)`, but the uncapped gray-center detector
actually finds *more* dash fragments than real pads on this course (24 vs 14), so the population
median itself sits inside the dash range and the filter did nothing. Replaced with
`filterSizeConsistentCandidates` (`teePadDetection.ts`): find the largest *relative* gap in sorted
minor-axis values and, if it looks like a genuine bimodal split (≥30% relative jump, and the upper
cluster has ≥3 members), keep only the larger-size cluster — real pads are the larger physical
object regardless of which population is more numerous in the raw candidate pool. Wired into both
`detectTeePadCandidates` (production) and `detectTeePadVariants`'s `fused` branch (CLI/experiment
surface), so `npm run detect:tees -- ... --mode fused` reflects the same behavior.

**Measured result on `GoldenTeeSet.chainspot.zip`:** 18 candidates / 6 false positives →
13 candidates / 1 false positive (a near-miss at hole 10, off by ~7.5px against a 7.15px
tolerance — arguably a correct detection at a stricter-than-necessary tolerance). Matched/missed
set unchanged (still 12/18 — holes 2, 3, 5, 7, 10, 12 miss because gray-center/edge-loop simply
produce no candidate near truth there, not because of crowding), but false-positive rate dropped
~83%, which matters a lot for `courseGrammar`'s Hungarian assignment once basket detection is
verified too.

Sam separately ran the in-browser production build (pre-dating the occluded-edge-loop
revert/size-filter work) and reported misses at only 2, 3, 5, 12 (14/18) — a better number than
this branch's CLI measurement of 12/18 on the same fixture. That gap is unexplained and worth
resolving before trusting either number as "the" baseline (see Open questions).

Added `tests/unit/teePadDetection.test.ts` covering `filterSizeConsistentCandidates` directly
(clear bimodal split, too-small sample to judge, already-consistent set). Full unit suite (488
tests) and `tsc --noEmit` pass.

## Open questions

- **Reconcile the 12/18 (this branch's CLI, full-res + map-bounds) vs. 14/18 (Sam's in-browser
  production run, same fixture) discrepancy** before treating either as ground truth. Candidates:
  different code paths/build than what's on this branch, a different tolerance, or an environment
  difference in the OpenCV.js runtime vs. Node's `loadCv()`.
- Holes 2, 3, 5, 7, 10, 12 (this branch) / 2, 3, 5, 12 (Sam's browser run) still produce no
  candidate near truth at all — that's a genuine recall gap in gray-center/edge-loop on this
  image domain, not a crowding/precision problem, and needs its own investigation (likely
  per-hole crops + stage-count inspection, as Phase 1 step 4 originally proposed).

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

## Phase 2 — Basket detector transplant: complete

The production worker now uses the clean `basket.png` template through the shared pure detector,
with the proven 11x11 local-max suppression window and 0.96 bottom-center stem-base anchor. The
existing worker/API transport, course grammar, number detector, and tee detector are unchanged.
Both browser basket entry points use the bounded five-scale compatibility ladder; number-derived
scale selection remains solely in the existing tee path. The independent 0.4..4.0 basket-scale
sweep is intentionally exposed only by `npm run detect:baskets` for diagnostics.

Measured on `GoldenBasketSet.chainspot.zip` (default CLI discovery, 116.93s on this workstation):
18 candidates, all truth numbers 1 through 18 matched, 0 false positives, with discovered scale
1.85 and scores 0.727–0.919. The CLI writes both `baskets.json` and `baskets.png` overlays.

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
