# AlexClark Sol blind pass v1

## Measurement boundary

- Canonical frame: the 1290 x 2082 production-auto-cropped raster; origin at its top-left, +x right, +y down.
- Inputs viewed: `AlexClark-cropped.png` and `AlexClark-cropped-grid.png`, plus lossless subcrops of those two images for zoom only.
- Refused inputs: recorded in `sol-blind-v1-seal.md` before the first Alex visual inspection.
- No Alex truth, registered annotation, detector output, CV cache, prior evaluation, or Lab evidence object was opened or executed.
- `sol-blind-v1.annotation.json` uses normal optional `tee`/`basket` fields. Missing tees are intentional information limits, not zeroes.

## A. Badge observations

Badge coordinate means the visual center of the black number badge, measured from the grid. It is a renderer observation, not stored hole truth.

| Hole | Best center (px) | Uncertainty | Visual evidence / difficulty |
|---:|---:|---:|---|
| 1 | (696, 1450) | +/-4 | Crisp isolated badge. |
| 2 | (559, 1347) | +/-4 | Crisp; overlaps H7 corridor furniture slightly. |
| 3 | (326, 1877) | +/-4 | Crisp over trees. |
| 4 | (492, 2001) | +/-5 | Near lower crop edge but fully visible. |
| 5 | (621, 1925) | +/-4 | Crisp; close to basket furniture. |
| 6 | (578, 1765) | +/-4 | Crisp over faint diagonal ribbon. |
| 7 | (484, 1283) | +/-4 | Crisp; upper endpoint cluster overlaps H18. |
| 8 | (490, 714) | +/-4 | Crisp. |
| 9 | (390, 509) | +/-5 | Badge is clear; endpoint ownership is not. |
| 10 | (413, 435) | +/-4 | Crisp. |
| 11 | (496, 386) | +/-4 | Crisp. |
| 12 | (536, 158) | +/-4 | Crisp on pale ribbon. |
| 13 | (821, 104) | +/-4 | Crisp; H13/H14 ribbons overlap. |
| 14 | (824, 199) | +/-4 | Crisp; H13/H14 ribbons overlap. |
| 15 | (685, 226) | +/-4 | Crisp. |
| 16 | (648, 573) | +/-5 | Crisp but displaced from the crowded endpoint cluster. |
| 17 | (578, 711) | +/-4 | Crisp. |
| 18 | (548, 1041) | +/-5 | Crisp; two basket sprites overlap below it. |

Result: 18/18 badge centers visually confident.

## B. Basket observations

Coordinates target the pole tip: the fixed sprite centerline at the bottom of the pole, not the sprite center or translucent C1 circle center.

| Hole | Best pole tip (px) | Uncertainty | Visual evidence / difficulty |
|---:|---:|---:|---|
| 1 | (770, 1337) | +/-6 | Sprite isolated; ribbon ownership plausible. |
| 2 | (493, 1391) | +/-6 | Sprite isolated; aligned with H2 badge and tee candidate. |
| 3 | (295, 2047) | +/-6 | Sprite visible near lower-left edge. |
| 4 | (607, 1965) | +/-7 | Crisp sprite; H4/H5 corridors overlap. |
| 5 | (760, 1905) | +/-6 | Crisp isolated sprite. |
| 6 | (429, 1566) | +/-7 | Sprite clear; long faint corridor makes ownership less direct. |
| 7 | (513, 1148) | +/-10 | Two adjacent sprites; assigned by tee-badge direction. |
| 8 | (485, 864) | +/-7 | Sprite clear. |
| 9 | (353, 389) | +/-9 | Tee-axis refinement makes tee, badge, and pole tip collinear. |
| 10 | (437, 558) | +/-9 | Tee-axis refinement makes tee, badge, and pole tip collinear. |
| 11 | (457, 277) | +/-9 | Tee-axis refinement makes tee, badge, and pole tip collinear. |
| 12 | (607, 93) | +/-8 | Sprite clear; diagonal ribbon supports assignment. |
| 13 | (1015, 299) | +/-24 | Sprite clear, ownership weak: H13/H14 pale rails cross. |
| 14 | (751, 103) | +/-12 | Sprite clear; tee-to-badge direction supports assignment. |
| 15 | (669, 340) | +/-18 | Sprite clear; nearby H12-H16 ribbons make ownership ambiguous. |
| 16 | (523, 578) | +/-20 | Sprite clear; crowded H9-H17 cluster. |
| 17 | (864, 768) | +/-16 | Isolated sprite but faint connecting rails. |
| 18 | (578, 1180) | +/-12 | One of two overlapping sprites; ownership inferred from local direction. |

Result: 15/18 basket identities confident enough for roughly <=10 px localization; 3 ownership-uncertain. All 18 sprite instances themselves are visible.

## C. Tee observations

The target is the center of the elongated hollow tee glyph. A square/diamond C1/C2 marker is not automatically a tee.

| Hole | Best estimate (px) | Uncertainty | Stored? | Visual evidence / difficulty |
|---:|---:|---:|:---:|---|
| 1 | (615, 1587) | +/-8 | yes | Elongated glyph; major axis points toward badge. |
| 2 | (633, 1238) | +/-10 | yes | Rotated glyph on the H2 line; some diamond ambiguity. |
| 3 | (364, 1724) | +/-8 | yes | Isolated elongated glyph, aligned toward badge. |
| 4 | (369, 2078) | +/-9 | yes | Near lower crop edge but center visible. |
| 5 | (472, 1881) | +/-8 | yes | Isolated horizontal glyph aligned toward badge. |
| 6 | (674, 1840) | +/-10 | yes | Rotated glyph; faint rail supports ownership. |
| 7 | (454, 1403) | +/-8 | yes | Isolated elongated glyph aligned toward badge. |
| 8 | (500, 570) | +/-90 | no | No separable elongated glyph; likely hidden in the H9-H16 basket/C2 cluster. |
| 9 | (430, 654) | +/-10 | yes | Elongated axis points toward H9; badge and H9 pole tip extend the same line. |
| 10 | (383, 302) | +/-10 | yes | Elongated axis points toward H10; badge and H10 pole tip extend the same line. |
| 11 | (541, 517) | +/-12 | yes | Partly basket-occluded, but the hollow rectangle's long axis and the badge-pole line agree. |
| 12 | (604, 437) | +/-12 | no | Elongated axis points toward H12. Tee identity is defensible, but the route is visibly non-collinear and no bend point is defensible. |
| 13 | (734, 69) | +/-35 | no | Zoom shows no independent tee here; this was the H15 glyph/basket overlap seen twice. |
| 14 | (909, 306) | +/-10 | yes | Isolated rotated rectangle; axis points toward H14 badge. |
| 15 | (705, 109) | +/-12 | yes | Elongated glyph; blind overlay confirms a straight line through the H15 badge to the pole tip. |
| 16 | (620, 500) | +/-90 | no | No unused elongated glyph separates from H12 and H11 furniture. |
| 17 | (675, 694) | not a tee | no | Nearest-neighbor zoom shows a square diamond: C1/C2 furniture, not the elongated tee family. |
| 18 | (513, 1016) | +/-10 | yes | Isolated glyph immediately above the overlapping endpoint cluster. |

Result: 13/18 stored complete tee identities; H12 has a defensible tee observation but remains unstored because bend classification is unresolved; H8, H13, H16, and H17 have no defensible tee assignment.

## D-E. Straight/bent classification and bends

For holes 1-7, 9-11, 14, 15, and 18, the visible rails support a straight centerline at the resolution available. These thirteen are stored with zero bends.

No bend point met the same standard. H12 has a now-identified tee at approximately (604, 437), but tee, badge, and basket are non-collinear and the faint rails do not localize a unique direction change. H13 has another bent hypothesis near (860, 145), but the H13/H14 rails overlap and the endpoint ownership is uncertain. H8, H12, H13, H16, and H17 remain incomplete instead of receiving decorative bends.

Result: 13 straight classifications, 0 confident bent classifications, 5 unclassified; 0 bend coordinates frozen.

## F. Corridor width

The DashsTrack truth says 40 px and its visible rail-to-rail span reproduces that value. On AlexClark, isolated segments look approximately 36-46 px wide. I froze 40 px for every hole with an estimated uncertainty of +/-8 px. This is a visual width measurement informed by a known renderer constant, not an independent per-hole fit.

## Natural visual evidence used

- Hollow glyph elongation and principal direction for tees.
- Basket pole termination rather than the large translucent circle.
- Badge center as a route anchor cue, but not as a bend by definition.
- Parallel faint rails and the pale filled ribbon between them.
- Rounded/semicircular ribbon terminations near endpoints.
- Continuity through terrain changes; tree texture often destroys one rail before the other.
- Conflicts where another hole's C1/C2 ring, dashed furniture, basket sprite, or badge occupies the same pixels.

## Information limit

The dominant failure was not coordinate reading. The 200 px grid made isolated centers easy to estimate. The failure was ownership: several crisp renderer objects remain visible, but overlapping translucent corridors and C1/C2 furniture do not provide enough independent evidence to assign them to a hole without importing detector or truth knowledge.
