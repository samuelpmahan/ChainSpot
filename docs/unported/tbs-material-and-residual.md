Two Straight-Test (ST) deviation primitives, captured from two separate branches on the OLD
lineage (`C:/Users/tenni/workspace/ChainSpot`). Both were extracted as prose because every file
moved in the rebuild; nothing here is a port instruction.

Read the shared caveat once: **neither feature has a runtime consumer.** Both are registered
ABFeatures with config, JSON Schema, validators and unit tests, and nothing in the engine calls
them. Turning either config ON changes the resolved-config hash and changes no pixel. That is
deliberate in the original ("runtime composition is deferred"), but it means every accuracy
number below comes from a LAB study or an unrecovered quick pass, never from this code.

---

# ST materialMap — course-local inside-vs-outside material likelihood

## Source

Branch `codex/ab-tbs-material-map` on the OLD lineage. All work is **committed**; the working tree
was clean and checked out on `main` at extraction time. The branch is local-only relative to its
own remote: 7 commits ahead of `origin/codex/ab-tbs-material-map`, of which 4 are this feature and
3 are shared CHSPT-82 knob-extraction commits that also ride unpushed on the sibling branch.

Base for the feature work: `9a6e4b84ad089099c911b8b1b84923990aace7eb`
("CHSPT-82: phase-3 sign-off sweep"). Shared history with the rebuild ends earlier, at
`4da01fba601a250e2fd4e7b8683c9fdd6bf0401b` (2026-08-17).

| SHA | Date | Subject |
|---|---|---|
| `1fb8837f3de4f60ed002ced9003b3d3060755b42` | 2026-08-23 | task: hand off course-local material map |
| `035aec11055029cc0f72bf2359fbf9d6b44ae331` | 2026-08-23 | feat: add course-local material map primitive |
| `9e3f121f38b53e1318d8a65771323fb5a7bbb2fb` | 2026-08-23 | fix: bind material scoring to model bins |
| `e5d73514745b3a32bb1ca84ba17ca0b585bdfd50` | 2026-08-23 | docs: describe material map knobs |

Files touched (old paths):
- `src/lib/detectors/threeFactor/features/st.materialMap.ts` (362 lines, the whole primitive)
- `src/lib/detectors/threeFactor/features/registry.ts` (one import + one list entry)
- `src/lib/detectors/threeFactor/configs/material-map-on.json`
- `src/lib/detectors/threeFactor/configs/threeFactor-config.schema.json` (adds the `ST` gate node)
- `tests/unit/materialMapFeature.test.ts` (216 lines)
- `tests/unit/threeFactorConfig.test.ts` (config pin hash bump)
- `.task/PORT-TBS-MATERIAL-MAP.md` (the handoff card, itself the richest artifact)

Upstream evidence the handoff cites: commit `ef2a4fc2dc4720d3647f705464342f119d5a39a5`,
blob `96d91205fce4ce4733866250c448291aff6e6f00`, path
`scripts/chainspot-lab/badge-disk-ribbon-study.md`. That blob is still readable in the old repo and
is the ONLY place the accuracy numbers live. It is prose, not a runnable producer.

The handoff labels its own provenance **SPECIFICATION-DERIVED**: the study describes the model but
no raw producer for it was ever found, so the code was written from the description, not ported.

## What it detects

It learns, for one specific course, what the walk-corridor paint looks like compared to what the
ground around it looks like — then scores any pixel as "this looks like corridor material" or
"this looks like background".

The learning material is free: by the time this runs, the Tee-to-Badge halves are already frozen
(the pipeline has already decided which tee belongs to which hole number). Those frozen halves are
straight lines of known width running through known corridor. So you can walk each one and collect
pixels you are confident are *inside* the corridor, and pixels you are confident are *outside* it,
without any human labeling.

Two numbers describe each pixel:
- **gray** = `(R+G+B)/3` — how light or dark it is.
- **chroma** = `max(R,G,B) - min(R,G,B)` — how colorful it is, ignoring brightness. Grass, pavement
  and the translucent corridor overlay differ in colorfulness even when they match in brightness.

Those two numbers are dropped into a 24x12 grid of buckets. Two grids are built, one from the
inside pixels and one from the outside pixels. Scoring a new pixel means finding its bucket and
reporting `log(chance the inside grid produced it / chance the outside grid produced it)`. Above
zero means "inside".

## Why it exists

The study had already established a negative result that killed the obvious alternative: **rail
strength without orientation is not a useful family signal.** Roads, tree lines and parking-lot
edges all produce a strong width-spaced edge response at some orientation, so a scalar "how strong
are the rails here" score is nearly worthless.

The cross-course path (train on three courses, predict the fourth) worked but was expensive and
fragile — the best small tree-grid model reached macro IoU 0.7382 with oriented rail vectors
stacked on top of image appearance.

The material map was the deliberate cheap counter-experiment: throw away the cross-course model
entirely and ask whether a course teaches you its own paint. It did. Gray+chroma reached macro IoU
0.671 with no cross-course training at all, nearly matching the generic cross-course image model
(0.6946) on its own. That is the whole argument for the feature: it is course-local, it trains for
free on evidence the pipeline already has, and it needs no corpus.

## Signal and evidence

Sampling geometry, per frozen Tee-to-Badge segment of length `L` and corridor width `W`:

1. Heading runs straight from the tee to the badge. Unit tangent `u`, unit normal `n = (-u.y, u.x)`.
2. Walk the centerline from `start = max(12, 0.12*L)` up to but **not including**
   `stop = max(13, 0.80*L)`, stepping 3px. Both bounds are `max()` of a pixel floor and a fraction,
   so short segments are governed by the floors and long segments by the fractions.
3. At each center point, step sideways along `n`:
   - **inside** samples at `[-0.30, -0.15, 0, +0.15, +0.30] * W`
   - **outside** samples at `[-0.90, -0.75, -0.65, +0.65, +0.75, +0.90] * W`
   - The band from `0.35W` to `0.65W` on each side is deliberately empty. The rails sit at `0.50W`,
     and that gap keeps the antialiased rail pixels out of *both* training sets. This gap is the
     single most important geometric decision in the feature; a rebuilder who "tidies" the offsets
     into an evenly spaced fan destroys it.
4. Geometry is computed in continuous source-image coordinates. Rounding to raster and the
   out-of-bounds policy belong to a caller-supplied `PixelSampler` that returns `Rgb | null`. This
   adapter boundary is explicit and was tested.

Per sampled pixel: gray and chroma as above. Binning is half-open with clipping into the nearest
edge bin — `grayBin = clamp(floor(gray/256 * 24), 0, 23)`,
`chromaBin = clamp(floor(chroma/128 * 12), 0, 11)`, `cellIndex = grayBin * chromaBins + chromaBin`.

Model: two `Float64Array(288)` count grids, both pre-filled with the pseudo-count, one increment
per training sample, then each normalized independently by its own smoothed total
(`cellCount * pseudoCount + sampleCount`). The two histograms are normalized **separately**, so the
model carries no prior over inside-vs-outside frequency; it is a pure likelihood ratio, not a
posterior.

Score: `logOdds = log(P_inside[cell] / P_outside[cell])`, `classifiedInside = logOdds >= 0`.

The `9e3f121` fix matters and should be preserved by name: the model now stores `grayBins`,
`chromaBins` and `chromaMax` on itself, and `scoreMaterial` bins the query pixel using the
**model's** shape rather than whatever knobs the caller happened to hold. Before the fix a caller
could score against a model trained with a different bin layout and either throw or, worse, index
into a mismatched grid. The signature also changed: the third argument went from a knobs object to
a bare `decisionLogOdds` number. In JavaScript that is a live type-confusion footgun and the test
suite pins the throw.

## Thresholds and constants

`W` below is the corridor width supplied per segment. In the old tree the pipeline default was
`corridorWidthPx = 37` (`g5.routing`, formerly `measure.ts DEFAULT_CORRIDOR_WIDTH`). `Wb` is the
badge sprite width from the study: 48px for almost every Dev72 badge, one Lenard badge at 50px.
`Wb` appears nowhere in this code, which is the root of the worst failure case below.

| name | value | how derived | confidence |
|---|---|---|---|
| `sampleStepPx` | 3 | Study sampling choice. No sweep recorded. **UNKNOWN** why 3 rather than 2 or 5. | low |
| `segmentStartPxFloor` | 12 | **UNKNOWN.** Plausibly a tee-sprite clearance or a quarter of the 48px badge, but no derivation is written anywhere. | UNKNOWN |
| `segmentStartFraction` | 0.12 | **UNKNOWN.** Suspiciously close to `12/100`; may be an artifact of tuning on ~100px segments. | UNKNOWN |
| `segmentEndPxFloor` | 13 | **UNKNOWN, and loudly so.** It is `segmentStartPxFloor + 1`. On any segment short enough for the floors to win, this yields exactly one center sample, at distance 12. That looks like a guard against an empty loop rather than a measured value. A test pins the behavior, which means the arbitrariness is now frozen. | UNKNOWN |
| `segmentEndFraction` | 0.80 | Intent is "stop before the badge". It is a fraction of segment length and therefore **not** tied to the badge's actual pixel size. See failure cases. | low |
| `insideOffsetFractions` | `[-0.30, -0.15, 0, +0.15, +0.30]` | Symmetric 5-tap, stopping `0.20W` short of the rail at `0.50W`. Geometrically self-consistent with the gap. | medium |
| `outsideOffsetFractions` | `[-0.90, -0.75, -0.65, +0.65, +0.75, +0.90]` | Symmetric 3-tap per side, starting `0.15W` beyond the rail. Outer reach `0.90W` = ~33px at W=37. | medium |
| rail-gap band | `0.35W` .. `0.65W` (implied, not a named knob) | Emergent from the two offset arrays. Excludes the antialiased rail from both classes. Deliberate; the handoff says "the gap around the rails is intentional". | high (intent), medium (width) |
| `grayBins` | 24 | `linspace(0, 256, 25)` -> 24 half-open bins of 10.667 gray levels. Bin **count** was never swept; only "gray only" vs "gray+chroma" vs "diagonal Gaussian" were compared. | low |
| `chromaBins` | 12 | `linspace(0, 128, 13)` -> 12 bins of 10.667. Same: never swept. | low |
| `chromaMax` | 128 | Study says "clip chroma to <128". Real chroma spans 0..255, so every saturated pixel collapses into bin 11. **UNKNOWN** why 128 and not 256. | UNKNOWN |
| `histogramPseudoCount` | 1 | Textbook Laplace add-one smoothing, applied to every cell of both grids independently. Standard and defensible. | high |
| `decisionLogOdds` | 0 | Study's classification boundary, `score >= 0`. Plain maximum likelihood, never tuned. The `>=` (not `>`) is load-bearing — see fail-open below. | medium |
| `corridorWidthPx` (inherited) | 37 | Not a knob of this feature; arrives as `FrozenSegment.widthPx`. Every offset above is a fraction of it, so an error in `W` scales the entire sampling geometry. | medium |
| `Wb` badge width (referenced, not encoded) | 48 (one at 50) | Measured across all 72 Dev72 badges in the study. **Absent from this code.** | high (measurement), UNKNOWN (why it was not used here) |

Config pin hashes, for the mechanism only — the values are worthless in the rebuild:
base `f244eb1a…de9e` -> with materialMap registered `3885f3da…c890a`. Registering a feature changes
the resolved-config hash even when the feature is OFF; that forcing function is worth keeping.

## Gate placement

Gate `ST` ("Straight Test"). The owner ruling recorded in the engine types is that **ST sits
between G4 and G5** — after Tee-to-Badge assignment, before path routing. It maps to LAB registry
gate 5.

Depends on: frozen Tee-to-Badge halves (G4 `assignment` output), the corridor width parameter, and
raster pixel access. It does **not** depend on baskets (G2) or on any path search.

`kind: 'deviation'`, `defaultEnabled: false`. The registry's import-time integrity check refuses to
load any deviation that defaults ON, which is how frozen-parity is protected.

**It is not wired.** No `EngineUnit` consumes it, no `consumes`/`produces` slots are declared, no
drawables or heatmaps are emitted. The only references in the tree are the registry entry, the two
config files, the schema, and the tests.

## Known failure cases

**1. Badge-bbox contamination on short segments — this is the negative-evidence landmine, in a new
costume.** The study is explicit that pixels inside the opaque badge bbox are UNKNOWN, excluded
from training and evaluation, and "never negative ribbon evidence". This implementation has **no
notion of a badge at all.** Its only protection is `segmentEndFraction = 0.80`, which stops
`0.20 * L` short of the badge center. The badge is ~48px wide, so its half-extent is 24px
axis-aligned and up to ~34px on the diagonal. Therefore:

- for `L < ~120px` (axis-aligned) or `L < ~170px` (worst diagonal orientation), the last center
  samples land **inside the badge bbox**;
- the inside offsets at `±0.30W` (~±11px at W=37) are well within the badge's 24px half-height, so
  badge disk and glyph pixels get trained as **corridor material**;
- the outside offsets at `0.65W..0.90W` (24..33px) straddle the badge's outer edge, so the badge
  halo gets trained as **background**.

Both histograms are poisoned at once, in opposite directions, and nothing reports it. This is the
same family as the trophy-basket square-bbox failure the project already knows: a square box drawn
around a non-square sprite, used as if it described real material. The mitigation direction is the
opposite of the classic one — do not *delete* anything on the strength of the box; just refuse to
*train* on pixels inside it, exactly as the study did.

**2. Fail-open on an empty model.** With zero training samples both grids are uniform, so
`logOdds = 0` for every pixel, and `0 >= 0` classifies **everything as corridor**. A test pins this
("empty training is uniform and score zero passes the >=0 boundary"), so it is intended, but it
means a course where no frozen half survived silently reports total corridor coverage rather than
"I know nothing". Any consumer must check `insideSampleCount`/`outsideSampleCount` before believing
a score.

**3. Lenard is the falsifier.** Per-course IoU: DashsTrack 0.735, HeritagePark 0.669, Lenard 0.546,
TowneLake 0.733. The study's reading: on Lenard, pavement and background share the corridor's
gray/chroma family. Material likelihood alone is a prior, not ownership evidence, and a ~0.19 IoU
spread between the best and worst course is the honest error bar on the headline 0.671.

**4. Silent sample drops.** `collectMaterialSamples` skips any pixel where the sampler returns
`null` and only reports aggregate `requestedCount` / `visibleCount`. The engine's trace contract
states that filtering code MUST emit a rejected drawable per killed candidate. Nothing here does,
and the counts are not split by region, so a segment that runs off-raster on one side can silently
skew the inside/outside balance.

**5. Neighbouring-corridor bleed.** Outside samples reach `0.90W` ≈ 33px from the centerline. On a
tight course layout that is far enough to land on an adjacent hole's corridor, which then trains as
background. No adjacency check exists.

**6. Chroma clipping.** All chroma ≥ 128 collapses into one bin. A saturated overlay color and a
saturated non-corridor object become indistinguishable in the chroma axis.

**7. `scoreMaterial` signature confusion.** Third argument is now a plain number. Passing the old
knobs object throws (pinned by test) but only because of an explicit `Number.isFinite` guard; a
caller passing any other number silently shifts the decision boundary.

## What proves it works

**Unit tests — real and reasonably thorough.** `tests/unit/materialMapFeature.test.ts`, 8 tests:

- exact distance list, center count, per-segment summary, and the full 11-point offset fan at the
  first center, with literal coordinates
- fractional bounds winning on a long segment; stop is exclusive (`159` present, `160` absent)
- `segmentEndPxFloor` strictly winning on a 10px segment (added by the `9e3f121` fix commit)
- sampler owns rounding: the first sampled coordinate is `[12.5, 0.25]`, unrounded
- exact gray/chroma; half-open clipped boundary bins at 0, 255/127.999, 256/128, and negative
- add-one smoothing and separate normalization verified against literal `[0.4, 0.2, 0.2, 0.2]`
- `log(2)` log-odds, threshold classification, determinism, model-owned chroma boundary
- 11 parameterized validator-rejection cases plus segment-geometry rejection
- `material-map-on.json` parses and resolves to exactly the defaults

**Accuracy claims — nothing in this branch backs them.** The numbers below come from
`badge-disk-ribbon-study.md` and are study prose. There is no producer script, no fixture, no
rendered evidence image, and no held-out artifact anywhere in the branch:

| direct material model | macro IoU | precision | recall |
|---|---|---|---|
| gray only | 0.570 | 0.608 | 0.898 |
| **gray + chroma histogram** | **0.671** | **0.735** | **0.882** |
| diagonal RGB/gray/chroma Gaussian | 0.611 | 0.675 | 0.863 |

**Read the 0.671 correctly, or you will overclaim.** The study evaluated on a **disk of radius
`Wb` (~48px) around each badge center**, with badge-interior pixels excluded, using leave-one-hole-
out within the same course (the other 17 frozen halves train each held-out hole). It is a
badge-local IoU on 72 small disks, **not** course-wide corridor segmentation. The ported primitive
has no concept of that disk, so a rebuilder who runs it over a whole image and compares against
0.671 is measuring a different thing.

The handoff itself says so: "historical IoU/precision/recall below are study claims, not reproduced
results. There is no runnable source producer against which to claim output parity."

## Regeneration notes

Must get right:

- The **rail gap** (`0.35W`..`0.65W` empty). It is the reason the two classes are clean.
- `max()` semantics on both bounds, and the **exclusive** stop. Off-by-one here changes the training
  set on every short segment.
- **Separate** normalization of the two histograms, each by its own smoothed total. Normalizing
  jointly turns a likelihood ratio into a posterior and silently bakes in a class prior.
- Add-one smoothing applied to **every cell of both grids**, before normalization. This is what
  keeps `log(P/P)` finite for unseen buckets; drop it and you get `-Infinity`/`NaN` on the first
  unusual pixel.
- Half-open bins with **clipping**, not wrapping and not rejection.
- The model owning its own bin shape (`grayBins`, `chromaBins`, `chromaMax`) and scoring using the
  model's shape, not the caller's. Re-deriving this from scratch usually reproduces the original
  bug.
- The **pixel-sampler adapter boundary**: geometry stays continuous, the sampler owns rounding and
  out-of-bounds. This is what made the geometry testable without a raster.
- Deviation defaults OFF, enforced at import time.

Must **fix**, not reproduce:

- Add badge-bbox exclusion. Take the badge box (padded), and drop any training sample whose point
  falls inside it. Positive polarity only: skip the sample, never conclude "no corridor here".
  Without this the feature poisons itself on short holes.
- Emit per-region drop counts, or better, rejected drawables with a reason, so the silent-drop rule
  is honored.
- Report a "model is uninformative" flag when either sample count is below some floor, so the
  fail-open at `logOdds = 0` cannot be mistaken for a positive detection.

Free to change:

- Bin counts, `chromaMax`, `sampleStepPx`, all four segment-bound knobs, and the offset arrays —
  none were swept, so none are load-bearing values, only load-bearing *shapes*.
- The decision threshold. `0` is maximum likelihood, not a tuned operating point; if this ever feeds
  a real gate, the threshold should be picked on a precision/recall curve, not inherited.
- Data layout (`Float64Array`, cell indexing), instrumentation, and whether the model is trained per
  course, per image, or per already-frozen-half set. The handoff explicitly releases the
  leave-one-hole-out protocol: that was evaluation leakage control, and runtime may train on every
  frozen half available.

## Verdict

**Worth regenerating.** It is ~120 lines of honest math with the strongest recorded course-local
signal in the project (0.671 badge-disk IoU with zero cross-course training), every constant is now
written down, and the two things that make it dangerous — missing badge exclusion and the fail-open
threshold — are both cheap to fix on the way in.

---

# ST compositeResidual — outside-to-inside affine renderer residual

## Source

Branch `codex/ab-tbs-composite-residual` on the OLD lineage. All work is **committed**; working tree
clean. 6 commits ahead of `origin/codex/ab-tbs-composite-residual`, of which 3 are this feature and
3 are the same shared CHSPT-82 knob-extraction commits carried by the sibling branch.

Base for the feature work: `9a6e4b84ad089099c911b8b1b84923990aace7eb`, the same base as materialMap.
Shared history with the rebuild ends at `4da01fba601a250e2fd4e7b8683c9fdd6bf0401b`.

| SHA | Date | Subject |
|---|---|---|
| `42d6195c61a70c17f70d9d631e7bffe9e662cbde` | 2026-08-23 | task: hand off outside-to-inside composite residual |
| `6f8bc1a4600c91086c4b0a2ed2be402d9a1c3f6c` | 2026-08-23 | feat: add composite residual primitive |
| `92ce0c480c9477086af1817a190bebd63ed984d1` | 2026-08-23 | test: harden composite residual boundaries |

Files touched (old paths):
- `src/lib/detectors/threeFactor/features/st.compositeResidual.ts` (344 lines)
- `src/lib/detectors/threeFactor/features/registry.ts` (one import + one list entry)
- `src/lib/detectors/threeFactor/configs/tbs-composite-residual-on.json`
- `src/lib/detectors/threeFactor/configs/threeFactor-config.schema.json` (adds the `ST` gate node)
- `tests/unit/compositeResidual.test.ts` (278 lines)
- `tests/unit/threeFactorConfig.test.ts` (config pin hash bump)
- `.task/PORT-TBS-COMPOSITE-RESIDUAL.md`

Provenance is **SPECIFICATION-DERIVED** and weaker than materialMap's. The study blob
(`96d91205fce4ce4733866250c448291aff6e6f00`) lists this under **"Next experiment: outside -> inside
composite residual"** — it is described as a thing to try, not a thing measured. The AUC and
residual figures in the handoff come from a separate "fresh Dev72 quick pass" whose producer and
artifacts were never located. The handoff says so in capital letters: "**HISTORICAL CLAIM — NOT
REPRODUCED**".

Two implementation notes recorded in the handoff MEP are worth keeping because they are the kind of
thing that gets rediscovered painfully:
- The fresh worktree could not run tests at all until `npm ci` restored lockfile dependencies.
- The first focused test discrepancy was a **test** bug, not an implementation bug: an expanded
  badge bbox covered x=26 through x=30 **inclusively**, skipping rail centers on both boundaries,
  while the expected count assumed only one. The test was corrected to preserve the stated inclusive
  policy. Inclusive containment is the intended semantics; do not "fix" it to exclusive.

## What it detects

The corridor is drawn as a translucent overlay on top of the map. Whatever is underneath shows
through, tinted. So there should be a consistent, learnable relationship between the color just
*outside* a corridor rail and the color just *inside* it: same ground, one of them run through the
renderer's overlay.

This feature learns that relationship from rails you already trust, then uses it as a test. Take a
proposed corridor edge somewhere else in the image. Sample the color just outside it and just
inside it. Predict what the inside *should* look like given the outside. Measure how far off you
were. Small error means "this really is the same overlay"; large error means "these two colors just
happen to differ, this is a tree line or a road".

The relationship is modeled as the simplest thing that could work: for each of R, G and B
independently, `inside = a * outside + k`. Six numbers total. The handoff is emphatic that this is
**not** literal alpha recovery — the screenshot is already flattened, so `a` and `k` are just a
fitted affine transform, not a recovered compositing equation.

## Why it exists

Two reasons, both recorded.

First, the study's stated weakness of the material map: "Raw greyness can confuse ribbon with
pavement." Material likelihood asks "does this pixel look like corridor paint?" — and on Lenard,
pavement answers yes. The residual asks a harder question that pavement cannot fake: "does this
pixel look like *its own neighbour* run through the corridor overlay?" That is a renderer-specific
relationship, not a color.

Second, and this is the load-bearing finding: **the fitted coefficients vary enormously by course.**
Median channel slopes were roughly Dash 0.31–0.33, Heritage 0.60, Lenard 0.21–0.26, Towne 0.53–0.56.
A factor of nearly three between courses. The handoff draws the correct conclusion in bold: **DO NOT
hard-code a universal alpha or overlay color.** Any global constant here would be a threshold fit to
one course's screenshots masquerading as a renderer fact. Course-local adaptation is the entire
point of the feature.

## Signal and evidence

Training pair collection, per frozen Tee-to-Badge segment (a polyline, not necessarily two points):

1. Resample the polyline by **cumulative arclength** at 4px. Distances are `0, 4, 8, ...` up to and
   including the total length; the final endpoint is emitted only when the total length is an exact
   step multiple, so no partial-step sample is forced at the end. Zero-length legs are ignored
   (`EPSILON = 1e-9`). A sample landing exactly on an interior vertex takes the **preceding** leg's
   tangent.
2. Drop the first 3 and last 4 generated samples, **per segment**.
3. For each surviving sample, normal `n = (-tangent.y, tangent.x)`, and for both signs (emitted `-1`
   before `+1`, deterministically):
   - `railCenter = center + sign * (W/2) * n`
   - if the segment has a badge box and `railCenter` is inside that box expanded by
     `badgeSkipPadPx` on all sides — **inclusive** on all four edges — skip this sign entirely.
   - `inward = -sign`; `insidePoint = railCenter + inward * 3 * n`;
     `outsidePoint = railCenter - inward * 3 * n`
   - Read both with `Math.round` on the coordinates; alpha is ignored. If **either** rounded sample
     falls outside the raster, discard the whole pair.

Fit, per RGB channel independently, ordinary least squares with design matrix `[B, 1]`, no
regularization:
`slope = cov(B, C) / var(B)`, `intercept = mean(C) - slope * mean(B)`.
Degenerate policy: when a channel's background variance is exactly zero, take the deterministic
intercept-only solution `a = 0, k = mean(C)`. At least one pair is required; zero pairs throws.

Score for a pair: `Cpred = B * a + k` componentwise, then
`residual = sqrt(mean((C - Cpred)^2 over R,G,B))` — RGB RMSE, in raw 0–255 units. Lower means more
corridor-like. **No probability transform.** The handoff forbids inventing one.

Training scale: `sigma = max(residualScaleFloor, quantile(trainingResiduals, 0.75))`, using the
type-7 (linear interpolation at index `(n-1)*q`) definition, floor returned for an empty list. The
handoff is candid that "sigma was recorded but not needed for AUC" — **nothing consumes this
value.**

## Thresholds and constants

`W` (`corridorWidthPx`) is a **caller parameter, not a knob of this feature**. Pipeline default in
the old tree was 37.

| name | value | how derived | confidence |
|---|---|---|---|
| `sampleStepPx` | 4 | Quick-pass choice. Not swept. **UNKNOWN** why 4 here when materialMap uses 3. | low |
| `skipStartSamples` | 3 | 3 samples = 12px of arclength off the tee end. **UNKNOWN** derivation. | UNKNOWN |
| `skipEndSamples` | 4 | 4 samples = 16px off the badge end. Asymmetric with the start skip, **UNKNOWN** why. 16px is less than the 24px badge half-width, so this does **not** by itself clear the badge — the bbox skip is doing the real work. | UNKNOWN |
| `edgeDeltaPx` | 3 | Explicitly labeled "quick-pass `edgeDeltaPx=3`" in the handoff. Places samples at `W/2 ± 3` = 15.5px and 21.5px from the centerline at W=37. Antialiasing on a rail is ~1–2px, so 3px is barely clear of it. | low |
| `badgeSkipPadPx` | 2 | **UNKNOWN.** 2px of slack around the badge bbox. Note it is smaller than `edgeDeltaPx = 3` — see failure cases. | low |
| `residualScaleQuantile` | 0.75 | Conventional robust scale (q75 rather than max, to resist outliers). The value was recorded but never used downstream. | medium |
| `residualScaleFloor` | 2 | From `sigma = max(2, q75(...))`. 2 RGB units guards against a degenerate zero scale on a perfectly-fit training set. **UNKNOWN** why 2. | low |
| `EPSILON` | 1e-9 | Internal arclength tolerance for zero-length legs and endpoint snapping. Not exposed as a knob or in the schema. A numeric guard, not a tuned value. | high |
| `corridorWidthPx` (inherited) | 37 | Sets where the rails are assumed to be. Every sample position depends on it. | medium |

Historical numbers — **NOT REPRODUCED, no producer or artifact located anywhere in the repo:**

- Held-out-hole quick-pass separation against **hard** negatives, chosen specifically because they
  already showed strong ordinary positive edge lift: true median residual ≈ **13.9** RGB units vs
  hard-negative ≈ **29.5**.
- Mean residual AUC ≈ **0.664** vs edge-only mean AUC ≈ **0.584**.
- By-course median residual AUC: Dash ≈ 0.693, Heritage ≈ 0.787, Lenard ≈ 0.573, Towne ≈ 0.694.
- Fitted median channel slopes: Dash 0.31–0.33, Heritage 0.60, Lenard 0.21–0.26, Towne 0.53–0.56.

Config pin: base `f244eb1a…de9e` -> with compositeResidual registered `43c10c5f…8ccf`. Note the two
branches produce **different** hashes and both add an `ST` node to the schema — they conflict
textually if regenerated naively together.

## Gate placement

Gate `ST` ("Straight Test"), between G4 and G5, LAB registry gate 5. Same slot as materialMap.

Depends on: frozen Tee-to-Badge segments (G4 `assignment`), an `RgbaImage` raster, the corridor
width parameter, and optionally a badge bbox per segment. It does not depend on baskets or path
search.

`kind: 'deviation'`, `defaultEnabled: false`, enforced at import time by the registry integrity
check.

**Not wired.** The handoff states the reason plainly: "no ST consumer exists, so runtime composition
is intentionally deferred and engine ON/OFF output remains identical." The handoff's own final
verdict is "READY for an **IMPLEMENTED PRIMITIVE**, not operational A/B inclusion."

The handoff also explicitly forbids combining this with `minRequiredRun` in this branch — that
contiguity behavior has its own port. If a rebuilder merges them, the ablation that would tell you
which one carries the signal becomes impossible.

## Known failure cases

**1. Bounding-box leak past the skip.** The badge skip tests only the geometric `railCenter` against
the padded bbox. The inside and outside sample points sit `edgeDeltaPx = 3` px away along the
normal, and `badgeSkipPadPx = 2` does not cover that. A rail center 2.5px outside the padded box
still reads a sample from inside the badge. The polarity is at least the safe one — a skipped sample
is simply absent, never asserted as "no corridor here" — but the leak silently feeds badge pixels
into the affine fit. Any regeneration should pad by at least `badgeSkipPadPx + edgeDeltaPx`, or test
the sample points themselves rather than the rail center.

**2. Silent degradation to a constant model.** When a channel's background variance is exactly zero,
the fit becomes `a = 0, k = mean(C)`. The "transform" then predicts a constant inside color no matter
what the background is, and the residual degenerates into "distance from the average corridor color"
— which is a worse version of the material map, wearing the residual's name. Nothing flags that this
happened. A regenerated version must surface per-channel `var(B)` and pair count so the caller can
see the model collapsed.

**3. Segments under ~28px contribute nothing, silently.** A segment yields `floor(L/4) + 1` samples
and the skips consume 7 of them, so `L` must be at least 28px before a single pair exists. No
diagnostic is emitted for a segment that produced zero pairs.

**4. Silent out-of-bounds drops.** `if (!insideRgb || !backgroundRgb) continue;` — with no counter at
all, not even an aggregate. This is worse than materialMap's version and directly violates the
engine's stated no-silent-drops rule. The test suite even pins a case where an entire sign is lost
near the raster edge (`nearEdge` has 4 pairs, all `sign === 1`), which is exactly the asymmetry that
would bias a fit without warning.

**5. Everything hangs on `corridorWidthPx` being right.** Rails are assumed at `±W/2`. If the true
corridor width differs from 37, the "inside" sample may land outside the rail and the "outside"
sample on the rail itself. The fit then learns a relationship between two wrong materials and
reports confident small residuals for the wrong reason. This is the project's threshold-fragility
rule in its purest form: `37` is a dataset-fit estimate and it silently governs this entire feature.

**6. Lenard again.** Per-course AUC 0.573 there against 0.787 on Heritage. The handoff's own reading:
"composite residual is useful but not sufficient alone." Note also that the headline AUC 0.664 was
measured against **deliberately hard** negatives; against ordinary negatives the number would be
higher and would not mean the same thing.

**7. `samplePolylineByArcLength` is O(n²).** `legs.find(...)` scans from the start for every sample.
Irrelevant on a two-point segment, real on a long refined polyline. The study's own runtime
discipline caps experimental compute bursts at 40 seconds.

**8. The recorded scale is dead weight.** `compositeResidualScale` is fully implemented and tested
and nothing calls it. Either wire it or drop it; leaving it looks like a calibrated threshold exists
when none does.

## What proves it works

**Unit tests — genuinely good, and testing the right things.** `tests/unit/compositeResidual.test.ts`,
9 tests:

- default-OFF, gate `ST`, full knob resolution from `tbs-composite-residual-on.json`, and every
  validator's rejection behavior
- arclength sampling: no forced partial endpoint, the incoming leg's tangent at a vertex,
  zero-length legs ignored — with literal expected sample lists
- 8 parameterized invalid-knob cases thrown from the exported boundary, plus invalid corridor width
- exact both-sign pair geometry with literal `center` / `railCenter` / `insidePoint` /
  `outsidePoint` / RGB values read off a synthetic coordinate raster (`R=x, G=y, B=x+y`), which is a
  nice trick: every pixel encodes its own address, so a coordinate error shows up as a wrong color
- inclusive expanded-badge containment (the case that caught the test bug) and out-of-bounds drops
- exact affine recovery on constructed data (`aR=2, aG=0.5, aB=-1, kR=5, kG=7, kB=30`)
- degenerate intercept-only policy, including a mixed case where one channel degenerates and two do
  not
- RGB RMSE against a known value and zero on-model
- deterministic q75 with interpolation, floor behavior, and the `q=0` / `q=1` endpoints

**Accuracy claims — nothing backs them. Not the branch, not the study, not a fixture, not an
image.** The study lists this only as a future experiment. The quick-pass numbers exist solely as
prose inside the handoff card, attributed to a run whose producer was searched for and not found.
Treat 0.664 AUC and 13.9-vs-29.5 residuals as anecdotes with a provenance trail that dead-ends.

## Regeneration notes

Must get right:

- **Per-channel independence.** Three separate 1-D fits, not one 3-D fit. Cheaper, and it is what
  the recorded coefficients describe.
- **Cumulative arclength** sampling with the documented endpoint rule and the preceding-leg tangent
  at a vertex. Naive per-leg sampling changes which points get skipped and silently changes the
  training set.
- **Inclusive** bbox containment. The correction commit exists precisely because someone assumed
  exclusive.
- Deterministic ordering: `sign = -1` emitted before `+1`, skips applied per segment. The whole
  feature is meant to be reproducible bit-for-bit.
- The degenerate `a = 0, k = mean(C)` policy — but emit a diagnostic when it fires.
- Discarding the **whole pair** when either sample is out of raster, never half a pair.
- No probability transform. The output is a raw RGB RMSE and should stay one until someone measures
  a calibration.
- **No universal alpha.** This is the finding, not an implementation detail.

Free to change:

- Every knob value. All seven are quick-pass numbers and none were swept.
- The scale function, which nothing uses.
- The O(n²) leg lookup (a running index makes it linear).
- Whether the model is fit per course, per image, or per frozen-half set.

Must add before believing anything:

- Pair count, per-channel background variance, and dropped-sample counts as measurements.
- A rejected drawable carrying observed residual and threshold, if this is ever wired as a rejector —
  the handoff already requires this and the current code cannot satisfy it.

## Verdict

**Partially worth regenerating.** The core insight is solid and worth preserving as prose — course
overlay transforms differ by a factor of three, so never hard-code an alpha — and the fit itself is
about 30 lines. But every performance number dead-ends at an unrecoverable quick pass, it never beat
the material map, and it is unwired; rebuild the fit only when someone is actually ready to run the
A/B against materialMap, and rebuild the arclength sampler regardless since both features want it.
