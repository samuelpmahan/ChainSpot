# KERCHOOOOO performance stack port — report

Date: 2026-08-28 (executed 2026-08-29 UTC)
Merge commit: `689d046` (`26135bb` + `origin/perf/kerchooo-v9` @ `fa4f1df`)

## What was ported

`origin/perf/kerchooo-v9` forked directly from the current
`continuation/intake-engine` tip (`26135bb` is the exact merge base), so
`git merge --no-ff origin/perf/kerchooo-v9` applied with **zero conflicts**
against a clean two-file diff:

- `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts`
- `packages/alg/src/detectors/threeFactor/ribbon.ts`

Mechanics carried over (their commit messages, `[kerch-done]` tagged on the
source branch):

| Version | Mechanic |
|---|---|
| v4 | Rotate cached badge-ray vectors through recovery poses instead of recomputing them per pose |
| v5 `[kerch-done]` | Cache `SupportField` sampling geometry across calls instead of rebuilding it each invocation |
| v6 `[kerch-done]` | Skip duplicate recovery refits for poses already evaluated (dedup) |
| v9 `[kerch-done]` | Prune impossible recovery poses before scoring them; take ribbon gradients directly instead of via finite differencing |

v2 ("reuse recovery poses and support sampling geometry") and v3 ("skip
provably irrelevant recovery/ribbon work") exist as separate commits
elsewhere in the repo's history but are **not** separate commits on the
`kerchooo-v9` branch itself — that branch's v4 commit already carries their
cumulative diff against the same base. There is nothing left over from
v2/v3 to port independently; porting v4 ported them.

## What was excluded, and why

- **v7 ("exact pose broadphase") and v8 ("direct gradient sampling
  probes")** are not part of `perf/kerchooo-v9`'s direct ancestry (they
  live on sibling branches / were probed and abandoned) and were not
  merged.
- **Transient CI/benchmark scaffolding** — `.github/kerchooo_v*_patch.py`
  and `.github/workflows/kerchooo-*.yml` — appear and disappear across the
  branch's intermediate "Stage" / "Benchmark" commits but net to zero in
  the final tree, so none of it landed in the merge. Confirmed via
  `git diff --stat continuation/intake-engine..origin/perf/kerchooo-v9`,
  which shows only the two source files above.
- No knob, threshold, or test-expectation files were touched by the merge
  or by this port; no such changes were made.

## Parity verdict: EXACT

Re-swept all three courses with
`packages/alg/src/detectors/threeFactor/configs/default.json` before and
after the merge. The `HOLE ASSIGNMENTS` block of
`run.visual.receipt.txt` (badge -> hole -> tee -> basket, score, hole
confidence) is **byte-identical** before/after for all three:

- DashsTrack (`DashsTrack-full.jpg`)
- HeritagePark (`HeritagePark-full.png`)
- NorthPark (`NorthPark-full.png`)

`diff` on the extracted blocks produced no output for any course. Full
receipts are saved under
`artifacts/orchestration/kerchooo-port/{before,after}/<course>-full/`
(`run.receipt.txt`, `run.receipt.json`, `run.visual.receipt.txt`) — this
directory is gitignored (`artifacts/`), so it is local evidence, not
committed.

## Timing table

All times in ms, from each run's `TIMING BREAKDOWN` / `OPERATIONS`
sections (`timings.operationBodyMs` and the G4 `teeRecovery` / G5
`supportField` operation rows).

| Course | Metric | Before | After | Speedup |
|---|---|---:|---:|---:|
| DashsTrack | operationBodyMs | 37,916.4 | 19,521.1 | 1.94x |
| DashsTrack | teeRecovery (G4) | 10,619.7 | 4,672.0 | 2.27x |
| DashsTrack | supportField (G5) | 17,421.7 | 5,514.1 | 3.16x |
| HeritagePark | operationBodyMs | 96,833.6 | 29,288.7 | 3.31x |
| HeritagePark | teeRecovery (G4) | 70,160.9 | 14,419.1 | 4.87x |
| HeritagePark | supportField (G5) | 17,174.7 | 5,725.9 | 3.00x |
| NorthPark | operationBodyMs | 58,123.3 | 21,196.1 | 2.74x |
| NorthPark | teeRecovery (G4) | 31,470.9 | 6,277.4 | 5.01x |
| NorthPark | supportField (G5) | 17,275.1 | 5,778.0 | 2.99x |

Wall-clock `time ./lab sweep ...` for the three courses combined:
before 42.76s + 102.19s + 63.50s = 208.4s total;
after 23.83s + 33.62s + 25.43s = 82.9s total (~2.51x combined). The
owner-reported 42.95s -> 15.78s (~2.72x) figure was from a different
(presumably single-course, possibly warmer-cache) measurement context;
this port reproduces the same class of speedup on all three Dev6 courses
swept, with HeritagePark (the largest/slowest course, and the one with
the most recovered-tee work) showing the largest gain.

## Verification steps run

1. `npm run build -w packages/alg` — clean.
2. `npm run check` — `0 ERRORS 0 WARNINGS` across 612 files.
3. `npm run test:unit` — 461 passed, 5 expected-fail, 3 skipped, 1 todo,
   **1 failed**: `tests/unit/corpusSweep.test.ts > Heritage gate sweep >
   G1 — badge count + digit reads`. This is an `xfail`-style test pinned
   to a known G1 digit-read gap (16/18, missing H2/H15) that now reads
   18/18 — i.e. the test expects a failure that isn't happening. Verified
   **pre-existing**: reproduced identically (same failure, same message)
   on `HEAD` *before* this merge, via `git stash` + rerun. G1 badge/digit
   reading is untouched by this port (the two changed files are G3/G4/
   ribbon-only), so this is unrelated drift already present on
   `continuation/intake-engine` tip, not something this port introduced.
   Not fixed or re-pinned here — out of scope for a perf-only port.
4. Parity re-sweep (see above).

## Fences respected

- No knob/threshold/test-expectation changes.
- No pin-test edits (none of the merge's two files are covered by the pin
  suite mentioned in the brief; plan structure is unaffected — the ported
  code changes *how* recovery poses are searched/scored/cached, not the
  plan/gate schedule).
- No pushes. No reverts of unrelated work.
- One merge commit (`689d046`), not a push.
