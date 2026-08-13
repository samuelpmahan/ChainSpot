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

*(Owner-confirmed premise, characterization in progress / to be filled in as it's derived —
see the corresponding evaluation-only detector and benchmark for the actual numbers once
available: `src/lib/autoAnnotation/corridorBendDetection*.ts`,
`scripts/benchmark-corridor-bend-detection.ts`.)*

**What it is:** UDisc renders a grey, semi-transparent corridor band directly on the course-map
screenshot, tracing the real hole path from tee to basket — bends included. It is
alpha-composited over whatever terrain is underneath (grass, dirt, pavement), so its *observed*
color varies with the local background, but in a predictable way: `observed = alpha * bandColor
+ (1 - alpha) * underlyingTerrainColor`.

**Width is fixed within one screenshot, not across screenshots.** Do not assume a single
constant, and do not derive it from a cross-device "canonical UI scale" the way badge/tee-pad
size sometimes is elsewhere in this codebase (`deriveCanonicalUiScalePx`) — the owner is
explicit that assuming uniform UI scaling across every device UDisc renders on is not a safe
premise. Measure width directly per photo instead; it holds constant throughout that one image.
Rough owner-observed magnitudes, to be replaced with actual measured values once characterized:
~40px in `IMG_5641.jpg`, ~55-60px in `ReferenceStitch.png`.

**This reframes prior bend-detection work.** `corridorBendDetection.ts` (shipped) and
`corridorBendDetectionRibbonMass.ts` (evaluation-only) both tried to infer fairway shape from
raw terrain classification — solving a much harder and less reliable problem than necessary.
`ribbonMass.ts`'s box-mean-subtracted LAB-lightness approach was likely picking up part of this
band by accident (a semi-transparent overlay creates a local lightness shift independent of what
color the terrain underneath is, which is exactly what that box-mean subtraction measures) —
plausibly why it scored better in the original three-way benchmark than the raw-color-match
detector did. Neither was built with the band as an explicit target.

**Status:** a fourth detector aimed directly at this band (extract by fit to the measured
alpha-composite model, not by inferring terrain) is in progress. Once landed, replace this
section with: the actual measured width spread, the fitted alpha/bandColor and how well that
model held up, and the resulting detector's real accuracy against Dash's 18-hole ground truth,
compared to the two prior (terrain-inference) detectors.
