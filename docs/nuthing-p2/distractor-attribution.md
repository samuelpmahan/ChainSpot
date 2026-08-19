# Distractor attribution — straight-hole ray test + per-failure classification

Status: test defined here first (documentation-before-measurement); results
sections are filled in by `scripts/nuthing/straight-hole-test.ts`, a pure
replay over the cached pair matrix (no re-detection, no re-routing).

## The invariant under test

Extends the validated P3 invariant one step further. Known so far, both
measured on dev truth:

- the teepad's long axis points at its badge (median error 1.1°, p90 2.65°);
- the badge sits before any bend, at 0.19–0.54 of the way tee→basket.

**Corollary for STRAIGHT holes (no recorded corridor bends): the tee→badge
ray, extended, passes through the basket, and the recovered path should run
straight down the middle of the hole.** On a straight hole the corridor IS
the chord, so any place the recovered route leaves the chord is, by
construction, not the hole — it is a distractor pulling the route sideways.
That makes straight holes a clean *distractor detector*: deviation location
→ which render element grabbed the route.

Straight-hole coverage from corpus bend truth
(`/workspace/chainspot-corpus/dev/Annotated/*/…annotation.json`,
`corridorBends` empty):

| course | straight holes |
|---|---|
| DashsTrack | 9 (h3 h6 h9 h10 h11 h12 h13 h16 h17) |
| HeritagePark | 2 (h6 h17) |
| Lenard | **18 — every hole** (the weakest pairing course gets full coverage) |
| TowneLake | 15 (all but h7 h11 h16) |

## Measurements per straight hole (from cached evidence only)

1. **Ray test**: angle between direction(tee→badge) and
   direction(tee→basket) for the TRUE triple. Invariant prediction: ~0°.
   A hole that fails this while its neighbors pass indicates a badge or
   endpoint mislocalization, not a routing problem.
2. **Chord adherence**: for the true pair's cached route, the perpendicular
   distance profile from the tee→basket chord; report max deviation, where
   along the hole it peaks (fraction 0..1), and the arc length off-chord
   beyond a corridor half-width (~22 px, half the median annotated corridor
   width).
3. **Deviation attribution**: classify the peak-deviation point (and every
   off-chord span) against the cached endpoint/zone geometry, in priority
   order:
   - `basket-zone` — within a foreign basket's furniture: sprite ≤35 px of
     a sprite center, C1S ring 44±8, C2D ring 84±12 (from cached sprite
     tips/centers);
   - `tee-glyph` — within 15 px of a foreign tee candidate;
   - `diamond` — within 15 px of a diamond (path/ring marker) candidate
     (requires diamonds cached; else folded into `unknown`);
   - `badge` — within a badge bbox +6 px;
   - `unknown/walking-path` — none of the above; on this render stack the
     dominant remaining oriented linear structure is the dashed walking
     path (verified visually in earlier failure zooms).

## Per-failure distractor classification (the 7 wrong assignments)

For each hole the final stack (`--zones --simple --invariants --identity
--assign`) still assigns wrongly, classify what beat the truth: attribute
the CHOSEN (wrong) route's support the same way as above, and attribute the
TRUE pair's weak windows (what suppressed the truth). Current wrong set:

- HeritagePark h4, h7, h16
- Lenard h3, h9
- TowneLake h2, h3

(DashsTrack is 18/18 exact after the exchange-move assignment fix.)

## Results

Produced by `scripts/nuthing/straight-hole-test.ts` (replay over the cached
matrix); overlays `<cache>/<course>-straight-test.png` (blue = tee→basket
chord, green = chord-clean route, orange = violating route) and
`<course>-wrongs.png` (green = true route, red = chosen wrong route).

### Straight-hole ray test — the invariant holds almost exactly

41 straight truth holes: ray angle (tee→badge vs tee→basket) **median
0.5°, p90 0.9°, max 1.4°**. On a straight hole, tee, badge and basket are
collinear to sub-degree precision — sharper even than the tee-axis
invariant (max 1.4° vs 11.3°). No hole fails, so no badge/endpoint
mislocalizations are hiding in the truth set.

### Straight-hole chord adherence + attribution

32/41 routes stay within a corridor half-width of the chord end to end.
The 9 violations (max deviation 23–41 px, off-chord arcs 28–120 px):

| violation | attribution at peak |
|---|---|
| Dashs h6, h17; Lenard h3, h10, h11, h13; TowneLake h3, h10 | **unknown/walking-path** (8) |
| Lenard h14 | **basket-zone** (1) |

Visual confirmation (zooms): Lenard h10's route leaves the chord to ride
the visible walking path; Lenard h14 detours through the neighboring
basket's C2 zone. **The walking path is the dominant unhandled
distractor**, exactly as the render-stack doc predicts — it is linear and
oriented, so neither strip-coherence nor zone attribution touches it.

### Wrong-assignment classifications (7 holes, final stack)

Off-chord route composition (own-corridor cells excluded — a cell within
22 px of the pair's own chord is on-hole by definition):

| hole | wrong side | chosen route off-chord | true route off-chord | classification |
|---|---|---|---|---|
| Heritage h4 | basket | 5 cells, walking-path | 0 cells | adjacent-basket contention (both routes clean; chosen sprite 0.65 vs occluded true) |
| Heritage h7 | tee | 86 cells: 22% basket-zone, 10% tee-glyph, 67% walking-path | 16 cells walking-path | true-evidence failure (true pair ranks 52) + furniture tee T32 |
| Heritage h16 | basket | 25 cells: 60% basket-zone | 0 cells | C2D/C2F carpet into adjacent basket |
| Lenard h3 | tee | 21 cells: 100% basket-zone | 19 cells: 63% basket-zone | dense basket-zone cluster distortion, component-tier tee |
| Lenard h9 | basket | 44 cells: 82% walking-path | 0 cells | walking path to adjacent basket |
| TowneLake h2 | basket | 109 cells: 70% walking-path | 0 cells | walking-path detour |
| TowneLake h3 | basket | 54 cells: 100% walking-path | 14 cells walking-path | walking path |

Tally over chosen wrong routes: walking-path implicated in 5/7,
basket-zone 4/7, tee-glyph 1/7, badge 0/7.

## Local alpha, learned from the strongest tee→badge segments

The corridor is a semi-transparent overlay composited onto the basemap, and
the strongest tee→badge segments are *guaranteed ribbon interior* (straight,
pre-bend, ray ≤1.4°) — so they are labeled training data for the overlay's
local compositing behavior, free. `scripts/nuthing/learn-local-alpha.ts` +
`lift-signatures.ts`, measured on the 6 top-scoring correctly-assigned
holes per course:

- **CORRECTED (was wrongly attributed to "mown fairway"): the corridor is
  rendered UI, not terrain.** Every element this pipeline identifies is a
  drawn vector primitive: the hole path is **gray rectangles, with right
  triangles appended to create bends, ending in perfect semicircles at
  both ends** (round-capped thick polyline). Under that model the
  edge-pair regression's answer — mostly-opaque gray paint, α≈0.6–0.9,
  C≈[150,155,145] gray, per-course α 0.61–0.90 — is the straightforward
  reading, and the earlier "ground under differs" objection was wrong.
- **Cross-corridor profiles** match the paint model: flat plateau, sharp
  ~3 px transition at the annotated corridor width, no edge stroke (the
  paired-edge field fires on the transition itself).
- **End-cap test (measured)**: radial lift profile behind truth tees on
  straight correct holes shows corridor paint persisting behind the tee
  and terminating at r≈0.8·(W/2), zero beyond — a semicircular cap whose
  center sits ~0.2·(W/2) (~4–5 px) ahead of the annotated tee point (the
  r≈0.35 bump is the tee glyph itself). Sideways the paint spans the full
  annotated width at the tee, exactly what a slightly-advanced cap center
  predicts (chord width 0.98·W there).
- **The operational "local alpha" is the lift signature** — brightness at a
  cell minus the darker of two ±30 px perpendicular background samples
  (control-corrected by the +12 baseline this min() introduces):

| family (n) | corrected gray lift | plateau (L8/L0) |
|---|---|---|
| ribbon: tee→badge (788) | **+48** | 0.98 (broad) |
| ribbon: badge→basket, straight holes, pre-zone (228) | **+33** | 1.06 (broad) |
| walking-path ride (123) | +17 | 1.23 |
| C2F zone fill (3432) | −7 | — |
| random ground (1078) | 0 (baseline) | 1.08 |

The badge→basket family (verified-straight holes only, cells within 95 px
of the basket tip excluded so zone fill never contaminates it) confirms the
signature is the overlay's, not the near-tee ground's: both halves of the
hole lift 2–3× the walking path, with the far half a little lower —
consistent with heavier canopy occlusion on basket approaches.

The corridor's lift is ~3× the walking path's and ~flat across ±8 px —
a per-cell evidence channel (five gray reads per cell) that separates true
corridor from the walking path, the distractor class nothing upstream
handles. Wiring it in is a *measurement extension* under the replay
discipline: sample lift along every cached leg once, store it in the
snapshot (format bump), then re-score as a replay layer.

**What the exact-primitive model unlocks** (the corridor is a capsule:
rectangle + triangle bend wedges + semicircular caps):

1. **Cap-center endpoint refinement**: fit a semicircle of radius W/2 to
   the paint mask around each candidate endpoint; the fitted center is the
   polyline endpoint to sub-pixel precision — and a candidate with no cap
   is not a hole endpoint at all.
2. **Capsule-footprint pair scoring**: a (tee, basket) hypothesis on a
   straight hole predicts an EXACT paint footprint (capsule between the
   two cap centers). Score = footprint/paint-mask agreement — wrong pairs
   predict paint where there is none (their capsule crosses unpainted
   ground), and walking paths fail on width and cap geometry, not just
   color.

## Badge crossings: the diagonal swerve, and the one-sided edge detector

Reviewing what the router "sees" crossing badges (support-field crops at
badge crossings on straight holes) confirmed the reported swerve: the badge
is an opaque rounded rect ON TOP of the corridor, its black/white boundary
produces strong edge pairs at every orientation (a bright halo in the
support field), the true ribbon loses its edges under it — so the route
enters on one ribbon-edge ridge, crosses the badge **corner-to-corner along
its diagonal**, and exits on the opposite ridge.

Both failures are fixable because the occluder is known (badge bboxes are
detected precisely) and the corridor is a rectangle of one known width per
course. **Corridor width confirmed as a per-course render constant**: the
corpus annotations carry ONE `corridorWidthPx` per course (40/30/37/37,
identical for all 18 holes), and FWHM paint measurement agrees
(37/30/31/36 median). `src/lib/nuthing/badgeOcclusion.ts` applies two
patches to the support plane at measurement time (`--patch-badges`):

1. **Halo cap** — support within bbox+3 clamped to 0.5: a known occluder's
   boundary is never ribbon evidence; passable, not attractive.
2. **One-sided edge evidence** — for cells around the badge where exactly
   one of the ±W/2 paired-sample sides falls inside a badge bbox, score
   from the visible side alone: positive paint-lift polarity at distance
   W/2 places the centerline without seeing the blocked edge. Score floor
   0.5 (≈22 gray lift) — floors 0 and 0.65 both measured worse (an
   unfloored boost manufactures badge crossings that wrong routes exploit;
   0.65 starves it and assignment ties reshuffle).

Results on the patched snapshot (full replay stack):

| metric | unpatched | patched |
|---|---|---|
| straight-hole chord violations | 9 | 6 |
| near-badge deviation p90 (straight holes) | 7.6 px | 5.9 px |
| exact 1:1 assignment | 56/63 | **57/63** |
| per course | 18/8/14/16 | **18**/9/12/**18** |

DashsTrack and TowneLake are now perfect; Heritage 9/11. Honest cost:
Lenard gives back two (12/16) — making badge areas crossable helps wrong
routes too on the course whose margins are thinnest; its wrongs remain the
walking-path/basket-zone cases from the classification above.

## What this buys (next layers, both derivable from cache)

1. **Chord discipline**: a pair's own tee→basket chord is available at
   inference (it IS the hypothesis). In 4/7 wrongs the true route has ZERO
   off-chord cells while the chosen route detours 25–109. Before wiring:
   measure off-chord arc for TRUE pairs on BENT holes (doglegs legitimately
   leave the chord) to pick a shape that separates detour-around-distractor
   from genuine bend.
2. **Walking-path attribution**: the one distractor class with no handler.
   Dash chains are detectable from the bright-component universe; their
   support can be discounted like ring furniture.

## Basket backward-walk — does the basket zone testify to its own approach direction?

Directive: "wrong (tee,basket) assignments are almost always wrong on the
BASKET side" — figure out whether walking BACKWARD from a basket's precise
endpoint can recover the corridor's approach direction reliably enough that
a basket could reject pairs whose badge/tee do not lie along it.
`scripts/nuthing/basket-backwalk.ts` (pure replay: reads only the cached
pair matrix + support/theta planes; nothing re-detected, nothing re-routed,
pairing untouched) measures this for every basket candidate in the cache and
validates against the same 63-hole dev truth join used above. Method
documented in the script header; summary:

1. **Direction scan** (not a walk first — a scan): score every candidate
   bearing theta (2° steps, full 360°) by **flanked-rectangle contrast** —
   mean gray in a corridor-width-wide band from r0=35 (just outside the
   sprite) to r1 minus the mean gray of two parallel flank bands one full
   width away (cancels the zone fill's near-basket brightness lift, which
   raises center and flank alike). Every sample first checks against known
   occluders — any basket's sprite bbox, any basket's ring bands (44±8,
   84±12, applied uniformly to the scored basket's OWN rings too, so
   legitimately crossing them is neither rewarded nor punished), any
   badge's box, any tee's box — and is dropped, not counted either way, if
   inside one.
2. **Field confirmation**: beyond r=90px the cached support/theta planes are
   trustworthy, so a second signal — support weighted by how well the
   field's own local best orientation aligns with theta (mod π) — is added
   to the color score (same strip-coherence idea as
   `pair-matrix-replay.ts`, reused for a ray instead of a route).
3. **Walk**: from the winning bearing, a short local re-scan (±20° window,
   capped turn rate) at each 4px step lets a centerline polyline bend with
   the paint until evidence drops for two consecutive steps or ~150px is
   covered. The walk is a confirmation/visualization aid; the reported
   bearing comes from the scan, not the walk's final heading.

### Two measured fixes before the numbers below were reachable

Two render-stack facts, invisible until measured, dominated the design and
are worth recording:

- **Badge and tee boxes are not in the pair-matrix cache** (only centers).
  Measured directly off the rendered pixels in all four courses (white pill
  rim around the digit glyph / rect glyph edges): badges ≈24–26px half-width,
  ≈20–21px half-height; tees ≈11–35px per axis. Fixed exclusion boxes
  (badge 28×24, tee 20×20 half-extents) were used since no per-instance bbox
  is cached. **Adding tee exclusion — not in the task's example occluder
  list — was one of the two biggest single wins**: DashsTrack median
  own-badge error 14.0° → 7.5°, discrimination 46.0% → 49.2%, holding
  everything else fixed.
- **The scan window has to run much further than "beyond the C2D ring"
  (96px) suggests.** `r1` was swept 110→360px against the full 63-hole
  truth join, holding everything else fixed: discrimination rises from 41%
  at 110px to a 60–62% plateau across 200–230px, then falls back below 45%
  by 320px as the window starts pulling in unrelated holes. The reason a
  wider window helps is a basket-sprite geometry fact that generalizes to
  *every* basket, not a one-off: the sprite is one fixed, unrotated 42×66
  bitmap with the pole tip near its bottom, so it occludes only ~4px in one
  screen direction but up to ~70px in the opposite one — a candidate bearing
  that happens to point into the sprite's tall side starts with over half
  of a 95px window pre-occluded before ring/badge exclusion even applies.
  Worse, on short-to-medium holes (badge ≈ half the tee→basket distance,
  per the established P3 invariant) **the basket's own badge sits inside a
  130px window and its exclusion box eats exactly the outer arc the TRUE
  bearing needed**, while nothing stops a false bearing from riding a
  short, clean, nearby distractor corridor instead. Case study: DashsTrack
  hole 4's basket (B17) has another basket (B16) 52px away and its own
  badge 124px away; at r1=130 the true bearing (toward the badge, 275°)
  survived only 12 samples (below the validity floor) while the false
  bearing (84°, riding paint 7.3° off basket-island neighbor badge 7)
  collected 49 samples at a real +39 gray lift — a genuine competing
  corridor immediately adjacent, not a scoring bug. r1=200 was picked from
  the middle of the measured plateau, not the extremes.

### Results (63-hole dev truth join, pure replay)

| course | n | own-badge err med | p90 | max | other-badge min-err med | discrimination |
|---|---|---|---|---|---|---|
| DashsTrack | 18 | 2.0° | 59.1° | 178.0° | 4.3° | 66.7% (12/18) |
| HeritagePark | 11 | 47.4° | 104.9° | 172.8° | 3.8° | 45.5% (5/11) |
| Lenard | 16 | 12.8° | 167.5° | 173.0° | 15.9° | 43.8% (7/16) |
| TowneLake | 18 | 0.5° | 11.7° | 155.9° | 4.8° | 83.3% (15/18) |
| **pooled** | **63** | **2.1°** | **152.5°** | **178.0°** | **8.2°** | **61.9% (39/63)** |

"Discrimination" = fraction of truth baskets whose estimated bearing is
closer to its own hole's badge than to every other badge in the course —
the property pairing would actually need. Runtime: 8.2s total for all 93
basket candidates across all four courses (~90ms/basket), well inside the
"few seconds per basket" budget.

**The distribution is sharply bimodal, not moderately noisy** — this is
the honest headline. Of the 63 truth holes: 39 (62%) land within 8° (median
2.1°, essentially the render's own precision — see the TowneLake overlay,
nearly every ray is green), 3 more within 20°, and **12 (19%) are wrong by
more than 100°** — DashsTrack h14/h18, HeritagePark h3/h4, Lenard
h2/h3/h6/h10/h11/h14/h15, TowneLake h12. These are not the walk misjudging
the true corridor's edge; it locked onto a *different, real* corridor
belonging to a neighboring hole. Checked programmatically for all 12: every
one has some other basket, tee, or (non-own) badge within 9–121px (the
closest of the three types, per hole), and hand inspection of the worst case
(DashsTrack hole 4, walked through in detail above) confirmed a second
hole's corridor genuinely runs close enough to the anchor to out-score the
true one within the same window that has to be wide enough to escape the
zone. **This is the same distractor mechanism the forward pipeline already
has (`pair-matrix-replay.ts`'s "46/53 strongest false competitors are real
endpoints of adjacent holes... real support, wrong strip"), now shown to
affect basket-local backward evidence too, not just full tee→basket
routes.** Proximity to another endpoint is necessary but not sufficient to
predict failure by itself (nearest-basket distance for the err≤15° half
averages 184px vs. 159px for the err>15° half — a real but weak signal, not
a clean discriminator on its own); the difference is ultimately in the
corridor evidence itself. Visual confirmation: `DashsTrack-full-backwalk.png`
at holes 4–8, a tight basket island, shows exactly this mix — some rays in
the cluster land correctly (green), others alias onto the neighbor
(red) — a course-level view backing the per-hole numbers, not a
hole-by-hole re-verification of all 12.

**What did NOT help, tried and measured:** weighting the field term by
alignment-only (dropping low-alignment samples from the denominator, "V1")
and a worst-sliding-window persistence score over the field ("V2") were
both tested against the same 63-hole join at several window widths;
neither beat the plain flanked-contrast-plus-mean-field design by more
than ~1 point of discrimination, and both cost more compute for no
reliable win. Kept the simpler design.

### Assessment

The signal is real and strong where the basket sits in open territory —
TowneLake's 83% discrimination and 11.7° p90 show the method comfortably
clears the "median ≤ 8°" target and would cleanly reject a wrong-basket
pairing there. But pooled p90 (152.5°) and the 19% catastrophic-failure
rate mean **this cannot be used alone, unfiltered, as a hard gate** —
doing so would wrongly veto some correct pairs in exactly the dense
clusters where the forward pipeline's basket-preference bug is worst,
which is not obviously better than today. It should integrate (a task for
later work, not this one) as a *soft* signal gated by its own reported
`confidence`/`margin` (both written per basket in `<course>-backwalk.json`)
— strong where isolated, silent/abstaining where clustered — rather than
as a blanket bearing-agreement filter. The clustering failure mode is
honestly the same one the whole NUTHING-P2 effort has been chasing
(distractor corridors, not measurement noise), and this measurement adds
evidence that it lives in the basket zone specifically, not just along
open fairway.

### Re-validation against bend-aware truth (joint review, pre-wiring)

The self-validation above judged bearings against basket→own-badge. But the
badge invariant says the badge is ALWAYS before any bend — so on dogleg
holes basket→badge is NOT the final approach direction, and the subagent's
truth is wrong in exactly the same way a naive walker would be. Re-joined
all 72 baskets against basket→last corridor bend (falling back to
basket→tee where the annotation records no bends; Lenard records none, so
its dogleg rows carry line-quality truth): 43/72 within 15°, 7 between
15–45°, **22/72 catastrophic (>45°, clustered at 130–175°)**. On
near-straight holes the walk is superb (median 1.2°). Zoomed crops of the
worst cases (scratchpad `backwalk-failures-zoom.png`) confirm every
inspected catastrophic case is the walker exiting the basket along a
*different real render* — the BTD walking path, the next hole's corridor,
or a clustered neighbor's corridor, usually out the back (~180°).

**Confidence/margin do not gate the failure mode.** Six catastrophic cases
report confidence 1.00 with margins 25–36 (Lenard h2/h3/h10, Heritage
h5/h7, DashsTrack h5). Keeping only margin ≥ 29 (top quartile) still
retains a catastrophic case while discarding most good ones.

**On the six currently-wrong assignment holes — the target set — the
signal is anti-correlated with its own confidence:** wrong with high
confidence on four (Heritage h4 168.5°@0.75, Heritage h7 82.9°@1.00,
Lenard h3 152.2°@1.00, Lenard h11 170.8°@0.63) and right on two only at
the lowest confidences in the dataset (Lenard h7 0.5°@0.37, Lenard h9
4.5°@0.53) — below any gate that removes the bad ones. The misassigned
holes are the dense clutter zones, which are precisely where the walker
grabs a neighboring render.

**Decision: NOT wired.** The confidence-weighted soft integration proposed
above would actively push four of the six target holes harder toward the
wrong badge. The salvageable idea is to invert the question: the walker's
per-direction flanked-contrast measurement is real evidence, but its argmax
is the trap. Scoring "corridor evidence leaving this basket toward
candidate badge B" inside the assignment loop — comparing only across the
row's candidate directions — removes the ~180° BTD/next-corridor trap,
because those directions are never candidate badge directions. That would
be a re-score of cached machinery, per the replay-node discipline; it is
deliberately left unbuilt pending review.

### Semicircle-aware rework: little-clue peaks + replay-node profiles

Per direction ("make it semicircle aware... almost a small random forest of
little clues"), the walker now emits its top-8 angular peaks per basket,
each dressed with render-model clue features, plus RAW per-radius lift
profiles so every downstream threshold/weight is grid-searchable from the
sidecar without re-touching images (the replay node). Clues, with what
measurement showed:

- **Cap edge** (paint inside vs outside the semicircular cap arc, slim
  local occluders): good-peak median +11.3 vs back-trap +2.1 — real but
  weak; the sprite owns most of the cap and neighbors' rings eat samples in
  exactly the clustered cases.
- **One-sidedness** (paint along theta+180): polluted by the BTD walking
  path, which legitimately leaves the basket roughly opposite many
  approaches (good peaks' opposite-side persistence median 0.35). A
  solid-only threshold (24 gray, between BTD's +17 and the ribbon's +33)
  helps but does not gate.
- **Perpendicular-flank paint boundary behind the anchor**: washed out by
  the basket zone's radially symmetric fills — "paint" appears to extend
  ~48px behind EVERY anchor (good 48px vs trap 68px). Dead end as designed.
- **Rotated-flank (radially fair) profiles** — contrast at radius r against
  the same radius rotated ±50° around the anchor, which cancels the zone
  fills exactly: the strongest clue found. Forward persistence: good 0.73
  vs back-trap 0.37. Sharper still, the trap signature is **no near-field
  evidence**: trap peaks score near-0 in the first 60px and draw their
  entire base score from a distant corridor crossing the ray (Heritage h4
  trap: near 0.00 / far 1.00), while a true termination always has paint
  immediately beyond the cap.
- **Teepad-on-ray**: individually weak (importance ~0.04) but participates
  in the Lenard h11 fix.

Combiners, all judged LOCO (leave-one-course-out) on the 69
reliable-truth baskets: base argmax 41 good / 22 catastrophic; additive
weights, solid-opposite, boundary, and a depth-5 forest over the full clue
set all land at parity (39–43 good / 22–27 cat). The one qualitative win
is the multiplicative **near-field gate** (base score × near-radial
fraction): it flips two of the six target holes to correct (Heritage h4
168.5°→0.5°, Lenard h11 170.8°→3.2°) and its best fixed config reaches
47 good / 16 cat descriptively — but LOCO instability and one regression
(Lenard h7, where a broad walking path passes right through the anchor
zone with genuine near-field paint) keep standalone argmax at parity.
Cluster cases where two real corridors touch the same anchor are not
locally decidable; Heritage h7's "miss" may partly be a registration
artifact (the render shows corridor paint north of the basket where the
registered polyline claims a western approach over grass).

Conclusion unchanged and sharpened: don't wire an argmax. The peaks +
clue features + raw radial profiles in the sidecar are the foundation for
candidate-conditioned scoring inside the assignment loop, where the
near-field gate and one-sidedness become per-candidate evidence rather
than a winner-take-all bearing.

### Five-specialist experiment: overfit each course, then compare

Instrumented overfitting ("set up 5 copies... tune each to perfectly map
one course. And compare"): four copies of the peak-ranker each tuned by
30k-trial random search to its own course alone, plus a pooled fifth —
all re-scored from the replay-node sidecars, judged on reliable-truth
rows. Findings:

- **Specialist ceilings expose a formula limit, not a tuning limit.**
  Open courses saturate (DashsTrack 16/18 cat 0, TowneLake 16/18 cat 0)
  but Heritage tops out at 10/17 and Lenard 11/16 even while overfitting,
  against per-course oracles of 14/17 and 16/16. The linear clue-score
  family cannot express what separates true from trap on those baskets no
  matter the weights.
- **The near-field gate is universal.** Every specialist independently
  chose gate strength a in 0.19–0.42 (pooled 0.13) — none turned it off.
  This is the one knob all five agree on.
- **Cap edge and far-evidence are the course-dependent knobs.** Dashs
  weights the cap 1.93, Heritage 1.25, TowneLake 0.97 — Lenard nearly
  drops it (0.12): its dense suburban clutter corrupts cap arcs. Far
  evidence flips SIGN: open TowneLake rewards it (+0.80) — long clean
  corridors — while Dashs and Lenard penalize evidence that lives only
  beyond 60px.
- **Transfer is asymmetric along an open-vs-cluttered axis.** Everyone
  scores 0.83–0.89 on Dashs/TowneLake regardless of tuning; nobody
  exceeds 0.59/0.69 on Heritage/Lenard, including their own specialists.
  Course difficulty, not parameterization, dominates.
- **13 reliable baskets defeat all five specialists.** Of these, ~6 are
  peak-extraction misses (no peak within 15° — oracle itself fails) and
  the rest are ranking-impossible within the family — including Lenard h3
  whose true peak sits at 0.2° error yet loses to a neighboring corridor
  under every weighting tried. These are the provably locally-undecidable
  set; only candidate-conditioned (non-local) information can settle them.
- **Target six under the specialists:** Heritage h4, Heritage h7, Lenard
  h9, h11 all land ≤5° (h7 is fixed by three of four FOREIGN specialists
  too — a robust fix, not an overfit); Lenard h7 near-misses at 22.5°;
  Lenard h3 stays at 152° under all five — the one locally hopeless
  target.

Net: a global config with the near-field gate is justified; cap weight
plausibly wants to scale with course clutter; and the remaining pairing
errors concentrate exactly where local evidence provably cannot decide —
the candidate-conditioned wiring is not just preferable but necessary for
those.


## Occluded-tee recovery — "the Heritage misses are partially covered boxes"

Confirmed by inspection: all four Heritage pool-missing tees are pads
partially covered by KNOWN occluders — h5/h6/h10 by the previous hole's
basket sprite, h15 by the "15" badge itself — with a white pad fragment
poking out beside the occluder in every case.

`scripts/cv-probes/occluded_tee_recovery.py` (fragment-anchored, per
direction): white-mask fragments ADJACENT to each matched sprite / badge
frame that could be tee paint, then fit the course's modal pad-border ring
where the fragment must lie ON the ring, scored by the masked deliberate
metric — F0.5 with coverage excused only where the occluder covers the
ring. Two hard-won lessons measured on the way: (1) the badge occluder
must be the badge's actual white FRAME component bbox — a fixed
plate-centered box under-covers the frame and its surviving edges fit the
pad model perfectly (18 false positives on DashsTrack, all badge frames);
(2) fragment anchoring, not grid sweep — a blind sweep over occluder
neighborhoods fits pad rings to corridor paint and dash arcs.

Result: **Heritage h10 recovered at 4.8 px (score 0.952) and h5 at 6.9 px
(0.914)**; h6 (a 3×7 px sliver) remains an honest miss; false positives
across all four dev courses: 2 (both DashsTrack map-furniture edges, e.g.
the Apple Maps label plate), acceptable as pool candidates for downstream
pairing evidence to discriminate. Dev tee availability rises 69/72 →
71/72.

### v3: alpha-unblended sprites recover h6 — tee endpoints 72/72

An external review of the recovery surfaced the correct diagnosis for h6:
its tee sits almost entirely INSIDE its basket's 42×66 sprite bbox
(truth center 0.9 px outside the bbox edge), and v2 marks that whole
rectangle occluded — deleting the only surviving evidence before scoring.
The render model says the bbox is not opaque: the sprite glyph covers
~1746 of 2772 px, and much of its skirt is SEMI-transparent (soft
shadow), so ground paint under it survives attenuated — h6's tee is
invisible to the raw bright mask but present under the shadow.

`occluded_tee_recovery_v3.py` inverts the alpha composite statistically
from the course's N sprite instances (the sprite is constant; the ground
varies): per-pixel alpha from cross-instance std against the always-
transparent bbox corners, then Ghat = (V − alphaS)/(1 − alpha). Hard-won
lessons, each measured: (1) reconstruction artifacts repeat at the same
bbox-relative offset at every basket — a cross-instance UNIQUENESS filter
per pixel plus a placement-level artifact-family filter (same offset at
≥3 baskets) removed 58 repeated false placements on Heritage alone;
(2) excusal must be support-aware — excuse a covered ring point only when
NO evidence supports it, so reconstructed paint counts positively while
unrecoverable shadow is still excused (a smaller occluder that "honestly"
holds the ring to account crushed h5/h10 coverage); (3) search gating
stays on the RECT bbox even though excusal uses the alpha mask (gating on
the shrunken mask silently orphaned h5's fragment); (4) big bright
components that are not known sprites/badges (rooftops, the map
attribution) get a 25 px exclusion — with the sprite components
themselves exempted, or the veto swallows every under-sprite recovery.

Result: **h6 recovered at 11.1 px (score 0.841)** and h5 independently
re-found at 6.8 px; union with v2 (which still supplies h10) recovers all
three Heritage misses — **dev tee availability 71/72 → 72/72**. Cost: 4
additional pool FPs (three Heritage rooftop corners, one Lenard facade),
all off-course furniture far from any truth tee; combined pool FP count
6 across four courses, inert to assignment because no corridor terminates
at them.

**Replay node** (`tee_recovery_node.py` / `tee_recovery_rescore.py`): the
evidence stage (instance stacking, alpha inversion, reconstruction,
uniqueness filtering, occluder assembly) is frozen per course under
`/workspace/nuthing-work/tee-recovery-node/`; all placement scoring,
plateau analysis, and fit rendering re-derive from the snapshots
(~20 s for three holes' full landscapes vs minutes per evidence rebuild).

**h6's 11 px offset — diagnosed, not fixed.** The suspected mechanism
(the 0.5 support band letting the border's inside count) is acquitted by
measurement: evidence at the winning placement sits at median +0.2 px
signed distance to the modeled ring centerline, 27 % inside. The real
mechanism is a **slide-to-hide degeneracy**: coverage averages only
non-excused ring points, so sliding the pad deeper under the occluder
excuses its unsupported ring — truth-centered scores 0.60 (coverage
0.35) vs 0.90 at the +11 px slide, a pure translation along the pad's
long axis. Plateau-midpoint as an estimator was measured off the node
and REJECTED (h6 10.2 px vs 11.0 — the score genuinely prefers the slid
position, there is no flat plateau back to truth; h5 worsens 1.0→3.1).
Remaining candidate fixes, unwired: report the degeneracy axis as a
positional-uncertainty field (pairing treats the recovered tee as a
short segment), or pin the slide with a reconstruction-based
interior-color consistency term.

**Follow-up (CORRECTED) — the band west of the bbox is corridor paint,
and it sides with the registered truth.** The first reading of that band
("dark ground, V 94 vs ground 157") was a measurement error: the ground
reference window itself overlapped the band. Against a clean reference
(x 698-712), the band is +45 gray of LIFT over dark tree ground —
h6's own hole-path corridor (the tee→badge segment runs due north,
badge 6 at (729.5, 824.5)), visible only as a ≤W/2 sliver west of the
sprite bbox, exactly as identified in review. The per-row profile
resolves the whole column: badge-6 frame white (y 815-835), the
corridor band (851-931, α≈0.5-consistent over dark ground), a
transition, then full corridor gray 150-158 south of 959 (a second,
heavier corridor structure approaching B11 from the south) — multiple
overlapping renders, no single cap.

The decisive number: the corridor's visible west edge sits at x≈716,
putting the **corridor centerline at x≈731 — on the registered truth
tee (x=730.1), not on the pad-fit (x=741)**. The tee is the corridor's
start point, so the corridor centerline pins the pad's x: the
slide-to-hide fit really did slide ~10 px off the pad, and the previous
conclusion ("the truth is wrong, the fit is right") is retracted. The
Heritage registration-noise calibration (median 8.0 px vs 1.2-1.5 px on
Lenard/TowneLake) stands as context, but the strongest local evidence
sides with truth on x; y remains soft (overlapping paint obscures the
start-cap row). An un-blended gray-LIFT map (reconstruction judged
against local ground, not a white threshold) shows the corridor interior
continuing under the sprite — gray paint is recoverable there, not just
white.

Consequence for the recovery (unwired): add a **corridor-terminus
constraint** — a recovered pad must sit on a corridor start (centerline
+ start cap, fit from the lift map). It pins the slide degeneracy with
render geometry instead of heuristics, and it would also kill the
rooftop/logo FPs, none of which have a corridor terminating at them.

### Badge recovery via dark plates: sprites were eating badges too

Review of the Lenard bend question surfaced that h5/h12 have no badges in
the pool at all — and the app view shows why: basket sprites sit directly
on those badges' white frames, so the frame component merges with the
sprite blob and the frame-keyed detector loses the badge ("baskets
cross-contaminating badge traversal"). The render-model fix
(`badge_plate_recovery.py`): detect the badge's DARK PLATE (near-black
rounded rect ~48×36, fill ≥0.55, with 4-40 % white digit-glyph pixels in
its interior) — a dark plate can never merge with anything white.

Dev result: **exactly 18 plates per course, all four courses, zero false
positives** — the frame detector's 66/72 becomes **72/72**. The six
misses were Heritage 2/12/13/15 (Heritage was silently missing FOUR
badges, not just Lenard's two) and Lenard 5/12; every recovered plate
sits on exactly one hole's tee→basket ray at fraction 0.18-0.52 within
7 px, so identities are unambiguous even before digit classification.
Also corrects the Lenard record: h5/h12 were never bend candidates —
they were badge-detection casualties; the whole course is straight
(all 16 badge-present holes collinear ≤0.8°, chord violations all
attributed to walking-path/basket-zone contamination, and h5/h12 chords
fully supported end to end). Unwired: swap the plate detector into the
badge stage of pair-matrix and re-run digit classification on the six
recovered plates; badge-backed coverage rises accordingly.

### Perfect recall wired end to end: 65/72 on the full dev set

Per direction ("start at perfect badge recall and work upwards"), all
three recovery layers are now wired into the measurement pipeline
(pair-matrix-v4):

1. **Badges**: dark-plate recovery in `runBadgeStage` — 18/18 labeled on
   every course (was 66/72), digits all correct after excluding
   large-component intrusions from plate-recovered glyph masks.
2. **Tees**: occluded-tee recoveries materialized as
   `resources/nuthing-p2/endpoints/recovered-tees.json` (full-raster
   coords, provenance + scores) and merged into the pool as tier
   'recovered'. Two collateral fixes were forced by measurement: the
   badge-box tee exclusion now spares ring-tier candidates outside the
   PLATE INTERIOR (recovering badge 15 had swept Heritage h15's real ring
   tee, 22 px from the badge center — only hollow digit glyphs need the
   exclusion), and recovered-tier tees carry a 0.7 assignment prior
   (swept 0.5/0.7/0.85/1.0: at 1.0 a recovered FP poached DashsTrack h6;
   at 0.5 Heritage's true recoveries lost their own holes; 0.7-0.85
   plateau). Truth-blind FP filtering of the recovered pool was attempted
   and failed honestly: the furniture veto misses the translucent map
   label, and corridor-field support fires on rooftops too — the tier
   prior is the correct mechanism, not pool censorship.
3. **Baskets**: recall was already 18/18 everywhere; pool FPs remain
   (e.g. a 0.48-score sprite lookalike on a Heritage rooftop, exposed
   when tee-less holes grabbed garbage) — with tees complete they are no
   longer selected; masked exact-match precision scoring stays available
   as a follow-up if validation courses disagree.

Endpoint recall is now 18/18 tees, baskets, and badges on all four dev
courses, every one of the 72 holes is judged, and assignment lands
**65/72 exact** (DashsTrack 18/18, TowneLake 18/18, Heritage 17/18 —
h5/h6/h10/h15 all newly correct, only the h7 theft remains — Lenard
12/18, its six wrongs the familiar north-cluster theft chains). The
prior full-pipeline number, 57/63, silently excluded the nine hardest
holes; 65/72 is the same exactness rate measured with nothing hidden.


### 72/72: the collinearity bonus and the cancelling S

Two directives closed the dev set.

**Lenard — "prefer the perfect tee→badge→basket line more."** The
invariants layer had the fraction and tee-orientation terms but never an
explicit collinearity term, and every Lenard true pair is a ≤0.8° perfect
line. Added as a BONUS, never a penalty (dogleg true pairs legitimately
put the badge off the chord): score ×= 1 + B·exp(−(collinDeg/σ)²).
Swept B×σ: at B=0.3–0.6, σ=2° all six Lenard wrongs flip at once with
zero regression (71/72); at B≥1 or σ=4 the bonus starts bribing dogleg
courses into fake straight lines and Heritage collapses. Defaults 0.6/2.

**Heritage h7 — the cancelling S.** Truth: tee→badge east, a 28 px
connector at −49° between bends (944,695)→(962,674), then east to the
basket — two bends that cancel to a near-straight chord. The field render
showed the router's badge→basket leg taking a parallel LOWER band of
equal length (detour in position, not length — which killed a
routed-length gate), sinking the true pair to rank 55. Two fixes, with
measured attribution:

- **Z-fit rescue (--zfit, flag-gated)**: score a drowned pair (routed
  worst < 0.28 — salvage-only; unconditional rescue measurably let the
  h4↔h12 false pairs shop for 2-bend bridges) by the best explicit
  ≤2-bend polyline through the badge, bend ≤60°, connector ≤3W, length
  ≤1.4× chord, per-bend Occam discount, sampled with the identical
  aligned/zone machinery. It FOUND the thin connecting segment — best
  fit bends at (949,696), jogs −60° for 24 px to (956,673), against
  truth's (944,695)→(962,674) — and scored the true pair 0.330 vs the
  straight rival's 0.150.
- **Frac band recentered to the measurement**: the badge-position prior
  was 0.45±0.15 while the measured range is 0.17–0.54 — h7's badge sits
  at 0.165 of its chord, and the asymmetric band taxed the true pair
  0.44×, which is what actually drowned it. Recentered to 0.36±0.19.

Ablation: the frac recentering ALONE reaches 72/72; the Z-fit found the
segment and is kept as a gated layer for validation courses where routes
detour without a mis-centered prior to blame.

**Final: ASSIGNED exact 72/72 — DashsTrack 18/18, HeritagePark 18/18,
Lenard 18/18, TowneLake 18/18 — with rank1 65/72, rank≤3 71/72, on
perfect endpoint recall.** Next honest test is the validation courses;
every constant above is documented with its sweep.

### Zone-stamp un-blend: end caps inside the circle

Generalization of the sprite un-blend (`zone_stamp_unblend.py`): the
ENTIRE basket zone — sprite glyph, C1S/C2D rings, C1F/C2F fills — is one
repeated render stamp, pixel-locked to the anchor. Stacking
anchor-centered 220×220 windows across a course's baskets (robust
median/MAD alpha) cancels the whole stamp at once. The un-blended LIFT
maps show the corridor running straight through the zone — terminal cap
included — in the region that has been the worst-measured part of every
corridor and the reason the backwalk had to scan from r=35 outward.

Bearing readout INSIDE the zone (mean lift in a W-wide band,
r ∈ [W/2+4, 60], furniture-masked — neighboring baskets' sprites, badges
and tees sit at varying offsets, are NOT cancelled by the stamp, and
dominated the readout until masked): 41 good / 20 catastrophic on the 69
reliable-truth baskets — statistical parity with the backwalk (41/22)
from a fully independent mechanism. Two of the backwalk's worst
failures read nearly clean here (Heritage h4: 168°→16°; Lenard h2:
174°→22°).

**The agreement gate is the real product.** When the two independent
instruments agree within 20° (31/72 baskets): 26 good, 3 catastrophic —
**84 % precision at 43 % coverage**, versus the backwalk's own
confidence/margin which was ANTI-correlated with correctness on the
target holes. When they disagree, both are coin flips — abstain. The
three catastrophic agreements are cluster cases where both instruments
lock onto the same real neighboring corridor: the locally-undecidable
set again. This is the first calibrated, soft, per-basket approach
signal fit for the pairing loop.