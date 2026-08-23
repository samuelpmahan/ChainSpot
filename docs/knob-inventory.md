# Knob inventory — phase 1 output (two parallel sweeps, merged)

Raw tables from the read-only inventory pass over all threeFactor source.
Companion to `knob-extraction-checklist.md` (which defines the extraction
recipe). Apply the MERGE NOTES below — they override the raw cluster tags.

## Merge notes (reviewer corrections — authoritative)

1. **Re-home to the use site's cluster**: scoring.ts zone/ring constants
   (35, 84, 12, 44, 8, 0.5 at scoring.ts:55-59) were tagged `g3.endpoints`
   but live in G4 scoring code → they belong to `g4.scoring`. Same for
   assignment.ts:26/37 (bbox 6/12, ring 84/12) → `g4.search`.
2. **Cross-file shared values become ONE knob**: ring geometry 84/12
   appears at assignment.ts:37, scoring.ts:56, and measure.ts:298; the
   fallback tee bbox 6/12 at assignment.ts:26 and measure.ts:279-280.
   First extracting cluster (`g4.scoring`) owns them; later clusters
   consume the same feature's knobs. Do NOT create duplicate knobs.
3. **Demote to not-tunable**: HSV_SHIFT 12 (raster.ts:38, bit-shift
   precision), elongation eigenvalue floor 1e-6 (endpoints.ts:408),
   IMPROVEMENT_EPSILON 1e-9 (assignment.ts:19) — numerical guards, not
   experiment dimensions. Leave them as literals.
4. **BADGE_SIZE_TOL**: the knob is `1.15`; keep `Math.log(...)` at the use
   site so the config value stays human-readable.
5. **zfit constants** (assignment.ts ZFIT_TOP_K/0.28, scoring.ts zfit
   block :178-204): ZFIT_TOP_K and alignedWorstCeiling already live on the
   existing `g5.zfit` feature — do not re-extract. The scoring.ts zfit
   internals (stride 8, chord 0.85, max 220, bend angles array, bend
   multipliers) join `g5.zfit` as NEW knobs on that existing feature.
6. **st.straightTest**: no constants exist yet (gate not implemented in
   threeFactor) — skip the cluster.
7. **Extraction order** (revised to respect note 2): `g4.scoring` →
   `g4.search` → `g5.zfit` (add knobs) → `g5.ribbon` → `g5.routing` →
   `g3.endpoints` → `g3.screenChrome` → `g2.sprite` → `g1.badges` →
   `g1.digits` → `shared.hsv`.

## Sweep A — measure side

| constant/literal | value | file:line (use site) | what it does | proposed cluster |
|---|---|---|---|---|
| DEFAULT_WIDTHS_SRC | [24, 32, 40, 48, 56, 64] | measure.ts:62 | Width scales for tee-to-tee leg routing | g5.routing |
| DEFAULT_CORRIDOR_WIDTH | 37 | measure.ts:63 | Corridor width in pixels for leg search | g5.routing |
| DEFAULT_FIELD_SCALE | 3 | measure.ts:64 | Support field downsampling scale factor | g5.ribbon |
| DEFAULT_ORIENTATIONS | 12 | measure.ts:65 | Number of angle orientations for routing | g5.routing |
| DEFAULT_ALIGNMENT_POWER | 2 | measure.ts:66 | Alignment weighting power for routing | g5.routing |
| DEFAULT_WORST_WINDOW | 90 | measure.ts:67 | Worst-case search window size in pixels | g5.routing |
| DEFAULT_SUPPORT_TAU | 0.5 | measure.ts:68 | Support field gradient percentile threshold | g5.ribbon |
| badge-inside padding | 3 | measure.ts:233 | Badge bounding box expansion for tee exclusion test | g1.badges |
| basket sprite width | 42 | measure.ts:214 | Basket sprite template width | g2.sprite |
| basket sprite height | 66 | measure.ts:214 | Basket sprite template height | g2.sprite |
| tee fallback bbox offset | 6 | measure.ts:279 | Fallback tee bbox half-size when no ring/component geometry | g4.scoring (shared, note 2) |
| tee fallback bbox size | 12 | measure.ts:280 | Fallback tee bbox dimension (12×12) when no ring/component | g4.scoring (shared, note 2) |
| basket-tee ring distance | 84 | measure.ts:298 | Distance from basket center to tee ring (onRing detection) | g4.scoring (shared, note 2) |
| basket-tee distance tolerance | 12 | measure.ts:298 | Tolerance for basket-to-tee distance check | g4.scoring (shared, note 2) |
| BADGE_ASPECT_MIN | 1.15 | badgeStage.ts:18 | Minimum aspect ratio for bright badge candidates | g1.badges |
| BADGE_ASPECT_MAX | 1.8 | badgeStage.ts:19 | Maximum aspect ratio for bright badge candidates | g1.badges |
| BADGE_DARK_INTERIOR_MIN | 0.45 | badgeStage.ts:20 | Minimum dark pixel fraction for badge interior | g1.badges |
| BADGE_SIZE_TOL | 1.15 (log at use site, note 4) | badgeStage.ts:21 | Size tolerance in log space for badge family clustering | g1.badges |
| dark-plate min width | 34 | badgeStage.ts:75 | Minimum width for dark-plate badge recovery candidates | g1.badges |
| dark-plate max width | 78 | badgeStage.ts:76 | Maximum width for dark-plate badge recovery candidates | g1.badges |
| dark-plate min height | 24 | badgeStage.ts:77 | Minimum height for dark-plate badge recovery candidates | g1.badges |
| dark-plate max height | 54 | badgeStage.ts:78 | Maximum height for dark-plate badge recovery candidates | g1.badges |
| dark-plate aspect min | 1 | badgeStage.ts:82 | Minimum aspect ratio for dark-plate candidates | g1.badges |
| dark-plate aspect max | 2.4 | badgeStage.ts:82 | Maximum aspect ratio for dark-plate candidates | g1.badges |
| dark-plate fill min | 0.55 | badgeStage.ts:83 | Minimum fill fraction (area/bbox) for dark-plate candidates | g1.badges |
| dark-plate interior margin | 4 | badgeStage.ts:86 | Pixel margin for interior glyph fraction measurement | g1.badges |
| dark-plate glyph fraction min | 0.04 | badgeStage.ts:94 | Minimum bright pixel fraction in plate interior | g1.badges |
| dark-plate glyph fraction max | 0.4 | badgeStage.ts:94 | Maximum bright pixel fraction in plate interior | g1.badges |
| dark-plate proximity threshold | 22 | badgeStage.ts:95 | Distance threshold: dark-plate must not be near bright badges | g1.badges |
| dark-plate bbox margin | 4 | badgeStage.ts:96 | Margin for expanding dark-plate badge bounding box | g1.badges |
| SPRITE_COARSE_STRIDE | 3 | endpoints.ts:100 | Stride for coarse sprite matching pass | g2.sprite |
| SPRITE_COARSE_THRESHOLD | 0.18 | endpoints.ts:101 | Score threshold for coarse sprite matching peaks | g2.sprite |
| DEFAULT_SPRITE_SCORE_MIN | 0.28 | endpoints.ts:102 | Minimum score for sprite match acceptance | g2.sprite |
| BASKET_TIP_OFFSET | 4 | endpoints.ts:103 | Offset from basket center to tip annotation point | g2.sprite |
| sprite gate y offset | 10 | endpoints.ts:157 | Y offset to sprite top for coarse gate check | g2.sprite |
| sprite gate x offset | 4 | endpoints.ts:158 | X offset (±) for sprite coarse gate check | g2.sprite |
| HOLE_AREA_MIN | 10 | endpoints.ts:245 | Minimum enclosed dark hole area for tee detection | g3.endpoints |
| HOLE_AREA_MAX | 480 | endpoints.ts:246 | Maximum enclosed dark hole area for tee detection | g3.endpoints |
| HOLE_DIM_MAX | 44 | endpoints.ts:247 | Maximum hole dimension (width or height) | g3.endpoints |
| RING_BAND | 3 | endpoints.ts:248 | Ring band width for bright fraction measurement around hole | g3.endpoints |
| RING_FRAC_MIN | 0.6 | endpoints.ts:249 | Minimum bright fraction in enclosing ring band | g3.endpoints |
| tee ring detection radii | [0, 1, 2, 3] | endpoints.ts:268 | Dilation radii for multi-scale hole detection passes | g3.endpoints |
| tee area min (large radii) | 40 | endpoints.ts:273 | Minimum hole area required for larger dilation radii | g3.endpoints |
| tee ring merge proximity | 10 | endpoints.ts:275 | Distance threshold for merging rings from different scales | g3.endpoints |
| tee elongation threshold | 1.18 | endpoints.ts:468 | Elongation ratio threshold for tee-rect vs diamond classification | g3.endpoints |
| tee component min dimension | 8 | endpoints.ts:519 | Minimum component width or height for tee candidates | g3.endpoints |
| tee component max dimension | 42 | endpoints.ts:519 | Maximum component width or height for tee candidates | g3.endpoints |
| tee component min area | 80 | endpoints.ts:520 | Minimum component area for tee candidates | g3.endpoints |
| tee component max area | 350 | endpoints.ts:520 | Maximum component area for tee candidates | g3.endpoints |
| tee component min fill | 0.2 | endpoints.ts:521 | Minimum component fill (area/bbox) for tee candidates | g3.endpoints |
| tee component max fill | 0.85 | endpoints.ts:521 | Maximum component fill (area/bbox) for tee candidates | g3.endpoints |
| tee-ring dedup distance | 12 | endpoints.ts:522 | Distance threshold for excluding component-tee near ring-tee | g3.endpoints |
| tee-sprite exclusion distance | 24 | endpoints.ts:523 | Distance threshold for excluding tees near basket sprite centers | g3.endpoints |
| MIN_BOTTOM_BAND_PX | 96 | screenChrome.ts:27 | Minimum height of bottom band for chrome detection | g3.screenChrome |
| BOTTOM_BAND_FRACTION | 0.05 | screenChrome.ts:28 | Bottom band as fraction of image height | g3.screenChrome |
| EXPAND_X | 10 | screenChrome.ts:29 | Horizontal pixel expansion for component clustering | g3.screenChrome |
| EXPAND_Y | 2 | screenChrome.ts:30 | Vertical pixel expansion for component clustering | g3.screenChrome |
| EDGE_ANCHOR_PX | 32 | screenChrome.ts:31 | Pixels from left/right edge for chrome anchoring | g3.screenChrome |
| BOTTOM_ANCHOR_PX | 32 | screenChrome.ts:32 | Pixels from bottom for chrome anchoring | g3.screenChrome |
| MIN_COMPONENTS | 5 | screenChrome.ts:33 | Minimum component count for valid chrome cluster | g3.screenChrome |
| MIN_CLUSTER_WIDTH | 140 | screenChrome.ts:34 | Minimum cluster width for chrome detection | g3.screenChrome |
| VERY_WIDE_CLUSTER | 220 | screenChrome.ts:35 | Width threshold for wide-cluster bottom anchoring | g3.screenChrome |
| MIN_CLUSTER_HEIGHT | 16 | screenChrome.ts:36 | Minimum cluster height for chrome detection | g3.screenChrome |
| MAX_CLUSTER_HEIGHT | 90 | screenChrome.ts:37 | Maximum cluster height for chrome detection | g3.screenChrome |
| chrome point padding | 4 | screenChrome.ts:156 | Padding around chrome regions for point-in-region test | g3.screenChrome |
| BRIGHT_V_MIN | 210 | raster.ts:26 | Minimum V (brightness) for bright pixel classification | shared.hsv |
| BRIGHT_S_MAX | 45 | raster.ts:27 | Maximum S (saturation) for bright pixel classification | shared.hsv |
| DARK_V_MAX | 45 | raster.ts:28 | Maximum V (brightness) for dark pixel classification | shared.hsv |

## Sweep B — assignment side

| constant/literal | value | file:line | what it does | proposed cluster |
|---|---|---|---|---|
| ZFIT_TOP_K | 80 | assignment.ts:15 | limits salvage pairs considered for zfit re-scoring | already on g5.zfit (note 5) |
| ASSIGN_TOP_ROWS | 60 | assignment.ts:16 | window size for candidate pairs per badge during assignment | g4.search |
| EXCHANGE_TOP_K | 12 | assignment.ts:17 | top-k limit for pairwise exchange optimization | g4.search |
| MAX_ASSIGN_PASSES | 60 | assignment.ts:18 | iteration limit for assignment optimization loop | g4.search |
| recovered-tee bbox offset/size | 6 / 12 | assignment.ts:26 | default recovered-tee bounding box | g4.scoring (shared, note 2) |
| ring distance/tolerance | 84 / 12 | assignment.ts:37 | ring membership test | g4.scoring (shared, note 2) |
| recovered tee dedupe distance | 14 | assignment.ts:321 | minimum separation between recovered and existing tees | g4.search |
| alignedWorstCeiling | 0.28 | assignment.ts:95 | aligned worst-window threshold for zfit salvage | already on g5.zfit (note 5) |
| zone factor distance | 35 | scoring.ts:55 | close-proximity threshold for zone factor penalty | g4.scoring |
| zone ring distance/tolerance | 84 / 12 | scoring.ts:56 | primary ring distance for zone factor radial check | g4.scoring (shared, note 2) |
| secondary ring distance/tolerance | 44 / 8 | scoring.ts:56 | secondary ring distance for zone factor check | g4.scoring |
| radial tolerance | 0.5 | scoring.ts:59 | radial alignment fraction threshold for zone penalty | g4.scoring |
| tee orientation sigma | 12 | scoring.ts:157 | gaussian sigma for tee-to-badge angle penalty | g4.scoring |
| badge fraction target | 0.36 | scoring.ts:159 | optimal fractional position of badge along tee-basket chord | g4.scoring |
| badge fraction tolerance | 0.19 | scoring.ts:159 | acceptable deviation from badge fraction target | g4.scoring |
| badge fraction sigma | 0.15 | scoring.ts:160 | gaussian sigma for badge-fraction penalty | g4.scoring |
| collinearity weight | 0.6 | scoring.ts:164 | upward factor for collinearity bonus | g4.scoring |
| collinearity sigma | 2 | scoring.ts:164 | gaussian sigma for collinearity angle penalty | g4.scoring |
| zfit eligibility threshold | 0.28 | scoring.ts:178 | score ceiling for candidates eligible for zfit re-scoring | g5.zfit (note 5) |
| zfit distance stride | 8 | scoring.ts:185 | pixel spacing for intermediate waypoints in zfit search | g5.zfit (note 5) |
| zfit max chord fraction | 0.85 | scoring.ts:185 | maximum detour ratio allowed in zfit path search | g5.zfit (note 5) |
| zfit max additional distance | 220 | scoring.ts:185 | maximum extra distance beyond first-leg for zfit searches | g5.zfit (note 5) |
| zfit bend angles | [-60,-45,-30,-20,0,20,30,45,60] | scoring.ts:187 | bend angle samples (degrees) for zfit waypoint search | g5.zfit (note 5) |
| zfit bend multipliers | 0.8 / 1.6 / 3 | scoring.ts:191 | corridor segment score boosts in zfit | g5.zfit (note 5) |
| zfit bend factor with/without segment | 0.8 / 0.9 | scoring.ts:203 | score multiplier by zfit path shape | g5.zfit (note 5) |
| zfit score multiplier | 0.9 | scoring.ts:204 | weakWindow score multiplier applied to zfit candidates | g5.zfit (note 5) |
| basket identity floor | 0.4 | scoring.ts:298 | minimum score factor for basket identity prior | g4.scoring |
| basket score offset | 0.2 | scoring.ts:298 | offset subtracted from basket.score in identity calculation | g4.scoring |
| basket score scale | 0.5 | scoring.ts:298 | divisor for basket.score normalization in identity | g4.scoring |
| GAUSSIAN_SIGMA | 0.8 | ribbon.ts:4 | sigma for initial gaussian blur of support field | g5.ribbon |
| gradient delta multiplier | 4 | ribbon.ts:111 | multiplier scaling ribbon width for edge-difference sampling | g5.ribbon |
| normalization percentile | 0.995 | ribbon.ts:149 | percentile of raw support used for normalization | g5.ribbon |
| support gamma | 0.7 | ribbon.ts:151 | gamma exponent for support field power normalization | g5.ribbon |
| cost multiplier | 4 | ribbon.ts:172 | multiplicative boost to unsupported regions in routing cost | g5.ribbon |
| halo support threshold | 0.5 | ribbon.ts:205 | support level capped for badge halo occlusion | g5.ribbon |
| patch reach margin | 6 | ribbon.ts:211 | pixel margin added to badge reach for patch-search expansion | g5.ribbon |
| center-outer gray margin | 8 | ribbon.ts:232 | grayscale difference threshold for badge edge patching | g5.ribbon |
| lift threshold | 45 | ribbon.ts:233 | grayscale difference threshold for badge support patching | g5.ribbon |
| support cap for patched cells | 0.85 | ribbon.ts:237 | maximum support value assigned to patched cells | g5.ribbon |
| half-width offsets | 2.5 / 2.5 | ribbon.ts:221 | inner/outer offset from ribbon half-width for orientation sampling | g5.ribbon |
| patch orientations | 24 | ribbon.ts:217 | number of angles sampled when testing badge edge patching | g5.ribbon |
| QUANTUM | 0.125 | routing.ts:7 | distance quantum for bucketed priority queue in pathfinding | g5.routing |
| RING | 64 | routing.ts:8 | ring buffer size for distance-based queue scheduling | g5.routing |
| local cost clamp | 1.4 | routing.ts:36 | cost cap applied to seed neighborhood in pathfinding | g5.routing |
| MIN_COMPONENT_AREA | 6 | segment.ts:55 | minimum pixel area for a connected component to be a digit | g1.digits |
| HEIGHT_RATIO_MIN | 0.5 | segment.ts:56 | minimum height as fraction of tallest component | g1.digits |
| WIDE_RATIO | 0.95 | segment.ts:57 | width-to-height threshold for detecting merged digits | g1.digits |
| VALLEY_SEARCH_LO | 0.3 | segment.ts:59 | lower bound (fraction of width) for valley search window | g1.digits |
| VALLEY_SEARCH_HI | 0.7 | segment.ts:60 | upper bound (fraction of width) for valley search window | g1.digits |
| DIGIT_W | 24 | normalize.ts:13 | width of canonical normalized digit mask | g1.digits |
| DIGIT_H | 32 | normalize.ts:14 | height of canonical normalized digit mask | g1.digits |

## Excluded as not-tunable (both sweeps + merge notes)

Neighbor offset arrays and step geometry (routing.ts DX/DY/STEP), RGBA
stride 4, coordinate arithmetic, mask state labels 0-3, LAPACK EPS/SAFMIN
(components.ts), trained logistic weights (logisticInference.ts W/b/lambda/
iters), normalize.ts 0.5 center-pixel sampling offset, HSV_SHIFT 12
(bit-shift precision), elongation eigenvalue floor 1e-6, IMPROVEMENT_EPSILON
1e-9 (numerical guards), QUANTUM/RING borderline-performance — kept as knobs
since they shape path quality, flagged here as perf-coupled.
