# TBS port — course-local four-lane width calibration

Branch: `codex/ab-tbs-course-width`. Port ONE bounded behavior from `codex/three-factor-dev72-lab:src/lib/nuthing/fourLaneRibbon.ts`: `estimateFourLaneCorridorWidth`. It depends on the pure four-lane observation function but must not import final tracking/search behavior.

Use current straight-test gate (`TBS`, `GS`, etc.). Deviation, default OFF.

## Exact LAB math
Input is image + already-frozen Tee→Badge segments + known occluders + candidate widths. Defaults:

`candidateWidthsPx = [24,30,32,36,40,48,56,64]`

Fractions along each frozen Tee→Badge segment are exactly:

`[0.2,0.35,0.5,0.65,0.78]`

For each candidate width `W` and each segment:
- heading = `atan2(badge.y-tee.y, badge.x-tee.x)`
- at each fraction `f`, state center = `tee + f*(badge-tee)`
- state heading is frozen heading; width=W
- call the four-lane cross-section observer
- if observation score is non-null, append it

For width W:
`meanScore = arithmetic mean(visible scores)`; if no visible scores => `-Infinity`
`visibleSamples = count(visible scores)`

Choose width by deterministic sort:
1. higher `meanScore`
2. tie: higher `visibleSamples`
3. tie: smaller `widthPx`

Return chosen width plus all candidate rows. Fallback if no best: first candidate width, then 40.

Knobs: candidate width array and the five fractions must be configurable and validated (positive finite widths; fractions in [0,1], nonempty). Do not invent basket/path inputs.

Dev72 measured result from the exact old implementation: Dash estimated 40 for truth 40; Heritage 30/30; Lenard 36/37; TowneLake 36/37. Preserve these as fixture expectations if source rasters are available to the branch; otherwise pin pure synthetic math and report corpus validation separately.

Follow `docs/abfeature-contract.md`. Default OFF, config-enabled. Parity pin must not move.
