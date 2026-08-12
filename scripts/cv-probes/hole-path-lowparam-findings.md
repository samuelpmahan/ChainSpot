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

## Anchor/mask experiments (`hole_path_anchor_experiments.py`)

Domain fact supplied by the course author: **each hole's first corridor
segment is a straight line from teepad center to its number badge center**
(the badge sits on the path), and multiple bends are uncommon but not rare
(hole 18 here is a real multi-bend hole). Three arms against the baseline,
all with the bend budget raised to K≤3 (full table in
`hole-path-results/experiments.json`, 4-panel sheet in
`experiments-contact-sheet.png`):

| arm | golden containment h1/h2/h3 | notes |
|---|---|---|
| baseline (K≤3) | 95.2 / 94.1 / 95.3 % | as committed probe |
| anchor (tee→badge fixed) | 95.2 / 94.1 / 95.6 % | scores dip mechanically (dark badge px lie on the anchored segment) |
| mask (badge boxes excluded from scoring) | 95.2 / 94.1 / 88.6 % | scores rise mechanically; h3 line still visually on-ribbon, it just skims outside the golden polygon near the tee |
| mask+anchor | 95.2 / 94.2 / 90.9 % | **preferred** |

Findings:

- Raw scores are not comparable across arms (masking removes low-evidence
  badge pixels from the mean; anchoring adds them). Geometry is the
  comparison that matters, and all four arms stay on-corridor for all 18
  holes.
- **The anchor fixes hole 18 structurally.** Unanchored, hole 18's true
  second bend gains only ~0.005–0.011 score — below any reasonable
  bend-acceptance margin — so K=1 wins and the tee-end geometry is slightly
  wrong. With the anchor, the badge *is* the first bend (tee → badge →
  corridor bend → basket) and the fit matches the visible corridor exactly.
  That is the general lesson: the tee→badge segment supplies a bend as prior
  knowledge instead of asking weak evidence to pay for it.
- Masking lets bend selection simplify honestly (hole 12 drops from 2 bends
  to straight with no visual change) and removes the badge-occlusion noise
  the trimmed mean previously had to absorb.
- **Recommendation: mask+anchor.** It consumes only primitives the static
  parser already detects 18/18 (tee, badge, basket), encodes a true layout
  invariant, and needs the trimmed mean less. The remaining bend budget
  after the badge can stay at ≤2 on this course.

## Why straight holes grew spurious bends (and the fix)

Course truth from the author: holes 3, 9–13, 16, 17 are perfectly straight
(same corridor width as 1–3), yet the mask+anchor fit gave most of them 1–3
bends. Diagnosis (see `hole-path-results/diag-straight-holes-*.png`):

- **The bends are micro-adjustments, not route errors** — typically 10–20 px
  lateral, gaining 0.03–0.23 score. Two mechanisms:
  1. **Off-ridge anchors.** The badge center and basket point lie on the
     corridor but a few px off its *brightness ridge*; the corridor band is
     narrow, so a straight chord rides the band's edge and a small bend
     recenters it (hole 11 is the clean example: the badge sits low on the
     corridor, the chord hugs the bottom edge, the fit bends up).
  2. **Terrain-dependent evidence.** Over dark scrub the translucent
     ribbon's absolute brightening is smaller, so `clip(dL/12)` leaves the
     true corridor at 0.4–0.6 and a detour toward brighter pixels can
     outscore it.
- **Fix: flatten the evidence so band-interior position stops mattering.**
  Saturating at `clip(dL/4)` makes every on-corridor pixel ≈ 1 regardless of
  underlying terrain or ridge offset; recentering then gains almost nothing,
  and raising the bend margin to 0.05 rejects the residual micro-gains
  (largest observed: 0.046 on hole 10). Run via
  `hole_path_anchor_experiments.py --final`.
- **Result:** all eight known-straight holes fit with 0 bends; the
  unambiguous doglegs keep exactly one post-badge bend each with huge,
  clearly-real gains (hole 18: 0.48→0.99, hole 8: 0.76→1.00, hole 5:
  0.94→1.00).
- **Known cost: shallow sags below ~25 px are no longer detected.** Hole 1's
  gentle mid-corridor dip gains only 0.029 — inside the same range as the
  spurious micro-bends (up to 0.046), and their lateral deviations overlap
  too (~10–20 px fake vs ~25 px real), so no margin or deviation gate
  separates them on this fixture; band-tolerant (dilated-evidence) scoring
  was also tried and has the same blind spot. Hole 1 therefore fits straight
  and its golden containment drops to 70 % (2 and 3 stay at 94–95 %).
  Under-bending is the chosen failure mode: a straight proposal through the
  corridor is easy to nudge in review, while spurious bends on straight
  holes were the more common and more misleading error.

## Relationship to the paused work

This does not revive band/edge detection — it replaces it. If this is
productized, the pipeline is: detected tee + basket per hole → evidence map
(one box filter + LAB conversion) → this fit → `centerline: SourcePoint[]`
with ≤2 bends, exactly the product representation, plus a width estimate for
rendering. The natural next steps: run on a clean capture without baked-in
annotations, test endpoint-error sensitivity, and hand-draw golden gutters
for a few more holes (each edge ~3 points, so it's cheap) to turn the visual
assessment into numbers.
