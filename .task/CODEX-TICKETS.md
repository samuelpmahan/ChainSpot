# Codex ticket pack — Sprint 1/2 parallel lanes

Five independent tickets, one branch + worktree each. Shared rules for ALL:
follow docs/abfeature-contract.md conventions where features are touched;
parity pin (tests/unit/threeFactorParity.test.ts) and dev72 sweeps
(corpusSweep/dashsTrackSweep) must stay green/byte-identical unless the
ticket says otherwise; numbers claimed require evidence images or captured
output (artifacts/ is gitignored); explicit staging only; no pushes to the
rebuild branch — work stays on your ticket branch; no double quotes in
commit messages. The algorithm lives in packages/alg (@chainspot/alg,
CommonJS, tsc build: cd packages/alg && npm run build). Exec contract:
packages/alg/src/exec/contract.ts. Truth is evaluation-only, always.

## T1 — branch codex/c-artifact-renderers (HIGHEST PRIORITY, blocks Chunk C)
Implement the 8 artifact renderers for the lab sweep CLI against
scripts/chainspot-lab/sweep/rendererContract.ts (committed by the C lead —
poll for it; implement to it EXACTLY, report mismatches rather than
adapting the contract). Kinds: rgba, mask, scalarField (colormapped),
orientationField, componentSet, candidateSet, polyline, measurementTable.
rgba/mask/scalarField/orientationField -> PNG via pngjs; sets/polyline ->
text table + PNG overlay when a base rgba artifact is provided;
measurementTable -> aligned text + CSV. HARD RULE: render only what the
artifact contains — never recompute detector math. Per-kind golden test:
tiny synthetic artifact -> pinned output hash. Deliver: renderer module(s)
+ registry entries + tests.

## T2 — branch codex/tune-clean-basket-family
Tune cleanBasketFamily knobs (packages/alg/src/detectors/threeFactor/
features/g2.cleanBasketFamily.ts) so family criteria span all TRUE baskets
while still killing extras. MEASURE FIRST: harvest per-decision testimony
(areaRatio, whiteCoverage, darkShell, darkCoherence) for true-vs-false-
positive candidates across all 4 dev courses (unit emits these in trace
drawables; tests/unit/familyDeviationSweep.test.ts shows the dual-config
harness). Render distribution histograms per metric (images-with-numbers
law). If TRUE/FP overlap on every metric: STOP, report — no threshold can
win. Else: new defaults with stated placement rule + margin; verify via
familyDeviationSweep: extras 0 AND matched 18/18 all courses, G4
unchanged-or-better vs default. Re-pin resolved-config hash + regenerate
schema (drift test prints it). Baseline sweeps (default config) must stay
byte-identical.

## T3 — branch codex/heritage-g3-threshold-audit
Heritage G3 detects 14/18 tees (misses H5/H6/H10/H15, truth 70-224px from
nearest detection). Standing rule: dataset-fit thresholds are the FIRST
suspect. Audit: run the engine on Heritage (tests/unit/helpers/
courseFixture.ts loads it with the intake autocrop), harvest EVERY rejected
tee candidate near the 4 truth positions with its measured values (the
tees-unit trace emits rejection reasons+values), and compare against the
g3.endpoints windows (dims 8-42, area 80-350, fill 0.2-0.85, elongation
1.18, hole-area/ring knobs). Deliver: per-missed-hole verdict (candidate
existed and was window-clipped vs never detected at all), evidence images
(sweepRender helper exists in tests/unit/helpers/), and IF window-clipped:
a proposed experiment config (configs/ sparse deviation, do NOT change
defaults) demonstrating recovery + its full 4-course scoreboard impact.

## T4 — branch codex/sprint2-g-experiment-layer
Design + prototype threeFactor-experiment@1 (Sprint 2 Agent G, started
early against the frozen exec API). Spec: explicit axes (values |
start/stop/step) over feature knobs/enabled flags/execution order;
Cartesian expansion into CONCRETE sparse configs (INVARIANT: ranges never
enter an executable config — each candidate resolves+compiles to one exact
plan via packages/alg exec compile); reject invalid plans (compile errors
are per-candidate results, not crashes); dedupe by planFingerprint; corpus/
course selection; objective = per-gate sweep scoreboard deltas vs baseline;
ranked results table. Deliver: schema doc + JSON Schema, a runner harness
(vitest or node script) executing a SMALL real grid (e.g. cleanBasket
whiteCoverageMin x 3 values on DashsTrack) with captured ranked output. No
executor/engine changes at all.

## T6 — branch codex/c-sweep-completion (Codex OWNS Chunk C forward)
The lab sweep CLI works end-to-end (verified: scripts/chainspot-lab/sweep/,
run via `npx tsx sweep/sweepCli.ts sweep <config> <image> [truth]` from
scripts/chainspot-lab; DashsTrack: 17 ops, receipts, 9 artifacts, truth
scoreboard 18/18 G1-G4). Codex owns everything C-related from here:
(a) fix the conformance drift it exposed — badgeOcclusionPatch's
OperationSpec declares consumes=[] produces=[supportField] but actually
reads supportField+stage: correct the DECLARATION in packages/alg
operations to match reality (do not silence the check);
(b) swap sweep/inputShim.ts to the REAL G0 intake — packages/alg/src/g0/
+ adapters/node landed (CanonicalFrame, ledger, C3 match levels): sweep
should report the true G0 section (decode -> crop -> canonical frame ->
truth match level) instead of the shim;
(c) integrate T1's renderers via sweep/rendererContract.ts registry when
that ticket lands (until then stubs stand);
(d) `lab compile CONFIG` inspection subcommand if not complete; POSIX
./lab dispatch + documented Windows invocation;
(e) tests: labSweep unit tests + a pinned smoke (op count, scoreboard
values) added to the suite. Full battery green.

## T5 — branch codex/sprint2-f-receipt-viewers
Early slice of Sprint 2 Agent F: a receipts browser in the /lab web route
(src/routes/lab/ — additive page or section) that loads a sweep output
directory (receipts + artifacts from the CLI's deterministic out-dir; JSON
via file input or fetch from static/), and renders: compiled-plan list,
per-gate operation timeline with kind/ms/conformance badges, receipt
detail, artifact previews (PNG artifacts shown inline; tables rendered).
Browser-safe consumption only — HARD RULE render-never-recompute; no
engine invocation from this page; no browser-schedule timeline (needs
Sprint 2 D). Svelte 5 runes conventions per existing routes. Deliver: the
page + a checked-in tiny sample sweep-output fixture for dev/testing.
