# ChainSpot CV templates

Template assets created/used during the CV probe work.

Included:
- `manifest.json` — semantic calibration metadata and the authoritative template asset list.
- `hole-01.png` ... `hole-18.png` — UDisc hole-number badge templates.
- `basket.png` — UDisc basket glyph template.
- `landing-pin-a.png`, `landing-pin-b.png` — experimental played-round landing-marker templates.
- `landing-pin-mask.png` — mask used with the landing-pin templates.
- `round-landing-glyph-c1.png`, `round-landing-glyph-c2.png`, `round-landing-glyph-off-fairway.png`
  — canonical interior-glyph templates for the production round-marker classifier
  (`src/lib/autoAnnotation/landingDropletDetection.ts`). Each is a 28x28 binary mask (white =
  glyph, black = background) generated from a real, hand-labeled UDisc round screenshot by
  `scripts/generate-landing-droplet-templates.ts` — not learned at runtime, and unrelated to
  the `landing-pin-*` files above (which are an earlier, different experiment).

## Calibration invariant

The PNGs retain their native crop dimensions and **must not** define canonical UI geometry.
`manifest.json` independently defines the canonical number-badge geometry used to convert a
matched badge's physical dimensions into `UiScalePx` (currently 30×23). A template's resize
multiplier is `TemplateScale`; it is not interchangeable with `UiScalePx`. The manifest also
records the measured `basketTemplateScalePerNumberTemplateScale` relationship between the
independently branded number and basket template families. The conversion is applied through
the typed calibration helper, rather than being embedded in a detector.

This separation is intentional: replacing or recropping a template may change its native raster
size and `TemplateScale` without silently changing tee-pad, mask, circle, or other UI-relative
geometry.

Not included:
- teepad templates: the successful teepad detector does not use a fixed raster template; it
  fuses gray-center rectangle and edge-loop / bright-rim geometry detectors.
- putting-circle templates: C1/C2 radii were detected from repeated basket-centered radial edge
  structure rather than fixed image templates.

These are R&D fixtures/templates derived from the screenshots used in the ChainSpot CV work.
