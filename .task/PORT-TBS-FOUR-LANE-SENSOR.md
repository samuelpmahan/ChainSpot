# TBS port — four-lane cross-section sensor

Branch: `codex/ab-tbs-ribbon-primitives`. Base is CHSPT-82 clean-room branch. Port ONE bounded behavior: the pure cross-section observation math from `codex/three-factor-dev72-lab:src/lib/nuthing/fourLaneRibbon.ts`, specifically `sampleBand` + `observeFourLaneCrossSection`. Do not port tracking/search/badge transit here.

Use whatever straight-test gate exists when you implement (`TBS`, `GS`, etc.); do not force G5 just because the old file lived there. Deviation, default OFF, all tunable constants in config.

## Geometry contract
For corridor width `W`: four equal lanes each width `W/3`; lane centers exactly `[-W/2,-W/6,+W/6,+W/2]`. Outer centers ride rails. Heading tangent `t=(cos h,sin h)`, normal `n=(-sin h,cos h)`.

`sampleBand`: sample `tangentSamples=5` points uniformly from `-tangentHalfPx` to `+tangentHalfPx`, default half-span `4px`. Gray is `(R+G+B)/3`. Samples inside known occluders are blocked/neutral. Band is occluded iff `blocked*2 >= n` OR zero visible samples. Otherwise band value is mean visible gray.

Guards at normal offsets `±2W/3`; visible guards average to local ground. Inner lane at offset `o` samples bands at `o + {-laneWidth/3,0,+laneWidth/3}`; if >=2 sub-bands occluded or no visible or ground unknown => inner unknown. Otherwise inner score=`clamp01((mean-ground)/liftReference)`.

Rail at offset `r`: inside band at `r + insideSign*edgeDeltaPx`; outside at `r - insideSign*edgeDeltaPx`. Left rail uses `r=-W/2, insideSign=+1`; right uses `r=+W/2, insideSign=-1`. Unknown if either band occluded/missing. Otherwise score=`clamp01((inside-outside)/liftReference)`.

Paired: both rails visible => `railScore=min(L,R)`. One-sided: exactly one visible => that score. Both hidden => null/UNKNOWN. `innerScore=min(visible inner scores)` or null. Final cross-section score is `min(all non-null of railScore,innerScore)` or null.

Knobs: `edgeDeltaPx=2.5`, `liftReference=45`, `tangentHalfPx=4`, `tangentSamples=5`. Validate positive values and integer sample count. Lane geometry is identity, not a tunable.

Known-hidden expected pixels are neutral, never zeros. Export pure core and tests for paired, one-sided, fully occluded, majority-hidden, exact lane offsets, and score math. Trace should expose lane/rail measurements; no candidate kills are required unless an adapter actually rejects something. Follow `docs/abfeature-contract.md`; parity must not move.
