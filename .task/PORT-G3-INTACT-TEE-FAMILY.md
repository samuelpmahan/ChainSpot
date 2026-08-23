# G3 intact tee-family port

Base: `samuelpmahan/chspt-82-frontend-rebuild-rederive-the-mvp-from-a-clean-room-app`
Branch: `codex/ab-g3-intact-tee-family`

Port ONE default-OFF G3 behavior: refine baseline tee candidates to the repeated intact renderer family. Reference: `codex/three-factor-dev72-lab:scripts/chainspot-lab/courseSweep.ts`, functions `frameForRing`, `measureTee`, `selectTeeFamily`. Read `docs/abfeature-contract.md` and `features/g3.phantomTee.ts` first.

## Exact LAB math

For a tee-rect ring center `(cx,cy)`, enclosing bright-frame candidates satisfy:
- area `[10,500]`
- `bboxW <= 50`, `bboxH <= 50`
- ring center inside bbox, inclusive

If multiple frames contain the ring, choose smallest `bboxW*bboxH`; tie: larger `area`. No frame => candidate did not enter the measured family.

For every measured frame `s` as anchor, frame `f` joins its family iff all are true:

`abs(log(max(f.major,1)/max(s.major,1))) <= log(1.25)`

`abs(log(max(f.minor,1)/max(s.minor,1))) <= log(1.25)`

`abs(log(max(f.area,1)/max(s.area,1))) <= log(1.5)`

Anchor-family spread is the SUM over members of those three absolute log ratios. Choose maximum member count; tie => minimum spread. Output sorted by ring `cy`, then `cx`.

LAB gray payload (`145 <= max(R,G,B) <= 175`) was DIAGNOSTIC ONLY. It never selected/rejected this family. Do not add a gray kill rule.

## Engine shape

Preferred: deviation ABFeature, `defaultEnabled:false`, G3 EngineUnit after `tees`, consumes `stage, tees`, produces `tees`. Export a pure family-selector core. Use current `g3.endpoints` tee-rect/elongation semantics rather than duplicating an already-registered baseline knob.

Knobs, all validated:
- `frameAreaMin=10`
- `frameAreaMax=500`
- `frameMaxWidth=50`
- `frameMaxHeight=50`
- `majorRatioToleranceFactor=1.25`
- `minorRatioToleranceFactor=1.25`
- `areaRatioToleranceFactor=1.5`

Apply `Math.log` at the use site. Do NOT invent a minimum family cardinality; the LAB sweep compared final family count to `numBadges` outside this selector.

## Trace contract

No silent drops. Emit rejected drawables with specific reasons for: no valid enclosing frame; measured frame excluded from winning family; any adapter-level tee candidate the feature deliberately rejects. Include numeric frame geometry in `values`; a generic `not family` reason is insufficient.

## Proof

Add experiment config enabling/inserting the unit. Registry line + engine line if a unit. Regenerate schema. Run all four guards. `threeFactorParity` MUST NOT move. `threeFactorConfig` pin is expected to move. Add pure-core tests for exact ratio boundaries, largest-family choice, spread tie-break, and deterministic output order.
