# UDisc-rendered UI elements in source screenshots

The course-map and round images this app ingests (`resources/ribbon-reference/IMG_5641.jpg`,
`resources/real-capture/ReferenceStitch.png`, `resources/stitch-annotate/AlexClark/*`, and any
user-supplied screenshot) are **UDisc app screenshots**, not raw aerial/satellite photography.
Every one of them already has UDisc's own rendered UI baked into the pixels — tee/basket icons,
number badges, and (see below) a pre-computed corridor overlay — on top of the underlying
satellite base map. Every detector in `src/lib/autoAnnotation/` that matches against a fixed
template or a narrow, specific color signature (as opposed to trying to classify arbitrary
terrain) is implicitly relying on this: it is finding UDisc's consistent iconography, not an
arbitrarily-varying real-world object.

This doc exists so that distinguishing "rendered UI element" from "real terrain feature" in a
reference image doesn't have to be re-derived by eye (or argued over) every time. Add to it as
new elements get identified; update an entry's confidence once it moves from guess to confirmed.

## Confirmed

### Tee pad icon
White pin/marker glyph rendered at a hole's tee. `teePadDetection.ts` detects it via a
low-saturation gray-center rectangle detector and a bright-rim/gray-interior edge-loop detector,
fused when both fire. **`xPx`/`yPx` is the fitted rectangle's source-image center** (a true
centroid, not an edge or corner) — see `TeePadCandidate`'s doc comment.

### Number badge
The black rounded-rectangle placard with a white hole number (`"14"`, `"1"`, etc.), placed near
each hole's tee. `holeNumberDetection.ts` locates the physical badge via template matching, then
separately classifies the digit glyph inside it. **`xPx`/`yPx` is the center of the physical
badge** — see `HoleNumberCandidate`'s doc comment. This is one of the three points
`collinearityStraightnessTest.ts` uses (see below).

### Basket icon
The pin/flag-and-chains glyph rendered at a hole's basket. `basketTemplateDetection.ts` locates
it via NCC template matching. **`xPx`/`yPx` is the semantic endpoint: the bottom-center stem
base** — deliberately not the glyph/icon center — see `BasketCandidate`'s doc comment.

### Corridor ribbon (the hole path itself)
**This is the single most important entry in this doc — see the full write-up below.** A grey,
semi-transparent band UDisc renders between a hole's tee and basket, following the *actual*
intended line of play including any bends. It is not terrain and it is not something this app
should be inferring from fairway color — UDisc already computed and drew the answer; the job is
to extract it, not re-derive it. See "The corridor ribbon" section below for the full
characterization (width, color/alpha model, and the detector built against it).

### Landing droplet (round screenshots only, not course-map screenshots)
The blue teardrop pin UDisc drops at each thrown disc's landing spot in a *round* screenshot
(different screenshot type than the course-map images the corridor/bend work uses).
`landingDropletDetection.ts` detects it via HSV thresholding on UDisc's marker blue, and reports
the droplet's **tip** (bottom-most blue pixels) as the landing coordinate. See
`docs/cv-landing-droplet-detection.md` for the full write-up, including known-limited coverage:
only `c1`/`c2`/`off-fairway` glyph classes are templated so far, from one real fixture
(`ReferenceStitch.png`, 4/4 droplets). The owner expects more droplet/marker variants exist in
UDisc that aren't in this app's reference data yet (e.g. other outcome classes, OB markers) —
flagged as trivial to add detection for once more real examples are available, not a design
limitation of the detector itself.

### Map chrome (satellite/map toggle controls, etc.)
Stitched/full-screenshot captures like `ReferenceStitch.png` include UDisc's own on-screen
controls (e.g. "MAP"/"SAT" toggle buttons) at the screenshot's edges. Not course geometry; just
noise the landing-droplet detector already confirms it doesn't false-positive on. No dedicated
handling needed elsewhere unless a future detector starts tripping on it.

## Unconfirmed — needs a real answer before relying on it

### Small grey rotated-square ("diamond") icon
Seen at least twice in the `IMG_5641.jpg` hole 13/14/15 area (e.g. near a basket, and near a
badge), a small grey square rendered edge-on (~diamond orientation). Owner's guess: **probably a
tee pad**, but unconfirmed — no code in this repo currently detects or names it, and it hasn't
been cross-checked against ground truth. Do not assume either way; if it matters for a task,
verify first (crop and compare against several instances, check whether it always sits near a
tee vs. inconsistently near other features).

### Dashed circle around tee/basket areas
A large dashed light-gray circle surrounding the tee (and separately the basket) icon in
`IMG_5641.jpg` crops. Confirmed to be baked into the raw source JPG itself (not a live ChainSpot
render — the crops that first surfaced this were taken directly from the on-disk fixture, not
from the running app), so it is UDisc's own rendering, not this app's. Purpose/semantics unknown
— possibly an interaction/selection radius, possibly something course-design-relevant (e.g. an
out-of-bounds or mando circle). Do not guess at its meaning in code or detection logic until
confirmed.

---

## The corridor ribbon — full characterization

**What it is:** UDisc renders a grey, semi-transparent corridor band directly on the course-map
screenshot, tracing the real hole path from tee to basket — bends included. It is
alpha-composited over whatever terrain is underneath (grass, dirt, pavement), so its *observed*
color varies with the local background, but in a predictable way: `observed = alpha * bandColor
+ (1 - alpha) * underlyingTerrainColor`. Full detector and measurement live at
`src/lib/autoAnnotation/corridorBendDetectionRibbon.ts` and `scripts/measure-corridor-band.ts`.

**Width is fixed within one screenshot, not across screenshots — measured, not assumed.**
Empirically measured via perpendicular cross-sections on `IMG_5641.jpg`'s 9 straight holes
(29 accepted samples across 8/9 holes; the 9th, hole 16, runs along a treeline whose canopy
texture never passed the measurement's contamination guard): **mean 39.3px, median 40.6px,
stdev 10.9px, range 19.1–64.0px.** Cross-checked on `resources/real-capture/ReferenceStitch.png`
(no ground truth there, so measured by locating a plausible straight stretch by eye and
refining endpoints via contrast maximization): **median 9.3px, range 4.3–20.2px** — roughly 4x
narrower, confirming width genuinely varies by screenshot/capture scale and must be re-measured
per photo. Do not derive it from a cross-device "canonical UI scale" the way badge/tee-pad size
sometimes is elsewhere in this codebase (`deriveCanonicalUiScalePx`) — the owner is explicit that
assuming uniform UI scaling across every device UDisc renders on is not a safe premise, and this
measurement bears that out directly.

**Color/alpha — fit cleanly, self-calibrate per hole, don't hard-code either fixture's numbers.**
Least-squares fit over 106 (on-band, off-band) pixel pairs pooled across 15 Dash holes (varied
underlying terrain, not just one color): **alpha ≈ 0.70, bandColor ≈ RGB(152, 157, 153)**, RMSE
≈ 13.2 (0–255 scale/channel) — a good, non-degenerate fit. The same fit attempted on
`ReferenceStitch.png`'s 13 cross-check pairs came out alpha ≈ 1.13, which is physically
impossible (alpha must be in (0, 1)) — that fixture's sample set wasn't suited to a reliable
color fit, so its numbers are reported as unreliable rather than forced. This is exactly why
`corridorBendDetectionRibbon.ts` self-calibrates alpha/bandColor fresh per hole from pixels near
that hole's own tee/basket, rather than hard-coding either photo's fitted values.

**This reframed prior bend-detection work, and it helped, but didn't close the gap.**
`corridorBendDetection.ts` (shipped) and `corridorBendDetectionRibbonMass.ts` (evaluation-only)
both infer fairway shape from raw terrain classification. `ribbonMass.ts`'s box-mean-subtracted
LAB-lightness approach was likely picking up part of the real band by accident (a semi-transparent
overlay creates a measurable local lightness shift independent of the color underneath, which is
exactly what that box-mean subtraction measures) — plausibly why it scored better in the original
comparison than the raw-color-match detector. `corridorBendDetectionRibbon.ts`, aimed at the band
on purpose, benchmarks as follows on Dash's 18 real holes (same methodology as the other two):

| detector | exact bend count | false bends on 9 straight holes | bent holes correctly located |
|---|---|---|---|
| color-heuristic (shipped) | 44% | 1/9 | 0/9 |
| ribbon-mass (eval-only) | 67% | 1/9 | 0/9 |
| ribbon-band (eval-only) | 50% | **0/9** | 0/9 |

Perfect specificity (every straight hole correctly called straight, zero false bends — better
than either prior detector) but still zero correctly-located bends on genuinely bent holes.
Documented root cause in the module: many baskets on real screenshots carry a SECOND
semi-transparent overlay — a tinted landing-zone/OB-circle fill, roughly 90px radius on
`IMG_5641.jpg` — that composites into a similar mid-tone grey-green as the ribbon itself. A
hole whose fitted alpha/bandColor happens to resemble that circle's own blend has its mask
swallow the circle's interior instead of tracing the ribbon; the existing detour-ratio guard then
conservatively rejects rather than proposing a wrong bend, so this collapses to "no bends found"
on many real doglegs rather than a wrong answer. Not yet solved — the ribbon's own measured width
is a plausible next signal for telling a narrow ribbon apart from a much wider landing-zone
circle, not yet used for that purpose.

**None of the three detectors above are wired into the live app.** Only the color-heuristic one
is — it shipped first, before this characterization existed, and its own real-world accuracy on
Dash (0/9 bent holes located, same as the others) hasn't been revisited since.

## A note on "which real capture set is clean"

Two different real capture sets of Dash's Track exist in this repo and are NOT interchangeable:
- `static/resources/demo/dashs-track/udisc-capture-{1..4}.png` — the app's own `/demo` walkthrough
  tiles. Confirmed clean of any walk-path/GPS-trail overlay on every hole, including 1-2.
- `resources/real-capture/{TL,TR,BL,BR}.PNG` — a different, separately-captured set (different
  checksums) that was apparently captured mid-round: it has UDisc's purple walk-path overlay
  baked into the raw screenshots themselves near holes 1-2, on every one of its four tiles.
  Confirmed by direct pixel inspection of the raw file, not just the stitched composite — re-stitching
  cannot remove it, since it predates stitching. `resources/real-capture/ReferenceStitch.png` (the
  pre-existing checked-in composite of this set) has the identical, unavoidable obstruction.

`scripts/stitch-real-capture-reference.ts` can produce a fresh, verified-clean composite from
either dataset (`dashs-track-demo`, the default, or `real-capture`) via the real production
stitch pipeline — prefer `dashs-track-demo` for anything that needs a walk-path-free reference.
