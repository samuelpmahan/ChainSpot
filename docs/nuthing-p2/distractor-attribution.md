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
