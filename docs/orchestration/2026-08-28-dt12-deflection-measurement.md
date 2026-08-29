# DashsTrack H12 tee pad: occluded-left PCA deflection, measured from pixels

**Subject**: DashsTrack hole 12's tee pad, occluded on its left side by an
adjacent basket sprite (both left inner-rectangle corners are under the
sprite's black stroke).
**Source**: `/home/user/chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg`
via `./lab set DashsTrack && ./lab scope h12`.
**Owner's hypothesis under test**: with both left inner corners occluded, a
PCA fit on the visible (truncated) interior deflects ~11° off the pad's
true long axis, because the interior's apparent left boundary is the
sprite's edge, not the pad's.

## Frame (Minsky, per receipt-reconcile)

- **Looking for**: hole 12's tee pad interior and the basket sprite that
  occludes its left side.
- **It looks like**: a small rotated-rectangle gray fill (RGB ≈
  158,157,159, near-zero saturation) with a white outline stroke, ~26px
  long axis / ~18px short axis at this course's canonical zoom — under
  (behind, z-order) a white/black basket glyph per DashsTrack's known
  pad-under-basket z-order (`chainspot-cv-engrams`).
- **I know that because**: direct pixel sampling in the canonical raster
  (uniform ~158-gray interior distinct from the basket's pure white fill
  ~230+ and black stroke <40); DashsTrack's z-order is documented in the
  CV engrams.
- **It may be near**: badge 12 and the basket immediately southwest of it
  in canonical space — confirmed visually via `./lab scope h12`.

## Coordinate frames

Canonical raster: 1290×2083, `StripChrome` insets `top=4, right=0,
bottom=4, left=0`, single-source (no AutoStitch offset). To recover the
original raw-capture pixel from a canonical one: `orig_x = canon_x + 0`,
`orig_y = canon_y + 4`. All coordinates below are canonical.

Canonical raster used for pixel work: a `g0.canonical.png` from an
existing sweep run (`artifacts/orchestration/c3-before/DashsTrack-full/...`,
verified byte-identical size 1290×2083 to the `./lab scope` canonical) —
no new sweep was executed for this task.

## Measurements

Pad interior segmented as a single connected low-saturation gray blob
(261px at the primary threshold; a basket white/black glyph occludes its
left side, per the completeness-invariant "occluded by known occluder"
case).

Pad's own white-outline stroke gives three visible corners of the
rotated-rectangle pad: **T**=(421,1747), **R**=(430,1772),
**B**=(414,1780) canonical. The fourth corner is fully hidden under the
basket; reconstructed via the rectangle identity (opposite corners sum
equally): **L = T + B − R = (405,1755)**. Pad center = midpoint(T,B) =
**(417.5, 1763.5)**.

Badge 12's plate (fully unoccluded, ~55×42 white-outline signature) has
centroid **(375.0, 1639.5)**.

| # | Measurement | Method | Angle |
|---|---|---|---|
| 1 | **CONTROL** — visible right inner edge | TLS line fit to the rightmost interior pixel per row, y=73–93 (top-corner→right-corner edge, the pad's true long-axis side) | **71.50°** |
| 2 | **FALSE EDGE** — sprite-imposed cut | TLS line fit to the leftmost interior pixel per row, y=76–93 (where the basket's black stroke truncates the gray fill) | **71.52°** |
| 3 | **TRUNCATED-INTERIOR PCA** — as the detector would see it | PCA (largest-eigenvalue eigenvector) of all 261 interior pixel coordinates, left-bounded by the sprite | **73.59°** |
| — | Bearing, pad center → badge 12 center | atan2 on (375.0−417.5, 1639.5−1763.5) | **−108.92°** |

**Deflections / errors:**

- **PCA vs. CONTROL deflection: 2.09°** (robust to threshold choice —
  re-segmenting at three saturation cutoffs gave PCA angles of
  69.84°/73.59°/73.02°, i.e. a 1.5°–2.5° deflection band; CONTROL is
  unaffected by the same re-segmentation since it's fit on the pad's own
  intact outline, not the fill).
- **FALSE EDGE vs. CONTROL: 0.02°** — for this particular pad/basket pair,
  the sprite's occluding edge happens to run almost exactly parallel to
  the pad's true long axis. This is a coincidence of this basket's
  silhouette angle at this pad's rotation, not a general property.
- **CONTROL axis vs. bearing angular error: 0.42°** — the pad's true long
  axis points essentially straight at badge 12, confirming the
  badge-ray convention independently of any detector code.
- **PCA axis vs. bearing angular error: 2.51°** — small, and roughly
  5× smaller than the owner's ~11° prediction.

## Verdict

**The owner's ~11° PCA-deflection hypothesis is NOT reproduced from the
raw pixels of this specific pad.** The measured truncated-interior PCA
deflection is **~2°** (2.09° at the primary threshold, 1.5°–2.5° across a
threshold sensitivity sweep), not ~11°. The reason the deflection is so
small here: the false edge the basket imposes happens to be almost
colinear with the pad's own true edge (0.02° apart) at this hole's
basket/pad rotation, so truncating the interior on that side barely
perturbs the covariance-derived principal axis. This does not rule out
an ~11° deflection existing on some *other* occluded pad where the
sprite's cutting edge sits at a more oblique angle to the pad's long
axis — it specifically retracts the number for **this** hole (H12) as
measured from pixels, and flags that the deflection magnitude is
basket/pad-rotation-dependent rather than a fixed constant.

## Crops

- `artifacts/orchestration/dt12-deflection/dt12-pad-three-lines.png` —
  high-zoom pad crop with the three fitted lines (green = CONTROL right
  edge, blue = TRUNCATED-INTERIOR PCA, red = FALSE EDGE/sprite cut) and
  the numbers printed in the image, mirroring the owner's chat
  annotation style.
- `artifacts/orchestration/dt12-deflection/dt12-context-bearing.png` —
  wider crop showing the pad, the basket, badge 12, and the bearing line
  between the reconstructed pad center and the badge centroid.
- `artifacts/orchestration/dt12-deflection/dt12-measurement.json` — full
  numeric record (corners, both coordinate frames, all six angles, the
  sensitivity sweep, and methodology notes) backing every number above.

## Scope note

This is the from-pixels ground truth only. A sibling agent is separately
dumping the detector's own stored geometry for this same pad/hole; this
document does not attempt to reconcile against that — it stands on its
own as an independent pixel measurement.
