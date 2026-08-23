# TBS port — minimum required contiguous rail run

Branch: `codex/ab-tbs-min-required-run`. Port ONE bounded behavior: a candidate rail is not established by an average of scattered good samples; it must contain a contiguous run of qualifying samples. This is deliberately a pure run primitive so it does not invent what constitutes a rail hit.

Use current straight-test gate (`TBS`, `GS`, etc.). Deviation, default OFF.

## Why
The old four-lane sensor averages `tangentSamples=5` over only `±4px`. That permits `good / junk / good / junk / good` to score positively. Prior ChainSpot edge work saw a large gain from minimum-run semantics. In the fresh Dev72 experiment, aggregating evidence over longer contiguous spans also improved separation strongly.

Quick-pass held-out median AUC versus hard edge-like negatives:
- span 0px: composite residual .655, edge .577
- 6px: .717 / .670
- 12px: .742 / .748
- 18px: .756 / .771
- 24px: .767 / .794

These numbers motivate the primitive; do NOT hard-code 24px as truth.

## Exact bounded object
Input: ordered samples along one proposed rail, each sample supplied by caller with `(positionPx, qualifies:boolean)` or equivalent. This feature MUST NOT define edge/material qualification; other TBS sensors own that.

Compute contiguous run lengths in physical pixels. A run breaks on the first non-qualifying visible sample. Known-occluded/UNKNOWN samples must be represented separately from false: hidden evidence is neutral and must not be silently converted to a miss. If the eventual gate chooses to bridge UNKNOWN spans, that must be an explicit separate knob/behavior; default transcription here does not guess.

Expose:
- `sampleSpacingPx` (experiment used 3px for the run study)
- `minRequiredRunPx` (experiment swept effective spans 0,6,12,18,24px)

Return at least `longestRunPx`, pass/fail against the configured minimum, and run start/end indices for traceability. Deterministic tie: earliest longest run.

If integrated as a candidate rejector, every rejection must show the measured longest run and required minimum in the drawable reason/values.

Pure tests: scattered hits fail despite same hit count; exact boundary passes; one miss splits a run; UNKNOWN is not false; deterministic earliest tie. Follow `docs/abfeature-contract.md`; parity must not move.
