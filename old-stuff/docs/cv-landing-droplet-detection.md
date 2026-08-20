# Round-marker (landing-droplet) detection

`src/lib/autoAnnotation/landingDropletDetection.ts` detects UDisc's thrown-disc landing
markers in a round screenshot: the blue teardrop pin dropped at each landing spot. It reports
the pin's **tip** (bottom point) as the semantic landing coordinate, and separately classifies
the small interior glyph as `c1` / `c2` / `off-fairway`.

This is a narrow primitive, ported from a Python/OpenCV diagnostic baseline (see the
implementation handoff). It does not assign markers to holes, infer throw order, infer made
putts, or reconstruct a round — that is out of scope here.

- Localizer: `findLandingDroplets(cv, raster, options)` — HSV-thresholds UDisc's marker blue,
  keeps droplet-shaped connected components, and reads the tip from the bottom-most blue rows
  (never the blob centroid or bounding-box center).
- Classifier: `classifyLandingDropletGlyph(s)` — crops each droplet's interior (ignoring the
  tip), isolates the white/bright glyph, and compares it against bundled canonical templates
  (`static/resources/chainspot_cv_templates/round-landing-glyph-{c1,c2,off-fairway}.png`) via a
  Dice-overlap score. These templates are generated from a real, hand-labeled round screenshot
  by `scripts/generate-landing-droplet-templates.ts` — not learned at runtime.
- CLI: `npm run detect:landing-droplets -- <image> --out <dir>` renders a labeled overlay
  (bounding box + tip crosshair + class, color-coded per class; deferred regions in orange) and
  writes machine-readable results to `<dir>/landing-droplets.json`.

Validated against `resources/real-capture/ReferenceStitch.png` (the only real fixture image
currently checked into the repo): 4/4 standalone droplets detected, correct tip coordinates,
and all four correctly classified (`c1`, `c2`, `off-fairway`, `c1`), with zero false positives
from the stitched map's UI chrome (MAP/SAT controls). This claim is pinned by
`tests/unit/landingDropletDetectionFixture.test.ts`, which runs the real localizer +
classifier against this fixture and the bundled templates, so a regression here fails CI
instead of silently drifting from this doc. The close-scale and medium-scale screenshots
referenced in the original handoff (`IMG_5612.png`, `IMG_5613.png`) were not available to
check into this repo.

The detector's thresholds are deliberately expressed as relative/adaptive quantities (aspect
ratio; area relative to the dominant same-image droplet cluster) rather than fixed absolute
pixel sizes, specifically so they are not overfit to one screenshot resolution. The one
absolute-pixel component -- the upper size sanity bound that guards against a mis-thresholded
region being treated as a giant droplet -- is itself expressed as a fraction of the raster's
own shorter side (floored at a fixed pixel value sized for the real fixture above), so it
scales with the image instead of silently rejecting every droplet on a much
higher-resolution screenshot; see `pinSizeBounds()` and the
"resolution-relative size bounds" test in `tests/unit/landingDropletDetection.test.ts`.

## Deferred: overlapping/merged droplets

A short missed putt can drop two landing droplets close enough together that, at some zoom
levels, their blue pixels touch and connected-components analysis reports one larger blob
instead of two pins.

This implementation explicitly does **not** attempt to split that blob into two droplets. It
instead flags suspicious merged components as a separate, lower-confidence diagnostic category
(`DeferredOverlapRegion`, surfaced by the CLI overlay in orange) and stops there:

- a component is only considered a possible overlap once its area is clearly larger
  (`>= 1.45x`) than this image's own dominant single-droplet area, so an ordinary standalone
  droplet is never miscategorized;
- both its width and height are bounded to a plausible two-droplet footprint
  (`<= 2.3x` the dominant droplet's own median width/height), so wide UI chrome (a MAP/SAT
  control, which can be "big enough" by area alone) does not get flagged as a possible overlap
  just because it is large.

This heuristic is deliberately conservative and unverified against a real merged-droplet
fixture (none was available in this repo at implementation time; the only recorded example is
the coordinate data in the original handoff's `droplets.json`, not a checked-in image) — it is
a diagnostic surface, not a claim of detection accuracy for the merged case.

### Why not just split it now

A theoretically appealing follow-up, explicitly out of scope for this task:

1. learn the canonical single-droplet geometry (already partially available via the bundled
   glyph templates and the dominant-cluster size this detector already derives per image);
2. for a detected droplet A, enumerate plausible relative positions where a second overlapping
   droplet B could exist, given how UDisc renders overlapping pins;
3. search those constrained positions for the expected blue core / interior glyph evidence;
4. only split the merged component when that evidence is strong, otherwise leave it as one
   deferred region.

### Open questions

- What does a real overlapping-droplet screenshot actually look like at the pixel level? The
  only evidence available during this implementation was the original handoff's coordinate
  benchmark (`{x: 383, y: 705, width: 60, height: 50}` at medium scale) — a real image is
  needed before attempting a split heuristic.
- Is the merge always exactly two droplets, or can three+ putts stack in the same spot on a
  bad hole? The enumeration-of-plausible-positions approach above assumes pairwise splitting.
- Should a resolved split still carry a lower confidence than a genuinely standalone detection,
  even once evidence is strong? The current `LandingMarkerCandidate` shape has no field for
  "this tip was recovered from a merge," and would likely need one.
