# CX Catalog — invariants, edge cases, and techniques (dev72 seed)

Seed inventory for the Continuous eXperimentation lab: every invariant,
corner case, failure mode, and technique established on the road to
72/72 dev exact (tag target `010a039`/`6d7f0fe`, branch
`claude/nuthing-p2-digit-recognition-zgs4lq`). Each entry records what is
claimed, how it was measured, where it lives, and what it fixed — so the
lab can re-test the claim itself instead of re-tuning against the latest
break. Companion narrative: `distractor-attribution.md` (full sweeps and
war stories), `pair-matrix-baseline.md` (results ledger).

Entry format — **ID. Name** · category · claim · evidence · code · fixed
· generalization risk (what a validation course could break).

---

## A. Render-model facts (the physics everything rests on)

**CX-001. Render stack order.** fact.
Badges > basket sprites > rings/fills (C2D, C2F, C1S, C1F) > hole-path
corridor > tee pads > BTD walking path > satellite imagery. Corridors
draw OVER tee pads; sprites and badges draw over everything below them.
Evidence: Linear "Working Model" doc (f69b754b), confirmed repeatedly by
occlusion behavior (corridor paint covering pad borders, sprites covering
badges). Risk: a renderer update reorders layers.

**CX-002. Corridor is a round-capped polyline.** fact.
Gray rectangles + right-triangle bend wedges + perfect semicircular end
caps at BOTH ends (tee end and basket end); cap center ~4.5 px inside the
endpoint; cap radius W/2. Not terrain, not "mown fairway" — vector UI.
Evidence: cap-test/corridor-width probes; corrected in `239b9ea` after
review. Code: model constants used in `basket-backwalk.ts`,
`tee_recovery_*`. Fixed: terrain-based misinterpretations of alpha.

**CX-003. One corridor width per course.** fact/constant.
W is a per-course constant: DashsTrack 40, HeritagePark 30, Lenard 37,
TowneLake 37 (annotated; FWHM agrees 37/30/31/36). Code:
`COURSE_CORRIDOR_WIDTH` in `src/lib/nuthing/badgeOcclusion.ts`.
Risk: per-course W must be estimated on unseen courses (FWHM works).

**CX-004. Corridor paint model.** fact/constant.
Composite = α·C + (1−α)·ground with C ≈ RGB[150,155,145], α ≈ 0.61–0.90
(course-dependent), at overview zoom. Consequence: corridor over DARK
ground composites dark (V≈90–110) and defeats brightness thresholds —
contrast-vs-local-ground is the robust reading (see CX-034). Evidence:
learn-local-alpha regressions (`913bd04`, `5bd6701`).

**CX-005. Basket sprite geometry.** fact/constant.
42×66 bbox; opaque glyph ≈1746 of 2772 px; semi-transparent skirt
(shadow/glow) inside the bbox; basket anchor (pole tip) = sprite bottom
+ 4 px. NOT byte-stable across instances on all rasters — compression
noise ~4 gray — so "identical" tests must be statistical (std/MAD), not
exact. Code: `resources/nuthing-p2/endpoints/basket-sprite.json`,
`matchBasketSprites`.

**CX-006. Basket-zone furniture.** fact/constant.
C1S solid ring r≈44±8, C2D dashed ring r≈84±12, C1F/C2F translucent
fills; all pixel-locked to the anchor — the ENTIRE zone is one repeated
stamp per course (basis of CX-030). Ring-band tolerances (±8/±12) are for
band scoring; the actual strokes are a few px (local probes use tol 3).

**CX-007. Badge anatomy.** fact/constant.
White frame ~54×42 around a near-black plate ~48×36 (fill ≥0.55,
aspect 1.0–2.4) holding white digit glyphs (4–40 % of eroded plate
interior). The plate can never merge with white renders — the frame can
(CX-024). Code: `runBadgeStage` (frame family + plate recovery),
`badge_plate_recovery.py`.

**CX-008. Lift signatures.** fact/constant.
Control-corrected gray lift over perpendicular background: tee→badge
ribbon +48, badge→basket ribbon +33, BTD walking path +17, C2F fill −7.
Used for: solid-vs-dashed discrimination (threshold 24 sits between
corridor and BTD), patch reference (LIFT_REF 45/33). Evidence:
`lift-signatures.ts`.

**CX-009. Tee pad anatomy.** fact/constant.
Hollow white rectangular border (stroke ~3 px) with only a small hollow
glyph inside; per-course modal size (border-centerline half-extents
~13.0×9.5 / 6.9×5.0 / 8.3×6.2 / 8.5×6.5). Ring-tier detection carries
the pad's principal-axis orientation. BTD dashes are the top tee-FP
source; badge frames the second (CX-018).

---

## B. Validated invariants (each measured on dev truth before wiring)

**CX-010. Tee aims at its badge.** invariant.
Ring-tier tee long axis → own badge: median 1.1°, p90 2.65°, max 11.3°
(n=59). False badges: median 38°, p10 6.5°. Wired as gaussian σ=6°
(replay `--invariants`). Origin: P3 branch, re-validated in this frame.

**CX-011. Badge before any bend.** invariant.
The badge lies on the corridor's FIRST segment. Consequences: tee→badge
direction = segment-1 direction (used by Z-fit seeding); basket→badge is
NOT the approach direction on doglegs (this broke the backwalk
subagent's self-validation — CX-040).

**CX-012. Badge longitudinal fraction.** invariant + corner case.
Badge projects onto tee→basket at 0.17–0.54 (median 0.51, n=72).
CORNER CASE: the prior was first wired as 0.45±0.15 (asymmetric vs the
measurement) and taxed Heritage h7 (frac 0.165) by 0.44×, drowning its
true pair below a straight rival — the last wrong hole on dev. Recentered
to 0.36±0.19 (`6d7f0fe`); ablation: this fix ALONE reached 72/72.
Lesson: wire the measured band, not a rounded aesthetic of it.

**CX-013. Straight-hole collinearity.** invariant.
On straight holes tee, badge, basket are collinear ≤1.4° (41/41; Lenard
median 0.5°). Wired as a BONUS, never a penalty: score ×=
1 + B·exp(−(collin/σ)²), B=0.6, σ=2°. Sweep: B=0.3–0.6/σ=2 flips all six
Lenard cluster thefts at once, zero regression; B≥1 or σ=4 bribes dogleg
courses into fake straight lines (Heritage 17→9). Lesson: invariants that
hold on a SUBSET of holes must reward conformance, not punish deviation.

**CX-014. Simple-path discipline.** invariant.
In tee→badge→basket the badge is interior: the concatenated true path
never doubles back over itself. Overlap fraction = 0.00 for ALL 61 true
pairs; up to 0.88 for strongest false competitors. Wired: ×(1−overlap)²
(replay `--simple`).

**CX-015. Corridors terminate one-sidedly.** invariant.
A corridor ENDS at the basket (cap) — paint continues in exactly one
direction from the anchor. Caveats that weakened naive wiring: the BTD
path legitimately leaves the basket roughly opposite many approaches
(pollutes opposite-side tests), and zone fills are radially symmetric
(defeat perpendicular-flank contrast; see CX-032/033).

**CX-016. Corridor is a ≤2-bend polyline.** invariant (model bound).
Bend angle ≤60°, connector ≤3W, total length ≤1.4× chord — sufficient for
every dev hole incl. the cancelling S. Basis of the Z-fit (CX-037).
Risk: a 3-bend hole on validation courses.

**CX-017. Tees stand on neighbor C2D rings.** invariant/corner case.
16 real dev tees stand ON another basket's dashed ring. Early ring-
furniture exclusion deleted them; fix: keep + tag `onRing`. Lesson:
"furniture proximity" is not a tee veto.

---

## C. Occlusion edge cases and their fixes

**CX-018. Badge frames masquerade as tee pads.** edge case.
A blind occluder-adjacent pad search fit 18 Dashs badge frames as pads
(a frame IS a pad-shaped white ring). Fix: badge occluder = the badge's
actual white-frame COMPONENT bbox (a fixed plate-centered box
under-covers the frame and its surviving edges pass the pad model);
plus fragment ANCHORING (no fragment touching an occluder → no search).
27 blind-grid FPs → 2. Code: `occluded_tee_recovery.py` (v2).

**CX-019. Tee under sprite bbox.** edge case (Heritage h5/h10).
Pads partially covered by the sprite rectangle: masked F0.5 border fit —
explained (observed bright on ring) × coverage (visible expected ring
supported), missing ring EXCUSED only under the occluder, minimum
visible-ring fraction so a fully buried placement can't score on
nothing. Additional vetoes: ≤2 supporting components (C2D dash arcs
"support" a fake ring with 4–6), interior-contradiction (pad interior
must not be bright).

**CX-020. Tee under the sprite's semi-transparent skirt.** edge case
(Heritage h6 — the deepest one).
The bbox is NOT opaque (CX-005): treating it as opaque deletes the only
evidence. Fix chain, each step forced by a measured failure:
(a) alpha inversion from the course's sprite instance stack — per-pixel
α = 1 − std/sig_ref (sig_ref = median std at always-transparent bbox
corners), αS = mean − (1−α)·μ_ground, reconstruct Ĝ = (V−αS)/(1−α);
(b) UNIQUENESS filter — a pixel whose reconstruction is bright in >2
instances is a repeated un-blending artifact, not ground (removed
whole FP families);
(c) placement-level family filter — recovered placements sharing a
bbox-relative offset at ≥3 baskets are one artifact (removed 58);
(d) support-aware excusal — excuse a covered ring point only if NO
evidence supports it (excusal-always crushed h5/h10 coverage 0.9→0.46);
(e) gating/excusal split — fragments gate on the RECT bbox, excusal uses
the alpha mask (gating on the shrunken mask silently orphaned h5);
(f) furniture veto (no pad within 25 px of a bright component >400 px)
MUST exempt known sprite/badge components or it swallows every
under-sprite recovery.
Code: `occluded_tee_recovery_v3.py`. Result: 72/72 tee availability.

**CX-021. Slide-to-hide degeneracy.** edge case (h6's 11 px offset).
A masked fit slides deeper under the occluder because coverage averages
only non-excused points — hiding the pad's unsupported ring raises the
score (truth-centered 0.60 vs slid 0.90; pure long-axis translation).
The 0.5 support band was ACQUITTED by measurement (evidence sat at
median +0.2 px signed distance to the ring centerline). Plateau-midpoint
estimator measured and REJECTED (no plateau back to truth). Resolution:
the corridor start pins the pad — h6's own corridor centerline sits at
x≈731, on the registered tee (730.1), 10 px off the slid fit (741).
Lesson: masked scoring needs an external geometric pin; corridor
terminus is the natural one (open follow-up).

**CX-022. Corridor start-cap sliver.** edge case + self-correction.
A ≤W/2 sliver of corridor beside a sprite bbox IS readable evidence
(gray over dark trees: lift +45 against a CLEAN reference). First
reading called it "dark ground" because the ground-reference window
overlapped the band itself. Lesson: contamination of the reference is
the first thing to rule out in any lift measurement.

**CX-023. Overlapping corridor structures near one anchor.** edge case.
The column west of Heritage B11 stacks: badge frame white (y 815–835),
h6's corridor over dark trees (851–931), a second full-gray corridor
from the south (≥959). No single terminus model fits a composite column;
per-row segmentation before any cap fit.

**CX-024. Baskets eat badges.** edge case (Heritage 2/12/13/15, Lenard
5/12 — SIX silent badge losses).
Sprite overlaps badge frame → frame component merges with sprite blob →
frame-keyed family detection loses the badge. Fix: detect the DARK PLATE
(CX-007) — 18/18 plates per course, all four courses, ZERO FPs; identity
unambiguous via ray invariant (each plate on exactly one tee→basket ray
at 0.18–0.52, perp ≤7 px). Wired into `runBadgeStage` (synthesized
frame-sized ComponentStats, label −1).

**CX-025. Sprite intrusion segments as phantom digits.** edge case.
For plate-recovered badges the merged frame/sprite white intrudes into
the plate bbox and segments as extra digits ('2912', '62', '03'). Fix:
glyph extraction excludes bright pixels belonging to LARGE components
(>350 px; digits ≤~200, merged blobs thousands) for label<0 badges.
Code: `badgeGlyph.ts`. Result: all six recovered badges read correctly.

**CX-026. Badge recovery deletes a neighbor tee.** edge case (h15).
The badge-box tee exclusion swept a REAL ring tee standing 22 px from a
newly recovered badge's center. Fix: zonal exclusion — hard-exclude only
the plate INTERIOR (where hollow digit glyphs 0/8 pose as tee rings);
ring-tier candidates survive at the frame edge. Component-tier keeps the
full expanded box. Lesson: every occluder-exclusion needs a carve-out
audit when the occluder set grows.

**CX-027. Sprite lookalikes on rooftops.** edge case (Heritage B18,
score 0.48, chosen only by a tee-less hole).
Basket pool FPs: score separates true/FP on 3 courses but Lenard has an
occluded TRUE basket at 0.33 below FPs at 0.52 — no global threshold.
Parked because complete tee pools stop anything selecting them; future
fix: masked exact-match rescoring over non-occluded template pixels.

**CX-028. Tree line under the corridor.** edge case (h7 postscript).
Dark underlay dims the composite (CX-004): south half −22..46 gray
through x 952–968, dim side FLIPS north at x≈970 as the trees cross —
the apparent bright band thins and shifts toward the un-dimmed edge.
BOTH the support field AND the registered truth traced the thinned north
edge; the flanked-contrast centerline runs down the true middle. Fix
direction (task #22): corridor support by local flanked contrast at
course W. Also explains part of Heritage's truth noise (CX-041).

---

## D. Pairing/assignment corner cases

**CX-029. Theft chains.** corner case.
Greedy 1:1 assignment cascades: one wrong claim steals a neighbor's
endpoint, which steals the next (Lenard h9→h5→h8→h7 basket chain;
h3↔h11 swap; Heritage h4 stealing T12 until badge 12 existed). Fix:
exchange optimizer (greedy seed + single-move + two-badge exchange,
3 deterministic starts, raw scores — per-badge normalization measured
WORSE, 38 vs 42). Root fix is upstream completeness: most chains
dissolved when badges/tees stopped being missing.

**CX-030. Zone-stamp un-blend.** technique.
The whole basket zone is one anchor-locked stamp (CX-006): stack
anchor-centered windows across a course's baskets (median/MAD alpha),
invert, and the corridor — terminal cap included — becomes visible
INSIDE the zone. In-zone bearing readout: 41 good/20 catastrophic on 69
reliable-truth baskets (parity with the backwalk from an independent
mechanism); Heritage h4 168°→16°, Lenard h2 174°→22°. REQUIRES a
furniture mask: neighbor sprites/badges/tees sit at varying offsets, are
not cancelled, and dominate the readout until masked. Code:
`zone_stamp_unblend.py`.

**CX-031. Backwalk 180° trap.** edge case.
Approach-bearing argmax locks onto the BTD path or a neighboring
corridor leaving the basket the other way (12/63 catastrophic >100°,
often ~180°). The two biggest single wins: excluding tee boxes from
occluders (median 14.0°→7.5°) and a 200 px scan window (discrimination
plateau 200–230 px). Its self-reported confidence/margin is
ANTI-correlated with correctness on the pairing's target holes (conf
1.00 at 173° error) — never gate on a single instrument's confidence.
Code: `basket-backwalk.ts` (+ peaks with clue features, raw radial
profiles as a replay node).

**CX-032. Radial fills defeat perpendicular flanks.** edge case.
Zone fills are radially symmetric around the anchor: center-vs-
perpendicular-flank contrast reads "paint" ~48 px behind EVERY anchor.
Fix: ROTATED flanks — compare radius-r on-axis arc against the same
radius rotated ±50°; radial fields cancel exactly, strips through the
anchor survive. The strongest single backwalk clue came from this:
trap directions show NO near-field evidence (first 60 px ≈ 0) while
drawing their whole score from a distant corridor crossing the ray.

**CX-033. Agreement gate.** technique.
Two independent bearing instruments (backwalk: out-of-zone flanked
contrast; zone-stamp: in-zone un-blended geometry) agreeing within 20°:
26 good / 3 catastrophic of 31 (84 % precision, 43 % coverage); on
disagreement both are coin flips — abstain. The 3 bad agreements are
cluster cases where both lock onto the same real neighboring corridor
(the locally-undecidable set). Needs no truth at all — the calibration
IS the agreement.

**CX-034. Brightness-keyed detection reads thin over dark ground.**
systemic bias. Affects the ribbon support field, raw bright masks, and
(historically) the human truth annotation (CX-028, CX-041). Robust
form everywhere: local flanked contrast at the course W. Open work:
task #22 (contrast-based support field).

**CX-035. Recovered-candidate tier prior.** technique/corner case.
Speculative pool members (occluded-tee recoveries) must not outbid
detector-verified candidates on healthy holes: tier prior 0.7 (sweep:
1.0 → a recovered FP poached DashsTrack h6; 0.5 → true recoveries lose
their own holes; 0.7–0.85 plateau). Truth-blind FP filtering of the
recovered pool FAILED honestly: the furniture veto misses the
translucent Apple Maps label (below the bright threshold) and
corridor-field support fires on rooftops. The prior is the mechanism,
not pool censorship.

**CX-036. Parallel-band substitution.** edge case (h7 routing).
Dijkstra can take a wrong parallel corridor of EQUAL length — a detour
in position, not length — so routed-length gates cannot detect it (that
gate measurably failed). Detection surface: the true pair's aligned
worst-window drowns while a neighbor's stays healthy.

**CX-037. Z-fit rescue.** technique + corner case.
Score a pair by the best explicit ≤2-bend polyline through the badge
(CX-016), sampled with the identical aligned/zone machinery as routes.
Found Heritage h7's cancelling-S connector at (949,696)→(956,673)
against registered (944,695)→(962,674), scoring the true pair 0.330 vs
the straight rival's 0.150. TWO corner cases: unconditional rescue lets
false pairs shop for 2-bend bridges (h4↔h12 basket swap) → SALVAGE-ONLY
gate (routed worst < 0.28); per-bend Occam discount (1/0.9/0.8) alone
is insufficient. Caveat: the fit optimizes over the same
brightness-biased field, so it reproduces the field's centerline bias
(CX-028). Flag `--zfit`; currently redundant for the 72/72 (CX-012's
fix alone suffices) — kept for validation courses.

**CX-038. Coordinate-frame deltaY.** implementation corner case.
Emitted products store FULL-raster yPx; caches and probes work in
viewport-cropped coordinates. Every consumer must subtract
`viewport.top` exactly once (a missed subtraction smeared an entire
overlay diagonally). Convention: resources/products = full-raster;
in-memory/caches = cropped.

---

**CX-042. Rank-1 saturation: uniqueness is the resolving structure.**
measurement / negative result.
At dev72 the per-row score family leaves 7/72 true pairs below rank 1
(ratios to their rival 0.71–0.97), five of seven same-tee-WRONG-BASKET
rivalries — yet assignment is 72/72. Measured attempts to tune them to
rank 1, all from cache: Z-fit/salvage widening is inert (the rows are
not drowned; the rival is simply strong); an agreement-bearing bonus
(--abearing, kept flag-gated OFF as a documented negative) churns rank1
65→64 unrestricted and BREAKS assignment 72→63–67 when
straightness-gated — in dense clusters, straight FALSE pairs over real
parallel paint collect the identical bonus. Conclusion: every soft
multiplier that helps these seven also arms their mirror-image false
pairs; rank1 65 + assigned 72 is the EQUILIBRIUM of the local family.
The 1:1 uniqueness constraint is not a patch over weak scores — it IS
the structure that resolves same-tee-wrong-basket rivalries, because
the rival basket is claimed by its rightful hole. Fragility budget:
rank≤3 = 71/72 (the assignment never rescues from deep in the pool).
Raising rank1 requires RIVAL-CONDITIONED evidence (e.g. the rival
basket's own agreed approach pointing at its OWN badge as
counter-evidence, bend-aware) — new structure, not tuning. Lab use:
rank1-vs-assigned gap is a standing metric; a validation course where
the gap widens signals the local family degrading before assignment
accuracy does.

**CX-058. Screen-space vs geo-space furniture split.** render fact.
Basket sprites and number badges are screen-space UI furniture: on The
Rec, captured at 2x the dev map zoom, the sprite still measures exactly
42x66 with glyph area 1743-1746 and badges read at native size, while
every geographic element (C1S/C2D zone rings, corridor width, tee pads)
doubles. Consequence: a capture at non-dev zoom is handled by a
DUAL-SCALE run — badge+sprite stages on the native raster, everything
geometric on a raster downscaled by the zoom ratio (where all dev-tuned
geo constants apply unchanged), detections mapped between frames
(`pair-matrix --native-raster/--geo-scale`). The zoom ratio itself is
measurable from render identity alone: ring radius or corridor width vs
the invariant 42x66 sprite.

**CX-059. Tee fill floor is size/rotation-coupled.** corner case.
A tee pad's bright component is its hollow white BORDER (fill = gray,
below the bright threshold), so its fill fraction falls as the pad grows
(border pixels scale with perimeter, bbox with area) and falls further
under rotation (bbox inflates). The Rec's geometry raster: all four
missed pads — and therefore all three wrong assignments — failed
exactly one gate, fill floor 0.2 (measured 0.13-0.199); every other
family bound passed. Floor lowered to 0.12: The Rec 9/9 assigned; dev
re-measured, endpoint recall 72/72 and ASSIGNED exact 72/72 unchanged
(rank1 65→64, within the CX-042 saturation picture). Lab use: fill-like
gates on hollow-outline families must be checked against the largest
and the rotated instances, not the population median.


**CX-060. Route slack in wide corridors: routed shape is not corridor
shape.** corner case, measured (TowneLake bend diagnosis, external
session).
A 37px corridor with a shallow real bend (6-8% detour) gives the
support-cost Dijkstra (cost 1+4(1-s)^2) a plateau of near-equal in-corridor
paths, so the routed leg does not hug the annotated bend vertex — on
flagged holes (h11, h16) and an unflagged control (h7) identically.
Measured routed-vs-truth aligned-support deltas: h16 +0.017 mean / +0.003
worst-window (near-equal geometry), h11 +0.096/+0.079, h7 +0.067/+0.119;
routed paths were LONGER and higher-support than truth — the cost model
prefers aligned support over length. Assignment is untouched (18/18 held;
endpoints and worst-window are plateau-insensitive). Consequence: any
consumer of routed SHAPE (bend proposals, corridor geometry) must fit
explicit polylines (Z-fit style, CX-037 machinery) rather than trust a
routed leg; never derive corridorBends from a route. Lab use: the routed
path is an evidence integral, not a geometry estimate.

**CX-061. False "truth is wrong" from instrument absence-reads.**
methodology, twice-reproduced (h6 this substrate; h16 in an external
Sonnet session).
Two different models declared a truth annotation wrong from the same error
shape: reading ABSENCE off a bad instrument (a ground-reference window
contaminated by the band it measured; a heatmap auto-normalized to its own
outlier max plus a badge plate occluding the corridor read as "no corridor
here"). Both corrected the same way: point-sampling raw pixels and field
values at the disputed location, checking for known occluders (CX-001/
CX-007: badges draw over corridors as opaque ~48x36 plates), and comparing
deltas against a control. Escalated bar for oracle disputes is codified in
the gated-diagnosis skill (step 8b). Lab use: model-independent trap;
process-level guard, not a model-quality issue.


## E. Truth-quality findings (judge the judge)

**CX-039. Heritage registration noise.** finding.
Registered truth sits a median 8.0 px (p90 11.1, max 14.2) from
pixel-verified detections, vs 1.2/1.5 px on Lenard/TowneLake. Any
Heritage distance judgment carries ~8 px noise (harmless under 18 px
joins, decisive under ~10 px questions). Mechanism at least partly
CX-028: the annotator traced what the render appeared to show.

**CX-040. Dogleg truth bearings are wrong by construction.** finding.
basket→own-badge is NOT the approach direction on doglegs (badge before
bend, CX-011) — the backwalk subagent validated against it and
mis-scored itself. Lenard records ZERO bends yet is all-straight
(measured: 16/16 badge-collinear ≤0.8°, chord violations all attributed
to walking-path/basket-zone contamination, h5/h12 chords fully
supported); its tee-line truth is therefore FINE — the "Lenard dogleg"
excuse was retired. Always derive approach truth from the last bend
where bends exist, and verify straightness before trusting tee-lines.

**CX-041. Truth can share the detector's bias.** meta-finding.
The registered h7 polyline follows the tree-thinned corridor edge —
truth and instrument failed the SAME way, so agreement with truth did
not detect the bias; an independent reading (flanked contrast, or a
human eye on the raw render) did. CX labs should include
truth-independent cross-instruments for exactly this.

---

## F. Methodology (how the above was found without self-deception)

**CX-050. Replay nodes.** Freeze expensive stages (field computation,
routing, evidence extraction, alpha stacks) as immutable snapshots;
every refinement re-scores from cache in seconds. Grid searches, plateau
analyses, and diagnostics all ran off nodes (`pair-matrix` caches,
`tee-recovery-node`, backwalk peak profiles). Skill:
`.claude/skills/replay-nodes/`.

**CX-051. Measure before wiring; sweep and record.** Every constant in
the stack has a recorded sweep next to it (tier prior, collinearity B/σ,
patch floors, R1 window, A_CUT...). Two floors (0 and 0.65) and one
normalization were REJECTED by measurement and the rejections recorded.

**CX-052. Leave-one-course-out for anything fitted.** Hand-weighted
combiners are fitted too — LOCO'd the same as forests. The
five-specialist overfit-and-compare: deliberately overfit one copy per
course, then read (a) knob convergence = universal mechanism (near-field
gate), (b) knob divergence = course-dependent axis (cap weight tracks
clutter; far-evidence flips sign open-vs-cluttered), (c) own-course
ceilings below oracle = formula limits, not tuning limits.

**CX-053. Ablate before attributing.** The 72nd hole was credited to
the Z-fit until ablation showed the frac-band recentering alone
sufficed. Attribution errors compound into false understanding — the
exact thing a CX lab exists to prevent.

**CX-054. Oracle ceilings first.** Before improving a chooser, measure
the best reachable choice (backwalk peaks: oracle 64/69 good, 0
catastrophic → re-ranking was the right frame; peak-extraction misses
where even the oracle fails are a different bug class).

**CX-055. Numbers ship with annotated images.** Standing rule. Multiple
session-critical discoveries were made BY a human looking at a rendered
overlay (tee under skirt, cap sliver, badge eating, tree line, deltaY),
not by metrics. Renders are not decoration; they are the second
instrument.

**CX-056. External review is an instrument.** Cross-checking with an
independent reviewer (human or other model) surfaced: h6's bbox-opacity
deletion, the corridor sliver identity, badge cross-contamination, the
tree underlay. Verify externally-supplied diagnoses against pixels
before acting (the h6 claim was verified, then extended).

---

**CX-057. Overfit-ceiling replication.** methodology.
The five-specialist experiment re-run on the dev72 substrate (complete
badge/tee pools, corrected Lenard truth; SAME family, SAME seeded 30k
search) replicates the original ceilings almost exactly (Dashs 16/18,
Heritage 10/17, Lenard 11/18, TowneLake 16/18) while the oracle improved
(Lenard 18/18). Better substrate does not lift a formula-limited family;
adding one structurally new term (zone-stamp agreement) lifts each
cluttered course ~1 and halves pooled catastrophic. Per-course
overfitting is therefore a STABLE, REPEATABLE diagnostic: run it after
any change — ceilings move only when the family gains structure (new
independent evidence or a decision hierarchy), never when the substrate
or tuner improves. Companion negative: agreement used as a raw gate with
a naive fallback is WORSE standalone (43/72) — the gate needs a
competent partner under it (see CX-033, CX-042).

## Open items seeded for the lab

1. Contrast-based ribbon support field (task #22, CX-034) — validate on
   wooded courses.
2. Corridor-terminus constraint for tee recovery (CX-021 pin) — also
   kills rooftop/logo FPs.
3. Masked exact-match basket precision (CX-027).
4. Candidate-conditioned approach scoring in assignment (CX-033's
   agreement signal as a soft term).
5. Rival-conditioned pairing evidence (CX-042): score a pair against
   what its RIVAL's endpoints claim for themselves, bend-aware — the
   measured path to rank1 beyond 65.
6. Validation-course run (FountainHills hydrated, never consulted): the
   entire catalog above is dev-derived; every entry is a hypothesis
   there.
