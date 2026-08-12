# Hole-path detection, fresh attempt: low-parameter centerline fit

Date: 2026-08-12. Probe: `hole_path_lowparam_fit.py`. Fixture:
`resources/ribbon-reference/IMG_5641-ribbon-golden.png` + the committed
tee/basket/badge ground truth and the holes-1..3 golden gutters. This is a
from-scratch approach, independent of the paused band-detection /
badge-anchored tracing probes — none of that code is used or modified.

## TL;DR

**Reframing the problem makes it work.** The paused thread established that
the fairway ribbon has no usable *edges* (no Canny response at any
threshold). But it has a robust *region* signal: the ribbon composites
translucent white, so ribbon pixels sit ~+9 to +13 LAB-L units above their
large-window local background (measured inside the golden gutters; the
surrounding ring sits at −5 to −7). Combined with the observation that
hole-path geometry is extremely low-complexity (a corridor edge is ~3
points, i.e. a centerline is tee → ≤2 bends → basket), per-hole detection
becomes a tiny optimization instead of a tracing problem:

> maximize trimmed-mean local-brightening evidence along a polyline with
> 0–2 interior control points, anchored at the known tee and basket.

Result on IMG_5641, all 18 holes, in **~2 seconds total**:

- every centerline visually rides its corridor (see
  `hole-path-results/overlay.png`), including the dense 4–7 cluster and the
  road-adjacent holes 15–16;
- holes 1–3 (the only golden-annotated ones): **94–95 % of fitted
  centerline points lie inside the hand-drawn gutter polygons**;
- bend-count selection is sane: doglegs (8, 18: straight-line score 0.30–0.38
  → fitted 0.98) get 1–2 bends, near-straight holes keep few;
- badge/icon occlusions are absorbed by the trimmed mean (top 80 % of
  samples) — no explicit occlusion modeling needed;
- a crude perpendicular-profile scan also yields a per-hole corridor
  half-width estimate (~5–20 px at 1/3 scale) for free.

## Method (all of it)

1. Downscale ×3, LAB lightness `L`, evidence `e = clip((L − boxmean(L,41)) / 12, 0, 1)`.
   The 41-px box (~120 px at full res) is wider than any corridor, so the
   ribbon reads as local brightening regardless of underlying terrain.
   Chroma is deliberately unused (unreliable here, and the committed raster
   has the golden annotation dots for holes 1–3 baked into it, which pollute
   chroma locally).
2. Score(polyline) = trimmed mean of `e` sampled every 2 px (drop lowest
   20 %) − 0.2 × excess-length ratio.
3. K=1: 7×15 coarse grid over the bend position, then 8→1 px hill-climb.
   K=2: split the longer segment of the K=1 solution, hill-climb both bends.
   Keep an extra bend only if it beats the simpler model by ≥ 0.025.

## Honest caveats

- Single fixture, and the *endpoints are ground truth*: the fit consumes
  tee/basket positions. That matches the intended pipeline (tee/basket/badge
  detection is separately solved, 18/18 on this fixture), but endpoint error
  will move the whole centerline; sensitivity untested.
- Only holes 1–3 have quantitative ground truth; the other 15 are assessed
  visually. Scores (trimmed-mean evidence 0.83–1.00) are a plausible
  confidence proxy but uncalibrated.
- 0–2 bends suffices on this course. A course with an S-curve fairway would
  need K=3; the same margin rule extends naturally, untested.
- Roads/parking lots produce ribbon-identical evidence (bright,
  desaturated). Anchoring at tee/basket plus the length penalty kept every
  hole on its corridor here — hole 16 runs parallel to a road and stays on
  the grass strip — but a hole whose straight line crosses a large bright
  area could still be seduced. More captures needed.
- The committed raster's baked-in golden dots slightly perturb evidence on
  holes 1–3 (magenta/cyan dots lower `e` at their pixels); the trimmed mean
  hides them. On a clean capture, results should only improve.

## Relationship to the paused work

This does not revive band/edge detection — it replaces it. If this is
productized, the pipeline is: detected tee + basket per hole → evidence map
(one box filter + LAB conversion) → this fit → `centerline: SourcePoint[]`
with ≤2 bends, exactly the product representation, plus a width estimate for
rendering. The natural next steps: run on a clean capture without baked-in
annotations, test endpoint-error sensitivity, and hand-draw golden gutters
for a few more holes (each edge ~3 points, so it's cheap) to turn the visual
assessment into numbers.
