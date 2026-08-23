# Tee-family port — recon brief (coordinator-verified, do not re-derive)

Companion to `.task/PORT-G3-INTACT-TEE-FAMILY.md` (the authoritative spec).
Two read-only recon passes produced this; the LAB source below is VERBATIM
from `origin/codex/three-factor-dev72-lab:scripts/chainspot-lab/courseSweep.ts`
(commit ef2a4fc) — reproduce the math exactly, adapt only names/types.

## Verbatim LAB reference

```typescript
function frameForRing(ring: TeeRing, components: readonly ComponentStats[]): ComponentStats | null {
  const candidates = components.filter((c) => c.area >= 10 && c.area <= 500 && c.bboxW <= 50 && c.bboxH <= 50 && ring.cx >= c.bboxX && ring.cx <= c.bboxX + c.bboxW && ring.cy >= c.bboxY && ring.cy <= c.bboxY + c.bboxH);
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH || b.area - a.area)[0];
}

function selectTeeFamily(measures: readonly TeeMeasure[]): TeeMeasure[] {
  let best: TeeMeasure[] = []; let bestSpread = Infinity;
  for (const seed of measures) {
    const s = seed.frame;
    const family = measures.filter((m) => {
      const f = m.frame;
      return Math.abs(Math.log(Math.max(f.major, 1) / Math.max(s.major, 1))) <= Math.log(1.25) && Math.abs(Math.log(Math.max(f.minor, 1) / Math.max(s.minor, 1))) <= Math.log(1.25) && Math.abs(Math.log(Math.max(f.area, 1) / Math.max(s.area, 1))) <= Math.log(1.5);
    });
    const spread = family.reduce((sum, m) => sum + Math.abs(Math.log(Math.max(m.frame.major, 1) / Math.max(s.major, 1))) + Math.abs(Math.log(Math.max(m.frame.minor, 1) / Math.max(s.minor, 1))) + Math.abs(Math.log(Math.max(m.frame.area, 1) / Math.max(s.area, 1))), 0);
    if (family.length > best.length || (family.length === best.length && spread < bestSpread)) { best = family; bestSpread = spread; }
  }
  return best.slice().sort((a, b) => a.ring.cy - b.ring.cy || a.ring.cx - b.ring.cx);
}
```

`measureTee` just pairs a ring with `frameForRing`'s result (null frame =>
excluded) plus a `grayStats` payload. The grayStats 145-175 check is
DIAGNOSTIC ONLY — the spec forbids porting it as a gate; do not port it at
all (the trace channel replaces its telemetry role).

LAB call site (what the trio operated on):
```typescript
const teeRings = ringsRaw.filter((r) => r.kind === 'tee-rect' && !insideBadgeInterior(r.cx, r.cy));
const teeMeasures = teeRings.map((r) => measureTee(image, r, badgeStage.brightComponents)).filter((x): x is TeeMeasure => x !== null);
const teeFamily = selectTeeFamily(teeMeasures);
```

## Engine seam facts (verified against current HEAD of the rebuild branch;
## this branch is at 868431f — features/knobs referenced below all exist there
## EXCEPT the cluster 9/10 features, which do not matter here)

- `stage` slot => `BadgeStageResult` with `brightComponents: ComponentStats[]`,
  and `ComponentStats` ALREADY HAS `major`, `minor`, `area`, `bboxX/Y/W/H`,
  `cx`, `cy` (PCA projected extents, components.ts) — no new axis math needed.
- `tees` slot => `TeeEvidence[]`: `{ detId, xPx, yPx, tier: 'ring'|'component'|'recovered',
  angleRad, ring?: { bbox, area, elongation, ringFrac }, bbox, area, fill, onRing, recovery? }`.
  Coordinates are original-image px; a viewport `topPx` offset was applied by
  makeTees — ring centers from the tees slot are already offset, while
  stage.brightComponents bboxes are in STAGE-LOCAL coordinates (pre-offset).
  CHECK THIS CAREFULLY: makeTees adds `yOffsetPx` to component/ring y-coords
  when building TeeEvidence. Your containment test (ring center inside frame
  bbox) must compare in ONE coordinate system — read measure.ts makeTees to
  confirm which, and document the choice in the feature file. A mismatch here
  is the port's most likely silent bug.
- Unit template: `features/g3.phantomTee.ts` phantomTeeUnit — copy its shape:
  gate 'G3', enabled no-op guard, span, overlay/measure taps, board.set to
  re-produce a slot.
- Your unit: `{ id: 'teeFamily', gate: 'G3', consumes: ['stage','tees'], produces: ['tees'] }`,
  inserted in the experiment config's execution AFTER 'tees' (before 'rawPairs',
  so downstream pairing sees the refined list). Registry: ALL_FEATURES line;
  engine.ts: ENGINE_UNITS line. NOT in DEFAULT_EXECUTION.
- Scope rule derived from the LAB call site: the LAB measured ONLY
  `kind === 'tee-rect'` rings => in the engine, refine only tier 'ring' tees
  (they are the tee-rect survivors); tiers 'component' and 'recovered' pass
  through UNTOUCHED with an info drawable noting 'not in family scope
  (tier X)'. Rejecting those tiers would exceed the ported behavior.
- Ring-tier tees carry `ring.bbox`/`ring.area` but NOT the ring center pre-offset;
  `xPx/yPx` is the tee point. Use the tee's ring geometry per your coordinate
  determination above.

## Knobs (spec-fixed, all on the new feature, defaults byte-equal)

frameAreaMin=10, frameAreaMax=500, frameMaxWidth=50, frameMaxHeight=50,
majorRatioToleranceFactor=1.25, minorRatioToleranceFactor=1.25,
areaRatioToleranceFactor=1.5. Math.log applied at the use site. All with
validate() (positive; tolerance factors > 1). NO minimum-family-size knob
(spec forbids inventing one).

## Trace contract (spec, restated)

Rejected drawables with SPECIFIC reasons + numeric geometry in values for:
(a) ring tee with no valid enclosing frame — reason names which filter(s)
excluded every candidate or that zero candidates contained the center;
(b) measured tee excluded from the winning family — reason includes the
failing log-ratios vs the winning seed; (c) anything else deliberately
dropped. Accepted family members get accepted drawables with frame geometry.
Generic 'not family' is explicitly insufficient per the spec.
