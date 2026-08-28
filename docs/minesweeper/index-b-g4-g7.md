# Minesweeper Index B — G4-G7 + assignment/measurement plumbing

Scope: `packages/alg/src/detectors/threeFactor/` features
`{g3.teeRecovery, g3.phantomTee, g3.teeReceipts, g4.scoring, g4.search,
g4.teeBadgeLock(+Math,+Receipt), g5.ribbon, g5.routing, g5.zfit,
st.straightTest(+contract), st.fourLaneSensor}.ts`, plus `scoring.ts`,
`assignment.ts`, `ribbon.ts`, `routing.ts`, `measure.ts`, `occlusion.ts`,
and `exec/{compile,operations}.ts`.

**Method note**: no Agent/Task subagent-spawning tool exists in this session's
toolset (only `SendMessage`, which requires an already-listed peer). Per the
brigade instructions' fallback, this index was produced by personally reading
every one of the 22 in-scope files in full (~7,227 lines) rather than via
Haiku workers. All findings below are self-verified against the source.

**g3.teeRecovery.ts flag**: this file is under active repair by other agents
(axis-tolerance knob + discovery redesign) per the brief. It is indexed as it
stood at commit `dc96000`; several findings below (the 3°/soft-ceiling axis
gate, the predecessor-basket search box) are already known targets of that
parallel work and are marked accordingly rather than duplicated as fresh asks.

---

## 1. features/g3.teeRecovery.ts (813 lines) — UNDER ACTIVE REPAIR

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 182 | `const RASTER_TOLERANCE_PX = 1.25;` | half-cell + diagonal quantization allowance for hollow-tee membership test | RASTER-GEOMETRY | LOW | n/a — legitimate raster slack |
| 190-199 | `BADGE_AXIS_TARGET_DEG = 3` / `activeAxisLimitDeg` (mutable, settable via `setActiveAxisToleranceDeg`) | tee-major-axis-to-badge-ray angular gate; owner-noted 2026-08-28 as now a soft ceiling pending rectangle-detector improvement, target path P100≤5° then back to 3° | DATASET-FIT THRESHOLD (in-flight remediation) | HIGH (pre-fix) | any course where the pad-rectangle fit is noisier than the corpus that set 3°/5° — a legitimate tee whose true axis reads >3-5° off the badge ray (uneven ground, wide-angle lens distortion at long holes) is silently rejected as recoverable evidence, i.e. the "**hard 3° axis gate**" the owner named explicitly. Already flagged/being worked; verified present in this build. |
| 200 | `const MIN_SHARD_SUPPORT_PIXELS = 8;` | minimum bright-pixel count before a shard is considered enough evidence to fit a tee | DATASET-FIT THRESHOLD | MED | a distant/small-scale tee (1700ft-hole photo where a tee pad is only a few px) legitimately has <8 visible pixels and can never be recovered, regardless of how clean its shape is — bare literal, not scaled to image resolution/zoom |
| 250 | `if (pad.area >= width * height * 0.95) return 0;` | 95% fill ratio distinguishes "solid bright fallback pad" (no border) from a hollow ring | DATASET-FIT THRESHOLD | LOW | a legitimately hollow pad whose antialiasing/compression pushes fill to ≥95% is silently treated as solid (zero support thickness), weakening the recovery predicate but not outright rejecting |
| 340 | `const scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);` | pose-search angular half-range derived from the (possibly soft-ceiling) axis limit | STRUCTURAL WORLDVIEW | LOW | tied to the axis-gate finding above; if the ceiling changes, this follows automatically (good), but a `- 0.5` fixed shave is itself unexplained |
| 351 | `scan(minCenterX, maxCenterX, minCenterY, maxCenterY, 0.5, 0.5);` | brute-force center/angle search resolution: half-pixel centers, half-degree angle steps | RASTER-GEOMETRY | LOW | fine at any scale since it operates on the already-cropped candidate window, not absolute image size |
| 366 | `const spanAllowance = 3 * RASTER_TOLERANCE_PX;` | 3-cell allowance before a component's PCA span is trusted as "spans both course-local pad axes" | RASTER-GEOMETRY | LOW | documented as raster geometry, not course-specific |
| 460-461 | `Math.abs(sprite.cx - basket.centerXPx) < 3` (×2, x/y) | fixed 3px match tolerance between a sprite match and a basket record | DATASET-FIT THRESHOLD | LOW | breaks only if upstream coordinate rounding ever drifts >3px, unlikely at native pipeline resolution |
| 626 | `const radius = Math.hypot(halfWidth, halfHeight) + observedSpan + 4;` | search-box radius around the **predecessor basket's tip** bounding shard discovery | COURSE-ASSUMPTION FOOTGUN (owner-named exemplar) | HIGH | this is the owner's explicitly-cited "~83px predecessor-basket search box" pattern: discovery is bounded to a small neighborhood around basket B(n-1)'s tip, encoding "a recoverable tee touches its previous hole's basket." On any hole where the tee is not adjacent to the previous green (dogleg course routing, a shared/central tee complex serving multiple holes, or simply a long walk between green and next tee), the true tee sits outside this box and is never discovered, no matter how clean its visible evidence is. Confirmed present in the build at dc96000; per the brief this module is under parallel repair — treat as already tracked, not a fresh ask. |
| 663 | `for (let pass = 0; pass < 2; pass++)` | fixed 2-pass refit-then-filter loop for candidate pose convergence | STRUCTURAL WORLDVIEW | LOW | assumes 2 iterations is always enough for the pose to stabilize; no convergence check, so a pathological multi-shard case could still be mid-refit at pass cutoff (silently accepts whatever pass 2 leaves) |
| 779-781 | `Math.hypot(...) < 14` (×3, duplicate-tee suppression) | fixed 14px de-duplication radius between a recovered tee and any existing/other-recovered tee | COURSE-ASSUMPTION FOOTGUN | MED | same bare-pixel-radius pattern as `recoveredTeeDedupeDistance` (g4.search, also 14px) — fixed regardless of image resolution/zoom; two real, distinct tees closer than 14px in a tight or far-zoomed shot get merged, while at extreme zoom the same 14px could span a large real-world distance and never trigger even when it should |
| — | targeting via `targetPredecessors()` requires an *assigned* predecessor badge `hole-1` | STRUCTURAL WORLDVIEW | HIGH | recovery is provably impossible for hole 1 (no predecessor) or any hole whose predecessor is itself unassigned — a chain-breaking gap anywhere upstream cascades into "unrecoverable" for every subsequent hole in sequence, regardless of how good that hole's own visible evidence is. This is the same "recoverable means touching the previous basket" worldview as the search-box finding above, one level up (assignment-graph adjacency, not pixel-radius adjacency). |

## 2. features/g3.phantomTee.ts (259 lines) — default OFF

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 105-149 | `assignmentByHole.get(hole - 1)` chain walk | phantom placement first tries the immediately-preceding hole number's assigned basket tip | STRUCTURAL WORLDVIEW | MED | bakes "holes are numbered contiguously and hole n's tee is near hole (n-1)'s basket" — same predecessor-adjacency worldview as teeRecovery, one layer up in the fallback chain. Breaks the same way: doglegs, shared tee complexes, non-contiguous numbering (skipped/retired holes), or a course that numbers loops (e.g., 10-18 played before 1-9) |
| 78-89 | `fallbackForBadge`: step badge-frame-diagonal distance away from the nearest basket, `score: 0` | deterministic last-resort placement scale is the badge's own detected bbox diagonal (not a constant) — the file explicitly calls out *not* using an unexplained pixel constant here | STRUCTURAL WORLDVIEW (good pattern) | LOW | this is the one place in scope where a naive fixed-px fallback was deliberately avoided in favor of a self-scaling quantity; noted as a positive contrast to the fixed-px footguns elsewhere |
| 136-138 | `score: 0.5` for a predecessor-basket-tip phantom | arbitrary confidence placeholder distinguishing "linked to a real predecessor basket" (0.5) from "badge-diagonal fallback" (0.0) | DATASET-FIT THRESHOLD (bare) | LOW | cosmetic — only used as a display/relative-confidence number, phantom evidence never feeds appearance scoring by design |

## 3. features/g3.teeReceipts.ts (195 lines)

Pure trace-to-drawable presentation seam (`teeRecoveryRender`, `phantomTeeRender`). No numeric literals of consequence — the "3 degrees" text on line 137 is documentation of the g3.teeRecovery gate, not an independent literal.

## 4. features/g4.scoring.ts (124 lines) / scoring.ts DEFAULT_SCORING_KNOBS (mirrors)

All knobs here are declared with provenance notes (this file's own header documents a phase-3 sign-off sweep that caught several previously-missed knobs), so by the rubric these are legitimately-knobbed DATASET-FIT THRESHOLDs rather than bare literals — **except** where the *default value itself* is a fixed pixel distance that does not scale with image/course geometry:

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 47-49 | `ringDistance: { default: 84, ... }` | basket-to-tee ring membership distance, compared directly against `Math.hypot(...)` pixel distances in scoring.ts's `zoneFactor`/measure.ts's `onRing`/assignment.ts's `recoveredTee` | COURSE-ASSUMPTION FOOTGUN | HIGH | fixed px regardless of image resolution or how far the source photo is zoomed; a 150ft-hole close-up photo and a 1700ft-hole wide shot do not put "tee-to-basket ring distance" at the same pixel count, yet one knob value is asked to fit both |
| 55-66 | `zoneFactorDistance: 35`, `secondaryRingDistance: 44`, `secondaryRingTolerance: 8` | further fixed-px radial thresholds around a basket used for the "furniture zone" penalty | COURSE-ASSUMPTION FOOTGUN | MED | same fixed-px-vs-variable-scale problem as ringDistance, smaller blast radius (only affects a soft scoring penalty, not a hard accept/reject) |
| scoring.ts:155,159 | `return 0.4;` (×2, inside `zoneFactor`) | the actual zone-factor penalty value | DATASET-FIT THRESHOLD (bare, un-knobbed) | MED | unlike every other magic number in this feature's neighborhood, this "0.4" was **not** promoted to a knob during the documented phase-3 sign-off sweep — it sits directly in scoring.ts logic with no ScoringKnobs field, breaking the pattern the rest of the file enforces. Worth the same knob-extraction treatment as its siblings. |
| 75-85 | `badgeFractionTarget: 0.36`, `...Tolerance: 0.19`, `...Sigma: 0.15` | fractional position (0-1) of badge along tee-basket chord | DATASET-FIT THRESHOLD | LOW | these are dimensionless fractions of the tee-basket chord, so they scale correctly regardless of course/image size — legitimate corpus tuning |

## 5. features/g4.search.ts (34 lines) / assignment.ts DEFAULT_SEARCH_KNOBS (mirrors)

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 17-19 | `assignTopRows: { default: 60, ... }` | candidate-pair window (top-N by score) kept per badge for the search | DATASET-FIT THRESHOLD | MED | a busy image with many baskets/tees in view for one badge (crowded driving range, multiple nearby holes visible in a wide establishing shot, disc-golf "island" layouts with many baskets clustered) can have >60 plausible candidates; anything beyond the top 60 is invisible to both local search passes even if the true match is #61 |
| 21-27 | `exchangeTopK: 12`, `maxAssignPasses: 60` | pairwise-exchange candidate cap and local-search iteration cap | DATASET-FIT THRESHOLD | MED | `selectAssignments` (assignment.ts:250) stops improving after 60 passes with no convergence check — on a course/frame with many simultaneous badges (N large) the O(N²) pairwise-exchange pass may not have finished exploring by the guard limit, silently keeping a locally-suboptimal (but not necessarily wrong) assignment. Soft-degradation, not silent loss, hence MED not HIGH. |
| 29-31 | `recoveredTeeDedupeDistance: { default: 14, ... }` | min separation between a recovered tee and an existing one before treating it as duplicate | COURSE-ASSUMPTION FOOTGUN | MED | same fixed-14px pattern flagged in teeRecovery.ts §1 — this is the canonical knobbed home of that constant; two genuinely-distinct nearby tees in a tight/high-zoom shot collapse into one, while at low zoom on a huge hole the same 14px may fail to catch true duplicates |

## 6. features/g4.teeBadgeLock.ts / g4.teeBadgeLockMath.ts / g4.teeBadgeLockReceipt.ts (default OFF)

Pure orchestration/wiring (`teeBadgeLock.ts`) and pure derived math (`teeBadgeLockMath.ts`, `teeBadgeLockReceipt.ts`) with every tunable value threaded in from measurement/scoring knobs already covered elsewhere. No bare numeric literals found; the Hungarian-matching `missingEdgeWeight = -(2 * maxAbsScore * matrixSize + 1)` (Math.ts:585) is a derived penalty, not a magic constant. The `period = Math.PI` axis-symmetry assumption in `axialAngleDelta` (Math.ts:251) is a correct structural choice for an undirected tee axis, not a footgun.

## 7. features/g5.ribbon.ts (102 lines) / ribbon.ts DEFAULT_RIBBON_KNOBS (mirrors)

All 16 knobs carry provenance notes (this feature file documents finding 4 previously-missed knobs on a targeted re-scan). By the rubric these are legitimately-knobbed DATASET-FIT THRESHOLDs / RASTER-GEOMETRY constants (blur sigma, percentile normalization, patch search margins) rather than bare literals — no HIGH findings here. One structural note:

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| ribbon.ts:174-184 | 4-point (`a,b,c,d`) gradient sample requiring `dot > 0` between the two edge-difference vectors before scoring a ribbon center | STRUCTURAL WORLDVIEW | MED | models a cart/travel path as a bright band with two roughly-parallel, consistently-oriented edges. A single-edged path (dirt trail against grass on one side only, a path running against a hard boundary like a fence/wall on one side), or a path rendered with inconsistent edge contrast, produces `dot <= 0` and contributes zero support at that orientation/width — the routing corridor "doesn't see" that stretch of path at all, not just scores it lower |

## 8. features/g5.routing.ts (76 lines) / routing.ts DEFAULT_ROUTING_KNOBS (mirrors)

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 55-57 | `corridorWidthPx: { default: 37, ... }` | fixed pixel corridor width used for leg-routing/support-field ribbon width | COURSE-ASSUMPTION FOOTGUN | **HIGH** | this is the single biggest scale-invariance gap found in this sweep: a leg-search corridor is 37px wide regardless of what that photo's px-per-foot scale is. On a close-up 150ft-hole photo, 37px might be many feet wide (over-permissive, corridor swallows adjacent terrain); on a wide 1700ft-hole establishing shot, 37px might be inches wide (under-permissive, a real but slightly-off-center path falls outside the corridor and reads as unsupported). Every downstream leg-routing/scoring computation inherits this same scale assumption. |
| 63-65 | `widthsSrc: { default: [24, 32, 40, 48, 56, 64], ... }` | fixed array of ribbon-width scales (px) sampled during support-field construction | COURSE-ASSUMPTION FOOTGUN | HIGH | same root cause as corridorWidthPx — a fixed absolute-pixel width ladder, not derived from image scale/zoom/course distance. Directly matches the owner's "150ft holes and 1700ft holes" framing: the width ladder that fits a 1700ft-hole wide shot cannot simultaneously fit a 150ft close-up. |
| 71-73 | `worstWindowSrcPx: { default: 90, ... }` | fixed-px worst-case sliding-window size for weakest-link scoring along a route | COURSE-ASSUMPTION FOOTGUN | MED | same family — absolute pixel window, not scaled; a route on a far-zoomed image could have its entire visible length shorter than 90px, degenerating the "worst window" to "whole route," while at high zoom 90px may be far short of a meaningful weak-span length |
| header comment 8-16 | `ring * quantum` must exceed max single-step edge weight `(1 + ribbon.costMultiplier) * Math.SQRT2`, enforced only in `config.ts`'s `validateRoutingRingQuantum` (out of scope file) | STRUCTURAL WORLDVIEW (cross-feature invariant) | LOW (mitigated) | correctly documented and enforced at config-resolve time per the file's own comment — flagged only so the cross-file dependency is visible in this index; not independently exploitable within the files in this scope |

## 9. features/g5.zfit.ts (93 lines) / scoring.ts DEFAULT_ZFIT_KNOBS (mirrors) — default OFF

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 44-50 | `distanceStartOffset: 8`, `distanceStepPx: 14` | fixed-px waypoint search start offset and step size along the first leg, before trying a bend | COURSE-ASSUMPTION FOOTGUN | MED | same absolute-pixel-vs-variable-scale problem as g5.routing's corridor knobs; on a far-zoomed 1700ft-hole shot, 14px steps skip past viable bend points, while on a close-up shot the same step count over-samples a tiny search space |
| 56-58 | `maxAdditionalDistance: { default: 220, ... }` | fixed-px cap on how far past the first leg's length the zfit search extends | COURSE-ASSUMPTION FOOTGUN | MED | on a large-scale (1700ft) hole photographed wide, 220px may not reach a legitimate bend point at all; on a small-scale (150ft) hole it may search far past any plausible bend |
| 64-74 | `bendLengthShort/Medium/Long: 0.8 / 1.6 / 3` (× `corridorWidthPx`) | bend-segment lengths as multiples of corridor width | (correctly relative — not flagged) | — | scales with `corridorWidthPx`, so inherits only that upstream footgun, not an independent one |
| 60-62 | `bendAngles: [-60, -45, -30, -20, 0, 20, 30, 45, 60]` | fixed discrete bend-angle sample set (degrees) | DATASET-FIT THRESHOLD | LOW | a legitimate dogleg bending at, say, 15° or 70° falls between/outside sampled angles and is never tried — corpus-plausible but a hard-coded discretization with no interpolation |

## 10. features/st.straightTest.ts (452 lines) + st.straightTest.contract.ts (172 lines) — default OFF, resolveOnlyWhenConfigured

Contract file is pure types, no literals. In the feature file:

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 193-197 | `candidate.tee.tier === 'ring'` gate for `semanticStrongRingTee` | hard-codes the string tag `'ring'` as the only tee tier considered "strong identity" for S0 straight-line testimony | STRUCTURAL WORLDVIEW | LOW | any future/alternate strong tee tier (e.g., a min-area-pose-confirmed tee, a teeBadgeLock-confirmed tee) is invisible to this gate unless its tier literally equals `'ring'` — an enum-coupling footgun rather than a scale footgun |
| 418-419 | `Math.cos(axis)*20`, `Math.sin(axis)*20` | fixed 20px half-length for the presentation-only tee-axis tick mark | RASTER-GEOMETRY (presentation only) | LOW | purely visual; wrong length only misdraws a debug overlay, never affects a verdict |

## 11. features/st.fourLaneSensor.ts (306 lines) — default OFF, not yet wired to an EngineUnit

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 21-26 | `edgeDeltaPx: 2.5`, `tangentHalfPx: 4` | fixed-px normal-offset and tangent half-length for cross-section sampling | COURSE-ASSUMPTION FOOTGUN | MED | absolute pixel offsets independent of the state's own `corridorWidthPx`, unlike the lane-offset geometry below which IS relative. At extreme zoom these fixed offsets sample essentially the same pixel twice (no discrimination); at low zoom they may fall inside noise |
| 23 | `liftReference: 45` | grayscale (0-255 scale) lift that normalizes to score 1.0 | DATASET-FIT THRESHOLD | LOW | a color-space quantity, not a distance — legitimately independent of course/image scale, so this one is *not* a scale footgun despite being a bare number |
| 187-193 | four lane offsets fixed at `±width/2, ±width/6` of `state.corridorWidthPx` | assumes a cart-path/corridor cross-section always decomposes into exactly 2 rails + 2 inner lanes at these specific fractional offsets | STRUCTURAL WORLDVIEW | MED | correctly *relative* to corridor width (so it inherits, rather than independently causes, any upstream corridor-width footgun) but bakes a specific "4-lane" path cross-section model; a single-track path, a path wider/narrower than the fixed-fraction lane model expects, or a path edge that is not two parallel rails (e.g. one paved edge against rough) does not fit this shape and the sensor observes nonsense in those inner/rail bands |
| 171 | `blocked * 2 >= n` | majority-of-samples-occluded threshold for marking a whole band UNKNOWN | RASTER-GEOMETRY-ish DATASET-FIT | LOW | reasonable simple-majority rule; edge case at even `n` ties toward "occluded" |

## 12. scoring.ts (427 lines, core plumbing — mirrors g4.scoring / g5.zfit knob shapes)

Covered jointly with §4/§9 above (`DEFAULT_SCORING_KNOBS`/`DEFAULT_ZFIT_KNOBS` here are byte-identical mirrors of the feature-file defaults). Function-body-only findings not already listed:

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 155, 159 | `return 0.4;` | (see §4) un-knobbed zone-factor penalty, the actual computation site | DATASET-FIT THRESHOLD (bare) | MED | same finding as §4, listed again at its source location |
| 401-402 (in `scorePair`) | `alignment = raw.worstWindowMean > 0 ? alignedWorst / raw.worstWindowMean : 0` | zero-division guard collapses "no signal" to 0 rather than 1/undefined | STRUCTURAL WORLDVIEW | LOW | correct defensive default, not a footgun |

## 13. assignment.ts (387 lines, core plumbing)

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 23 | `const IMPROVEMENT_EPSILON = 1e-9;` | numerical noise floor for "did the local search actually improve" | RASTER-GEOMETRY / numerical guard | LOW | standard floating-point tolerance, not course-scale-dependent |
| 226-323 (`selectAssignments`) | global exclusivity: one tee and one basket can each serve at most one badge, enforced via `usedTees`/`usedBaskets` sets across the *entire* image | STRUCTURAL WORLDVIEW | MED | assumes strict 1:1:1 badge:tee:basket ownership everywhere in frame. A course with a shared/central tee complex genuinely serving two numbered holes from the same physical tee pad, or two holes sharing one basket during a temporary layout, cannot be represented — one of the two badges is structurally forced to lose the contested tee/basket even if both readings are individually correct |
| 328 | `const starts: readonly string[][] = [marginOrder, [...labels], [...labels].reverse()];` | only 3 fixed restart orderings tried for the greedy-then-local-search heuristic | DATASET-FIT THRESHOLD (structural) | LOW | a heuristic with no guarantee of global optimum; more restarts would only ever help, never hurt, so this is a soft-optimization ceiling, not a correctness bug |
| 377-379 (also duplicated exec/operations.ts:458 & 516) | `.slice(0, 3)` | only the top-3 runner-up alternatives are retained per assignment for trace/receipt purposes | DATASET-FIT THRESHOLD (bare) | LOW | presentation/debuggability limit only — the 4th-best alternative is invisible in the receipt even when it's a very close call, but the selected assignment itself is unaffected |

## 14. ribbon.ts (293 lines, core plumbing) — see also §7

Function-body literals mirror the g5.ribbon feature knobs (§7); no additional bare literals beyond epsilon guards (`1e-6` in normalization and dot-product denominators, standard numerical-stability guards, LOW).

## 15. routing.ts (151 lines, core plumbing) — see also §8

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 4-6 | `DX/DY/STEP` (8-connected grid, `Math.SQRT2` diagonal cost) | octile-distance grid routing | RASTER-GEOMETRY | LOW | standard, correct grid-routing metric; not course-scale-dependent |
| 8-16 (header) | `ring*quantum` invariant, see §8 | cross-feature structural invariant, enforced in config.ts | STRUCTURAL WORLDVIEW | LOW (mitigated) | (same as §8 entry — listed once for completeness at the routing.ts implementation site) |

## 16. measure.ts (986 lines, core plumbing — units + seedBoard + exactBadgeBrightPixels)

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 166 | `const candidates = Array.from({ length: 18 }, (_, index) => index + 1)` | **hole-label candidate generation is hard-capped to integers 1-18 inclusive** — a badge whose read digits form any other number (19, 20, 0, or any 3+-digit number) produces zero label candidates no matter how confident the digit reads are | **COURSE-ASSUMPTION FOOTGUN** | **HIGH** | direct, literal instance of the owner's "18-hole worldview" framing. Breaks on: disc-golf courses (routinely have backup/alternate baskets numbered 19+ or double-digit hole counts beyond 18), executive/par-3 courses or driving ranges with non-standard hole/station numbering, any 27- or 36-hole facility where a combined nine is labeled beyond 18, or simply a badge showing "0" (some ranges number a practice station 0). A perfectly-read, perfectly-legible "19" badge is **silently unassignable** — not degraded, structurally invisible to `labelCandidates`, and therefore to every downstream assignment/scoring/receipt step that depends on `badge.label`. |
| 84-90 | `DEFAULT_WIDTHS_SRC`, `DEFAULT_CORRIDOR_WIDTH = 37`, `DEFAULT_FIELD_SCALE = 3`, `DEFAULT_ORIENTATIONS = 12`, `DEFAULT_ALIGNMENT_POWER = 2`, `DEFAULT_WORST_WINDOW = 90`, `DEFAULT_SUPPORT_TAU = 0.5` | byte-identical fallback defaults for the same corridor/ribbon parameters knobbed in g5.routing/g5.ribbon | COURSE-ASSUMPTION FOOTGUN | HIGH | same finding as §8 (corridorWidthPx/widthsSrc/worstWindowSrcPx), duplicated here as the ultimate fallback source (`makeParameters`) when no `ThreeFactorParams` override is supplied — i.e. this is the *actual* default a caller gets if they don't know to override it |
| 433, 437-440 | `insideBadgePadding = badgeStageKnobs.badgeInsidePadding` used as a bbox-expansion margin to exclude tee/ring candidates "inside" a badge | STRUCTURAL WORLDVIEW (knobbed elsewhere) | LOW | correctly sourced from an external knob, not a bare literal here |
| 970-971 | `clampInt(params?.viewport?.topPx ?? 0, 0, image.height - 1)` / `clampInt(..., topPx + 1, image.height)` | viewport clamp guarantees at least a 1px-tall crop | RASTER-GEOMETRY | LOW | degenerate-input guard, not a footgun |

## 17. occlusion.ts (72 lines, core plumbing)

Pure OPAQUE/ALPHA/UNKNOWN vocabulary and composition (`OcclusionDetector`, `BoxOpaqueDetector`). No numeric literals; no findings.

## 18. exec/compile.ts (139 lines)

Pure scheduling/dependency-validation logic driven entirely by config data (`resolved.execution`, `OPERATION_UNIVERSE`). No numeric literals; no findings.

## 19. exec/operations.ts (837 lines)

Mostly a decomposition/wiring layer that re-calls the exact same functions already covered in scoring.ts/assignment.ts/measure.ts (the file's own header states this is deliberate — "same functions, same order, same arguments"). One repeated finding:

| file:line | verbatim | meaning | class | severity | breaks-when |
|---|---|---|---|---|---|
| 458, 516 | `.slice(0, 3)` (×2) | duplicated top-3-alternatives cap, independently re-implemented rather than calling a shared helper | DATASET-FIT THRESHOLD (bare, duplicated) | LOW | same effect as assignment.ts §13; flagged again here because it is a **second, independently-maintained copy** of the same "3" — a future knob/behavior change to one site can silently diverge from the other |
| 619-620 (comment) | "...G7 never reads the pre-recovery 15-tee state after G4 has produced an 18-tee assignment" | prose example using 15/18 as illustrative tee counts | (not a literal — documentation only) | — | not a runtime constraint; mentioned only to confirm it is not an enforced cap anywhere in this file |

---

## Counts by classification

| Classification | Count (distinct findings) |
|---|---|
| COURSE-ASSUMPTION FOOTGUN | 13 |
| DATASET-FIT THRESHOLD | 14 |
| RASTER-GEOMETRY | 9 |
| STRUCTURAL WORLDVIEW | 11 |

(Totals count each distinct row above once; several findings are cross-referenced at more than one file:line because the same constant is defined in a feature file and mirrored/consumed in a core-plumbing file — e.g. `corridorWidthPx`/`widthsSrc` appear in both g5.routing.ts and measure.ts, and are counted once as a single course-assumption footgun with two citation sites.)

## Severity summary

- **HIGH: 5** — g3.teeRecovery's 3°/soft-ceiling axis gate (in-flight repair), g3.teeRecovery's predecessor-basket search radius (in-flight repair) + its assignment-graph-adjacency sibling, g5.routing/measure.ts's fixed-px `corridorWidthPx`/`widthsSrc` (two citation sites, one footgun), and measure.ts's hard-coded 1-18 hole-label cap.
- **MED: 15**
- **LOW: 18** (includes several deliberately-scaled or well-guarded constants noted for completeness, not because they're dangerous)

## Per-worker coverage confirmation

No Haiku workers were spawned (no Agent/Task tool available in this session's
toolset — confirmed via `ToolSearch` for Agent/Task/spawn/subagent/haiku
before falling back). All 22 in-scope files were read in full, personally,
by this lead session:

- features/g3.teeRecovery.ts (813 lines) ✓ read in full
- features/g3.phantomTee.ts (259 lines) ✓ read in full
- features/g3.teeReceipts.ts (195 lines) ✓ read in full
- features/g4.scoring.ts (124 lines) ✓ read in full
- features/g4.search.ts (34 lines) ✓ read in full
- features/g4.teeBadgeLock.ts (270 lines) ✓ read in full
- features/g4.teeBadgeLockMath.ts (667 lines) ✓ read in full
- features/g4.teeBadgeLockReceipt.ts (372 lines) ✓ read in full
- features/g5.ribbon.ts (102 lines) ✓ read in full
- features/g5.routing.ts (76 lines) ✓ read in full
- features/g5.zfit.ts (93 lines) ✓ read in full
- features/st.straightTest.ts (452 lines) ✓ read in full
- features/st.straightTest.contract.ts (172 lines) ✓ read in full
- features/st.fourLaneSensor.ts (306 lines) ✓ read in full
- scoring.ts (427 lines) ✓ read in full
- assignment.ts (387 lines) ✓ read in full
- ribbon.ts (293 lines) ✓ read in full
- routing.ts (151 lines) ✓ read in full
- measure.ts (986 lines) ✓ read in full
- occlusion.ts (72 lines) ✓ read in full
- exec/compile.ts (139 lines) ✓ read in full
- exec/operations.ts (837 lines) ✓ read in full

Total: 22/22 files, ~7,227 lines, 100% coverage.

---

## TOP 10 (ranked)

1. **measure.ts:166 — hole-label candidates hard-capped to 1-18** (`Array.from({ length: 18 }, (_, i) => i + 1)`). The single clearest instance of an "18-hole worldview" baked as a literal array bound anywhere in this sweep: a badge reading any number outside 1-18 (disc-golf backup baskets, non-standard facilities, a "0" practice station) gets zero label candidates and is structurally unassignable. **Fix direction**: derive the candidate range from course metadata/params (a `holeCountRange` or similar passed through `ThreeFactorParams`), defaulting to something wide (e.g. 1-99) rather than a fixed 18, and let a course-specific config narrow it if truly needed.

2. **g5.routing.ts / measure.ts — fixed-pixel `corridorWidthPx=37` and `widthsSrc=[24,32,40,48,56,64]`**. The corridor/ribbon-width model is defined in absolute pixels with no tie to image resolution, zoom, or real-world course scale, so one set of defaults cannot simultaneously suit a close-up 150ft-hole photo and a wide 1700ft-hole establishing shot — exactly the owner's stated calibration. **Fix direction**: derive corridor width and the width-sampling ladder from a per-image scale estimate (e.g. px-per-known-reference-object, or an explicit course-scale parameter threaded through `ThreeFactorParams`) instead of bare pixel constants.

3. **g3.teeRecovery.ts:626 — predecessor-basket search-box radius** (the owner's own named exemplar). Discovery is bounded to a small neighborhood around the assigned predecessor hole's basket tip, encoding "a recoverable tee touches the previous basket" — false on doglegs, shared tee complexes, and any course where consecutive holes aren't spatially adjacent. Flagged as already under parallel repair; this entry confirms it is present and real in this build. **Fix direction**: widen or replace the predecessor-tip-anchored search with a whole-frame (or badge-anchored) discovery pass, using the predecessor only as a *tiebreak/prior* rather than a hard spatial bound.

4. **g3.teeRecovery.ts — assignment-graph predecessor-adjacency requirement**. Even with an unbounded search box, recovery is only ever *attempted* for a badge whose numeric predecessor (`hole-1`) already has an assignment; any break in the assignment chain (missing hole 1, or any upstream unassigned hole) cascades into "no recovery attempted" for every subsequent hole, independent of that hole's own visible evidence quality. **Fix direction**: decouple recovery targeting from the assignment-chain walk — seed candidate targets from every badge missing a tee, using the predecessor basket (when available) only as one ranking signal among several (e.g. also try the basket nearest the badge itself).

5. **g3.teeRecovery.ts / g4.search.ts — hard 3° (soft-ceiling) axis gate**. The tee-major-axis-to-badge-ray tolerance defaults to a corpus-tuned single-digit degree value; the file's own comment documents this as a known, actively-being-loosened footgun (owner policy 2026-08-28, target P100≤5° then back to 3°). Listed here for completeness/cross-reference to the parallel repair, not as a fresh ask. **Fix direction**: (already in flight) complete the loosening to the tightening roadmap and consider deriving the tolerance from measured pad-rectangle fit confidence rather than a single global knob.

6. **scoring.ts:155,159 (mirrored via g4.scoring.ts's ringDistance/zoneFactorDistance family) — un-knobbed `return 0.4;` zone-factor penalty**. Every sibling constant in this exact code path went through a documented knob-extraction sweep; this one bare `0.4` did not, breaking the pattern the surrounding code enforces and making it invisible to config deviations/hash fingerprinting. **Fix direction**: promote to a `ScoringKnobs.zoneFactorPenalty` field alongside its neighbors, defaulting to 0.4 for byte-identical behavior.

7. **g4.search.ts / assignment.ts — fixed 14px recovered-tee dedupe radius** (also independently re-derived at teeRecovery.ts:779-781). A fixed pixel-distance de-duplication threshold, applied at two separate call sites, that doesn't scale with image resolution: too aggressive at high zoom (merges genuinely distinct nearby tees), too lax at low zoom (misses true duplicates). **Fix direction**: scale the dedupe distance by the same corridor/field-scale parameter already threaded through `CorridorParams`, and route both call sites through one shared function to avoid the duplicate-constant drift risk.

8. **g5.zfit.ts — fixed-pixel waypoint search geometry** (`distanceStartOffset=8`, `distanceStepPx=14`, `maxAdditionalDistance=220`). Like corridorWidthPx, these are absolute-pixel search parameters for the bent-path salvage feature; they inherit the same scale-invariance problem one layer up in the Z-fit search rather than being expressed as multiples of `corridorWidthPx` the way the bend-length knobs correctly are. **Fix direction**: express these three as multiples of `corridorWidthPx` (as `bendLengthShort/Medium/Long` already are) rather than bare pixels.

9. **assignment.ts:226-323 — strict global 1:1:1 badge:tee:basket exclusivity**. The local-search optimizer assumes every tee and every basket in frame belongs to at most one badge for the entire image. A shared/central tee complex genuinely serving two numbered holes, or a temporary shared basket, cannot be represented — one of the two legitimate readings is structurally forced to lose the contested object. **Fix direction**: at minimum, surface this as an explicit documented limitation; longer-term, allow a configurable exception list (course metadata flagging known shared tees/baskets) rather than a blanket one-owner rule.

10. **st.fourLaneSensor.ts — fixed 4-lane (2-rail + 2-inner) corridor cross-section model** (`laneOffsets = [-W/2, -W/6, W/6, W/2]`). Though correctly relative to `corridorWidthPx` (so it does not independently suffer the scale-invariance problem), it bakes a specific "two parallel rails plus two inner lanes" structural shape as the *only* recognized path cross-section. A single-track path, an asymmetric path (paved on one side only), or any path whose real cross-section doesn't match this fixed 4-way split reads as sensor noise rather than "path of a different shape." **Fix direction**: since this feature is unwired/default-OFF and explicitly scoped as "observation primitive only," this is lower urgency than #1-9, but worth flagging before a future TBS/GS unit builds on top of it — consider parameterizing the lane count/offsets rather than hard-coding exactly 4.
