# Tee-detection overfitting harness

`npm run overfit:tees -- <bundle.chainspot.zip> --out <dir> [--baskets <bundle>]`

A metric-discovery tool for one specific labeled course: given tee truth
(`holes[].tee`) and optionally basket truth (`holes[].basket`), it computes a
battery of per-patch metrics on the truth tees vs dense local distractors and
hard negatives, reports each metric's discrimination (AUC, per-hole local
rank), greedy-searches a weighted combination, and verifies it. The scorer it
emits (`tuned-scorer.json`) is deliberately overfit — one image, no holdout.

## Result on the golden fixture

```
npm run overfit:tees -- resources/GoldenTeeSet.chainspot.zip \
  --baskets resources/GoldenBasketSet.chainspot.zip --out out/overfit
```

- Baseline fused detector: 17/18, tee 5 missed (no candidate within
  tolerance anywhere in the fused/occluded pool — re-ranking cannot fix it).
- `gap-fill` verification (default): baseline keeps its 17 holes; the tuned
  scorer slides a local window anchored on the missed hole's NUMBER BADGE
  (truth is used only for evaluation), and candidate peaks are validated by
  the badge-ray invariant below. **Auto-detects tee 5 at 4.4px from truth →
  18/18.** Stable across sampling seeds.

## The badge-ray invariant

A valid tee pad AIMS at its own number badge: the rays along both long
sides, and the ray perpendicular to the front (short) edge, all intersect
the badge. The harness checks it by fitting the pad's dominant rim line
(RANSAC over clean-bright, off-structure, non-black pixels — blob PCA fails
when the ring band bisects the rim, but the longest collinear fragment IS a
long-side ray) and requiring the center ray plus both long-side offsets to
pass within the badge disc, badge ahead of the front edge. Note tee 5 sits
40.5 UI multiples from badge 5 — just past the production 40-multiple
gap-fallback radius — so the badge-anchored search uses 45.

Measured with `npm run validate:badge-invariant` (computer-fitted axes, not
truth-derived): the invariant holds on **18/18** truth tees. Mean
axis-to-badge-bearing delta is 2.2°, max 5.8° (tee 14); the worst ray
offset across all 18 pads is 9.5px against the 25px badge disc, so the
margin holds everywhere. On specificity, 14/18 pads pass only their own
badge; 4 pads (tees 3, 4, 9, 18) also pass exactly one farther badge, and
those are disambiguated by taking the nearest passing badge. Only tee 2 has
a basket sitting on its pad→badge corridor (3px clearance), so the test is
kept as pure ray geometry against the badge disc — no first-object-hit ray
marching against baskets or other occluders.

Two fit lessons fell out of getting this to 18/18:

- **Dash filtering must be component-level, not per-pixel.** Deleting every
  pixel inside the dashed-ring structure band deletes real rail pixels too
  when a ring happens to run tangent to the pad (tee 14). Instead, a dash is
  identified as a connected bright component whose span is ≤25px AND whose
  pixels are ≥50% inside the structure band, and only components meeting
  that test are dropped — rails that merely clip the band survive.
- **Black-adjacency must stay per-pixel.** Pads sitting over dark canopy
  touch near-black pixels along their rim (tees 1, 3, 11, 12); suppressing
  by component would throw those rims out entirely, so black-adjacency
  (and the ≥60% black-adjacent "glyph-like" rejection) is applied pixel by
  pixel when collecting rim points.

## Why hole 5 is hard, and what actually separates it

Hole 5's pad is bisected by **basket 6's** C2 putting circle (radius ≈87px,
course-wide; there is a second ring family ≈40px), and its interior color
(S 15–18, V 171–172) sits outside the production gray-center window
(S≤18, V 148–168) because the semi-transparent fill picks up the basemap
tile — which is exactly why `gray-center` cannot see it.

The discovered metric, `padEvidenceScore` (AUC 0.995, rank 1 of ~296 local
windows on 16/18 holes including hole 5), is a conjunction:

```
padEvidenceScore = softGrayFraction * offStructureCleanBrightDensity
```

- `softGrayFraction`: widened interior window (S≤25, V 145–180).
- `offStructureCleanBrightDensity`: bright rim-like pixels that are (a) NOT
  within 6px of a known dash structure — dashed rings fitted around every
  basket from the dash-blob population, plus dashed connectors basket N →
  tee N+1 — and (b) NOT within 3px of near-black pixels (which identifies
  black-outlined basket glyphs and number badges).

Each factor kills a different confuser class: gray paths have no rim, dashes
are on-structure, glyphs/badges are black-adjacent. Only a pad keeps both
factors non-zero. The full tuned scorer adds `softGrayFraction`,
`edgeDensity` and `-satIqr` refinements on top.

## Integration path (not yet wired)

`tuned-scorer.json` + the structure fit are designed to slot into
`detectCalibratedTeeGapFallbackCandidates` (`cvCalibratedDetectors.ts`): for
a badge with no confident tee, slide the scorer in the fallback radius and
accept the peak. Basket positions come from the existing 18/18 basket
detector; ring radii are fitted from dash blobs at runtime. Guard any wiring
with a new 18/18 assertion in `verify:cv` rather than loosening the current
one. `railCapScore` (parallel rails + perpendicular cap) measured AUC 0.74 at
this patch scale — supportive but not sufficient alone as an auto-approve
gate; `padEvidenceScore` is the stronger candidate for that.
