# Tee×basket evidence matrix — baseline (no suppression)

MiddleOut is a **known-endpoint route evaluator, not an endpoint-ownership
detector**. This deliverable stops pretending otherwise: no flood-ownership,
no geodesic-nearest, no greedy assignment, no firstIcon/gate heuristics.
Instead, for every badge on every dev course, **every (tee, basket) candidate
pair is routed** through one shared support field in the canonical middle-out
form `tee→badge→basket = reverse(badge→tee) + badge→basket[1:]` (badge as
interior waypoint only), and full PathEvidence per pair is preserved. The
ownership question is then answered by *ranking the evidence* — and this
report measures exactly where and why that fails, before any refinement.

Builder: `scripts/nuthing/pair-matrix.ts` → cache + overlays in
`/workspace/nuthing-work/pair-matrix/`.

## Fidelity to the known-good implementation

Studied from `experiment/vision-middleout-pathfinding` @ `34538e6`
(`scripts/cv-probes/middleout/middleout.py`, TS port
`src/lib/autoAnnotation/middleOutRibbon.ts`):

- Field: paired-edge support, scale 3, 12 orientations, widths 24..64 src px,
  99.5-pct normalize, γ0.7 (pure-TS port `src/lib/nuthing/ribbon.ts`).
- Cost: `1 + 4·(1−s)²` (`middleOutRibbon.buildSupportCost`).
- Route: 8-connected geometric Dijkstra (`route_through_array` semantics);
  endpoint waiver disk r=6 field px clamped to cost 1.4.
- **Documented deviation:** legs to all ~43 endpoints of a course share ONE
  full-field Dijkstra per badge (the badge is the source, waiver applied
  there), so the goal-side waiver is not applied. This shifts only the
  cost-based `totalScore` by a bounded goal-local glyph term; the support
  samples along the path — which the pair rankings are built from — are
  unaffected. Routing cost: ~60 ms/badge, ~1.1 s/course + ~2.5 s field.
- **No suppression of any kind** (no C2D, no walking-path, no sprite cap):
  the baseline's job is to measure those failure mechanisms cleanly.

## Endpoint refinement (detection hygiene, not routing suppression)

- **Baskets**: fixed 42×66 sprite family; endpoint = pole tip
  (`cy + bboxH/2 + 4` = `BASKET_SPRITE_TIP_OFFSET_PX` below the pole).
- **Tees**: widened tee-rect family — min dim ≥8, max dim ≤42, area 80..350,
  fill 0.20..0.85 — excluding badge boxes and badge digit glyphs only.
- **Finding: the C2D ring-furniture exclusion was destroying tee recall.**
  16 of 23 truth-tee misses under the previous filter were *real tees
  standing on a neighboring basket's dashed ring* (the next tee is routinely
  placed beside the previous basket). Ring-attributed candidates are now
  kept and tagged `onRing` for failure attribution instead of excluded.
- Recall against truth (bbox+10 px): **tees 68/72, baskets 68/72**.
  Remaining misses, all identified: Heritage tees h5/h10 (occlusion
  fragments, area ~50), h6 (3×7 px sliver under canopy), h15 (merged into a
  552-area blob); Heritage baskets h2/h12/h17 and Lenard basket h9
  (occluded/clipped sprites outside the rigid sprite family).

| course | tees (onRing) | baskets | labeled badges |
|---|---|---|---|
| DashsTrack | 25 (5) | 18 | 18 |
| HeritagePark | 42 (3) | 15 | 14 |
| Lenard | 57 (6) | 16 | 16 |
| TowneLake | 28 (7) | 18 | 18 |

## PathEvidence per pair (cached for replay)

Per pair: `totalScore` (accumulated route cost), `supportMean`,
`supportMin`, `supportedFraction` (τ=0.5), `worstWindowMean` (minimum mean
support over a ~45 src-px sliding window), `weakSpanCount`/
`weakSpanLongestPx`, `pathLengthPx`, `straightDistancePx`, `efficiency`,
`endpointSupportTee/Basket`, `failureReason`. Per badge: every leg's dense
path. Replay boundary: `<course>.json` (endpoints, legs, pairs, ranks,
judgments) + `<course>-field.bin` (f32 support) + `<course>-theta.bin`
(f32 best-orientation) — refinements re-score from these caches without
re-running detection or routing.

## Rank of the true pair (61 badge-backed truth holes)

Three scorings of the same evidence, rank-1 / rank≤3:

| course | n | worstWindow | supportMean | totalScore |
|---|---|---|---|---|
| DashsTrack | 18 | 4 / 6 | 0 / 1 | 8 / 12 |
| HeritagePark | 10 | 0 / 6 | 0 / 1 | 4 / 10 |
| Lenard | 15 | 1 / 1 | 0 / 0 | 4 / 6 |
| TowneLake | 18 | 3 / 7 | 1 / 1 | 10 / 16 |
| **total** | **61** | **8 / 20** | **1 / 3** | **26 / 44** |

True-pair support is real — supportMean 0.50–0.81, efficiency 1.01–1.17
(routes hug their ribbons; they are not wandering) — but it does not
*separate*.

## Failure structure (the point of the exercise)

Of the 53 holes where the true pair is not rank 1:

- **46 strongest false competitors are two REAL truth endpoints of
  different holes** — junk components are not the problem;
- **46 involve an endpoint owned by an adjacent hole (±2)**;
- **37 keep one true endpoint and swap only the other side**.

Mechanism, verified in the failure overlays
(`<course>-h<N>-fail.png`, true pair green vs strongest false red):
false routes ride *real* rendered support the whole way — a neighboring
parallel ribbon, or the overlapping C2D-ring/C2F-fill carpet that nearly
tiles compact courses (DashsTrack h5: the false route drops from the badge
into the adjacent basket entirely through overlapping basket zones). The
true route, meanwhile, must cross its own hole's genuine weak stretch (tree
occlusion, road crossing), so any weakest-link scoring ranks the short
false hop above it. Max-packing strips, not circles: what the false routes
lack is not support — it is *staying on one strip*. A route that hops
between adjacent ribbons moves transverse to the local `bestTheta`
orientation while support stays high; a route that follows its ribbon moves
parallel to it. That orientation-coherence signal is cached precisely so
the first replay refinement can score it.

`totalScore` looks best in the table only because path length penalizes
long false detours — it is still geodesic cheapness, fails 17/61 outright,
and is explicitly not the notion of pair evidence this architecture is
built on.

## Replay refinement 1 — strip-coherence (RESULT)

`scripts/nuthing/pair-matrix-replay.ts`: re-scores every cached pair with
orientation-aligned support samples `s'_i = s_i·|cos(dir_i − bestTheta_i)|²`
and ranks by the aligned worst ~90 src-px window. Pure replay: no
re-detection, no re-routing — inputs are the cached legs + the two cached
planes.

| course | n | baseline worstWindow r1/r≤3 | aligned r1/r≤3 |
|---|---|---|---|
| DashsTrack | 18 | 4 / 6 | 9 / 14 |
| HeritagePark | 10 | 0 / 6 | 5 / 6 |
| Lenard | 15 | 1 / 1 | 4 / 8 |
| TowneLake | 18 | 3 / 7 | 11 / 17 |
| **total** | **61** | **8 / 20** | **29 / 45** |

One re-scoring, no new detection: rank-1 ×3.6, rank≤3 ×2.25 — confirming
the diagnosed mechanism (false pairs ride *transversely between* strips;
true pairs travel *along* one). Sweeps: p∈{1,2,4} × window∈{30..120} all
land 24–30 / 36–45; p=2/window=90 chosen; multiplying in the unaligned
worst window ("combo") does not beat aligned alone.

Residual failures cluster on Lenard (residential clutter contributes 57 tee
candidates — false tees on sidewalk/roof furniture that sit on genuinely
oriented linear structures) and on specific holes whose true ribbon has a
long weak stretch (Dashs h6/h13/h14, Lenard h3/h10, TowneLake h3). Those
are the targets for the remaining replay layers.

## Replay refinement 2 — basket-zone attribution (RESULT)

`--zones`: support attributable to a FOREIGN basket's own furniture is
discounted (×0.4) before the aligned scoring — sprite silhouette within
35 src px of a sprite center unconditionally; C2D (84±12) and C1S (44±8)
ring bands only where the local `bestTheta` runs tangentially to that ring
(a ribbon genuinely crossing a ring is radial there and keeps its support).
The pair's own endpoint basket is exempt — its zone is the leg's legitimate
terminal approach. Ring *riding* is tangential, i.e. aligned, which is
exactly why strip-coherence alone could not catch it.

| course | n | aligned r1/r≤3 | + zones r1/r≤3 |
|---|---|---|---|
| DashsTrack | 18 | 9 / 14 | 9 / 16 |
| HeritagePark | 10 | 5 / 6 | 7 / 9 |
| Lenard | 15 | 4 / 8 | 5 / 8 |
| TowneLake | 18 | 11 / 17 | 14 / 17 |
| **total** | **61** | **29 / 45** | **35 / 50** |

Cumulative: baseline 8/20 → +strip-coherence 29/45 → +zone attribution
**35/50** of 61, all as replays over the same cached matrix.

Residual failures (11), visually attributed via `-h<N>-replay-fail.png`:
the dominant remaining mechanism is the **walking path**: false routes ride
a dashed walking path to a rotated-diamond path marker that passes the tee
family (Dashs h6→T9, Lenard h17→T45, Lenard h10→T2 …) — unowned false
"tees" reached along real oriented linear render structure. Three more are
rank-4 near-misses (Lenard h11/h13/h16); Dashs h14 and TowneLake h3 have
true ribbons with long genuinely-weak stretches (true aligned ww ≤ 0.16).

## Remaining replay layers (in evidence order)

1. **Walking-path-aware**: dashed walking paths and their diamond markers
   as attributed distractors (linear, oriented — invisible to
   strip-coherence, outside basket zones).
2. **Sequence-aware and global assignment**: only after per-pair evidence
   is as honest as it can be, as replays over the cached matrix.
