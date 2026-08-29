# DashsTrack H12 tee: what the detector believes (branch tip, post-KERCHOOOOO port)

Scope: report only the DETECTOR's stored belief about H12's tee — corners,
center, axis, ray to its badge, and how that belief was produced. Not a
ground-truth measurement (a sibling agent is doing that from raw pixels).

## 0. Which run this is

The on-disk receipt at `artifacts/sweep/dev72-recovered-default/DashsTrack-full/`
was read first (revision `26135bbf...+dirty`) and matched exactly, byte for
byte on the numbers below, the fresher copy at
`artifacts/orchestration/kerchooo-port/after/DashsTrack-full/` (same
revision, same `config.paramsHash`). That on-disk sweep directory disappeared
from the filesystem partway through this investigation (gitignored
`artifacts/` tree; likely cleaned by a concurrent process in this shared
repo — not caused by this read-only task). Per the task's fallback
instruction, the single-course pipeline was re-run in-process, the same way
`scripts/chainspot-lab/sweep/operation.ts` does, using the exact same config
(`packages/alg/src/detectors/threeFactor/configs/default.json`,
`config.paramsHash: 54e871cfd0320078c32af0502b2fc5e9877f5230152cdf23ec65d4e458b5b85c`
— identical to the vanished receipt) against
`../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg`. That re-run is
branch tip: `revision: 8c5a5209182f69af2dc812e0af7faaf2bee5c2b6+dirty`
(`8c5a520` = current `git log -1`, the KERCHOOOOO-port commit). It reproduced
identical results (18/18 assignments, 15 visible + 3 recovered tees, H12 ->
`tee-recovered-2`), so every number below is the CURRENT detector's belief,
sourced either from the original receipt text (quoted) or from this
in-process re-run's board slots / trace overlays (script:
`/tmp/claude-0/-home-user-ChainSpot/42cf328f-ffc4-5274-a472-3911266c3d3e/scratchpad/dump-h12-board.ts`,
output saved under
`/tmp/claude-0/-home-user-ChainSpot/42cf328f-ffc4-5274-a472-3911266c3d3e/scratchpad/board-*.json`).

## 1. H12's stored tee evidence — every field

**Assignment row** (`artifacts/sweep/dev72-recovered-default/DashsTrack-full/run.receipt.txt:170`,
reproduced identically by the in-process re-run):

```
H12 | badge-16 | tee-recovered-2 -> basket-14 | score 0.275 | rank 1 | hole confidence 0.993
```

**The final `TeeEvidence` the assignment/scoring layer actually sees**
(board slot `assignment.tees`, re-run output
`board-assignment.json`):

| field | value |
|---|---|
| `detId` | `tee-recovered-2` |
| `xPx, yPx` | `421.37426900584796, 1763.5906432748538` |
| `tier` | `recovered` |
| `angleRad` | **`null`** |
| `bbox` | `[407, 1746, 28, 35]` |
| `area` | `0` |
| `fill` | `0` |
| `onRing` | `false` |
| `recovery.source` | `tee-shard-recovery` |
| `recovery.note` | `teeRecovery support fit tee-shard-badge-16-124: every non-occluded visible component pixel contributes; discovery seed global-bright-mask` |

This is a real, load-bearing machine fact worth flagging on its own: per
`packages/alg/src/detectors/threeFactor/assignment.ts:52` (`recoveredTee()`),
**every recovered tee is promoted to the board with `angleRad: null`** — the
axis/corners the recovery math computed are never carried onto the
persisted `TeeEvidence`. The only place the detector's fitted axis and
corners survive is the transient recovery trace (below), which the
production receipt does not persist to disk either — hence the in-process
re-run was required to recover them at all.

**The recovery-time fit** (trace unit `teeRecovery`, candidate
`tee-shard-badge-16-124`, re-run output
`unit-teeRecovery.jsonl` line for `ref: tee-shard-badge-16-124:tee-shard`):

| field | value | source |
|---|---|---|
| supporting pixels / components | `171` / `1` (single shard) | trace `values.supportingPixels` |
| discovery seed | `global-bright-mask` (no spatial prefilter; considered all 38 unowned, non-occluded bright components on the whole canonical raster) | trace `reason` |
| localization mode | `full-span-component-pca` — "localization uses the exact centroid/axis of the single detector-owned component spanning both course-local pad axes" | trace `values.fullSpanComponentLocalization: 1` |
| localized center (= stored `xPx,yPx`) | `(421.374, 1763.591)` | trace `values.localizedCenterXPx/YPx` |
| badge-ray-constrained fit center (used only for the accept/reject gate, NOT the stored geometry) | `(415.386, 1764.386)` | trace `values.supportFitCenterXPx/YPx` |
| badge-axis alignment / error (of the gating fit, not the stored corners) | `cos = 0.999848`, error `= 0.017453 rad = 1.000°` | trace `values.badgeAxisAlignment/badgeAxisErrorRad` |
| **stored corners** (order: TL, TR, BR, BL) | `(429.030, 1746.343)` → `(434.972, 1776.675)` → `(413.718, 1780.838)` → `(407.776, 1750.507)` | trace `tee-corner-tick-0..3` overlays |
| **stored axis angle** (= the underlying component's own PCA angle, `component.angle`) | `1.377349 rad = 78.916°` (long axis length 30.9px; short axis 21.7px) | componentSet artifact, component `label: 124`, `angle: 1.377348538852757`; corroborated by re-deriving the angle from the stored corners (`atan2` of the TL→TR edge) |
| bbox (as stored on the board) | `[407, 1746, 28, 35]` | `board-recoveredTees.json` |

**Provenance chain**: G3's visible ring detector never accepted this pad (see
§3) → G4 (`teeRecovery`) discovered the leftover bright component (label
`124`, area 171px, fill 0.294 — the componentSet artifact from the
in-process re-run, `artifacts/componentSet/badgeStage.components.bright.bin`)
inside badge-12's search, fit a badge-ray-constrained hollow-tee support to
it (accepted: every visible pixel explained, support 171px ≥ the 8px floor,
axis error 1.0° well under the 3° gate), then used that SAME component's own
centroid+PCA (not the gating fit) to localize the final corners/center — the
"Fragment PCA ≠ constrained fit" pattern the CV engrams warn about. It
became `tee-recovered-2`, assigned to `H12` (badge-16, label `"12"`) and
`basket-14`.

## 2. Badge-12's center/label and the bearing to it

**Badge-16** (internal ordinal; badge digit-read label is `"12"`) —
`board-badges.json`:

| field | value |
|---|---|
| `detId` | `badge-16` |
| `label` (final, non-abstained) | `"12"` |
| read confidence | `0.9926273566316093` |
| `cxPx, cyPx` | `374.3442265795207, 1639.424836601307` |
| `bbox` | `[348, 1619, 55, 42]` |
| source | `bright-family` |

**Bearing, pad-center → badge-center** (stored tee center `(421.374,
1763.591)` → badge center `(374.344, 1639.425)`):

- Δx = -47.030, Δy = -124.166 (image pixel coords, y down)
- distance = **132.77 px**
- bearing = `atan2(Δy, Δx)` = **-110.745°** (equivalently 249.255°)

## 3. Angular error: stored axis vs. the badge bearing

Two different axis numbers exist in the machine's own state, and they
disagree — this is the headline finding:

| axis | value | what it measures |
|---|---|---|
| **Stored/rendered axis** (component `124` PCA = the corners actually drawn) | `78.916°` (undirected line) | what the detector's persisted geometry actually says the pad points along |
| **Gating axis** (`badgeAxisAngleRad` of the internal support fit) | badge ray ± `1.000°` (by construction — the search explicitly optimizes within a ±3° window around the badge ray) | what the ACCEPT/REJECT decision was scored against — a different, nearby center, not the stored one |

Comparing the **stored axis** to the **stored center's own bearing** to
badge-12 (both reduced mod 180° since a pad axis is an undirected line):

- stored axis mod 180° = `78.916°`
- bearing mod 180° = `-110.745° + 180° = 69.255°`
- **angular error = |78.916 - 69.255| = 9.66°**

So: the number that gated acceptance (1.0°) is not the same number as "how
far off is the detector's actual stored/rendered pad axis from pointing at
its badge" (9.66°) — because the accepted geometry's corners come from the
raw component's own PCA at a slightly different center than the fit that
was scored. Neither number is wrong by the detector's own rules (the
localization mode is explicitly documented as trusted when a single
component spans both pad axes, which this one does), but a reviewer
comparing "the detector's belief" to a badge ray by eye should use 9.66°,
not the 1.0° gating number.

## 4. Why G3 missed it — quoted from the run

G3's visible ring detector (`tees` unit) **did** find and accept a
ring/rectangle at this exact location — this is not a "no ring found" case:

```
{"type":"box","bbox":[403,1753,23,24],"verdict":"accepted","ref":"tee-15",
 "values":{"fill":0.6108108108108108,"area":295}}
```

compare to the family's typical member (anchor `tee-2`,
`bbox":[420,630,18,25]`, `fill: 0.884`, `area: 343`) and to every other
accepted tee in this run, which all sit at `area ≈ 338-345`, `fill ≈
0.61-0.97` with only this one and one obvious noise fragment (`tee-6`, area
12) running low. `tee-15`'s own fitted quad is (in original pixels)
`(425.70,1746.38) → (431.89,1777.99) → (414.18,1781.46) → (407.99,1749.85)`
— axis `78.916°`, center `(419.94, 1763.92)` — essentially the same
rectangle G4 later recovered (corners within ~1-5px, same axis angle to
three decimal places). **G3 saw the right pad.**

It was then **excluded by `teeFamily`'s majority-vote-by-size-family step**,
quoted verbatim from the trace (`unit-teeFamily-ALL.jsonl`):

```
{"type":"polyline","ref":"tee-15","verdict":"rejected",
 "reason":"excluded from winning family (anchor tee-2): failing area, fill
 log-ratio(s) — |Δlog major|=0.0396 (tol 0.2231), |Δlog minor|=0.1719 (tol
 0.2231), |Δlog area|=0.4418 (tol 0.4055), |Δlog fill|=0.3095 (tol 0.2231)"}
```

Both `area` and `fill` failed their tolerance; `major`/`minor` passed.

**Root cause of the smaller/dimmer measurement**: the tee pad's bright-mask
component (`componentSet` artifact, `label: 124`, `area: 171px`, `bbox:
[409,1748,22,33]`, `fill: 0.294`) sits immediately adjacent to — and its
west edge is cut by — a basket-glyph sprite component right next to it:

```
{"label": 123, "cx": 390.5, "cy": 1764.3, "area": 1746, "bboxW": 42,
 "bboxH": 66, "angle": 1.5707963267948966 (90°), "fill": 0.6297}
```

which is exactly the CV-engram basket-glyph signature (~1746px, 42×66, PCA
90°) and matches `basket-17`'s `source: bright-component:123` in
`board-baskets.json` (`basket-17` center `(391, 1770)`, i.e. ~30px west of
the tee pad's center, bbox `[368,1734,46,72]` — overlapping the pad's bbox
by ~9px in x, full y-overlap). This is **not H12's own target basket**
(`basket-14`, 133-235px away down the fairway) — it is a different,
spatially adjacent basket sprite that happens to sit right next to H12's
tee. The overlay crop below shows the pad's hollow white ring visibly
merging into that basket glyph's left prong. That merge is exactly the
"ring broken by the adjacent basket sprite" failure mode named in the
CV engrams: G3's ring-completeness test still passed (fill 0.61 was enough
to be *accepted* as a ring/box), but the missing/absorbed slice of the ring
measured a smaller `area`/`fill` than the rest of the course's tee family,
and `teeFamily`'s majority vote threw it out. G4's recovery then re-found
the same leftover component independently (seeded from the whole-canvas
bright mask, constrained by badge-12's ray) and accepted it.

**Classification** (per the completeness invariant): **occluded by a known
occluder (adjacent basket sprite) → correctly recovered by G4**, not a
G3-defect in the "no ring, no test" sense — G3 detected a ring, teeFamily's
size-family vote is what excluded it.

## 5. Overlay crops

Both rendered directly from the canonical raster
(`renders/input/g0.canonical.png` of the in-process re-run) with the
detector's own stored numbers above burned in — no separate ground-truth
measurement was used.

- `artifacts/orchestration/dt12-detector-state/h12-tee-detector-state.png` —
  wide context: badge "12", H12's tee pad, and the neighboring basket glyph,
  with the C1S/C2D range rings visible. **Blue** box+dot = badge-16 (label
  "12"). **Yellow** polygon+dot+line = G4's stored recovered corners/center/
  axis (`tee-recovered-2`). **Magenta** polygon = G3's own rejected ring
  candidate (`tee-15`) for comparison — nearly coincident with the yellow
  one. **Cyan** line = the ray from the stored tee center to badge-16's
  center (bearing -110.745°, §2).
- `artifacts/orchestration/dt12-detector-state/h12-tee-pad-closeup.png` — an
  8x close-up centered on just the pad, same color key, showing the pad's
  hollow white ring merging into the basket-glyph's left prong (the physical
  cause of the size/fill undershoot in §4), and the ~9.7° visible skew
  between the yellow pad axis and the cyan badge ray.

## Numbers-at-a-glance

| quantity | value | source |
|---|---|---|
| H12 assignment | `badge-16 -> tee-recovered-2 -> basket-14`, hole conf 0.993 | `run.receipt.txt:170` |
| stored tee center (`xPx,yPx`) | `(421.374, 1763.591)` | `board-recoveredTees.json` / `board-assignment.json` |
| stored tee bbox | `[407, 1746, 28, 35]` | same |
| stored tee `angleRad` on final `TeeEvidence` | `null` (always, for any recovered tee) | `assignment.ts:52-63` |
| recovery-time stored corners | listed in §1 | `teeRecovery` trace overlays |
| recovery-time stored axis | `78.916°` (`1.377349 rad`) | componentSet label 124 + corner re-derivation |
| gating axis error (fit vs its own badge ray) | `1.000°` | trace `values.badgeAxisErrorRad` |
| badge-12 center | `(374.344, 1639.425)` | `board-badges.json` |
| badge-12 label / confidence | `"12"` / `0.9926` | `board-badges.json` |
| bearing pad→badge | `-110.745°`, distance `132.77px` | computed from the two centers above |
| **stored-axis-vs-bearing angular error** | **`9.66°`** | computed, §3 |
| G3's own rejected candidate for this pad | `tee-15`, bbox `[403,1753,23,24]`, fill `0.611`, area `295` | `unit-tees-ALL.jsonl` |
| G3 rejection reason | `teeFamily` size/fill log-ratio failure vs anchor `tee-2` (quoted §4) | `unit-teeFamily-ALL.jsonl` |
| adjacent basket sprite eating the pad's edge | `basket-17`, component `label 123`, center `(391,1770)` | `board-baskets.json` + componentSet artifact |
