# White-frame map-scale anchor — findings

**Question**: tee detection's tuned constants are `X / 1.77 * uiScalePx`, but
`uiScalePx` is badge-derived and badges are fixed-size UI chrome — so the
constants are world measurements frozen at IMG_5641's map zoom, and they
collapse on captures at other zooms (the stitched demo: baskets 18/18, tees
0/18 past the 60% floor). Can we measure map zoom per image directly, without
assuming anything about how UDisc scales any UI element?

**Anchor**: tee pads themselves, detected as white rectangular **frames**
(bright rim enclosing a darker interior hole) — `white_rect_scale_probe.py`.
Gates are all unitless (rectangularity, aspect band, hole fraction, interior
median brightness), so the same gates hold at any zoom. Requiring an enclosed
hole rejects C2 putting-circle dashes, path dashes, and parking stripes;
requiring a mid-gray interior rejects number badges (near-black interior),
which otherwise collide with pad sizes on stitched captures.

**Result** (2026-08-13):

| capture | frames found | median major px | spread |
|---|---|---|---|
| IMG_5641 (1290×2091) | 8 | **30.4** | 30.2–32.4 |
| ReferenceStitch (2359×3916) | 9 | **56.0** | 55.0–63.3 |

- Measured ratio **1.842**; predicted terrain ratio from image geometry
  (2359/1290, same course width) is **1.83**. Match.
- Renders eyeballed per the repo's probe rule
  (`white-rect-scale-{IMG_5641,ReferenceStitch}.png`): every kept frame is a
  genuine tee pad on both substrates; zero false positives. Badge frames
  appear at ~53px in BOTH images (UI-scaled, unchanged by zoom) and are fully
  rejected by the interior-brightness gate — the two-scale story in one
  artifact.
- 8–9/18 pads found per image (occluded/faint pads drop out) — fine for a
  median anchor; the surviving cluster is tight (CoV ~2%).

**Proposed use**: `worldScale = medianFrameMajorPx / 30.4` (exactly 1.0 on
IMG_5641, so all current tuning reproduces unchanged), applied to
pad-GEOMETRY constants only; stroke/dash/UI constants stay on `uiScalePx`.
Not yet wired into production — this doc records the validated anchor only.

## Frozen-detector world-normalization diagnostic (2026-08-13)

The decisive test: downsample ReferenceStitch by the measured world ratio
(30.4/56.0 = 0.543 → 1281×2126, INTER_AREA), then run the EXACT frozen
detector (`detect-course.ts`, `--ui-scale 1.77` to pin the tuned constant
regime) with zero tuning changes:

| run | baskets | tee assignments | tees ≥0.6 conf | tee confidences | elapsed |
|---|---|---|---|---|---|
| native stitch (2359×3916) | 18/18 | 13 | **0** | all capped 0.49 | 52.7s |
| world-normalized (1281×2126) | 13/18 | 10 | **8** | 0.91–0.98 (×8), 0.49 (×2) | 14.9s |

- **0 → 8 auto-accepted tees at 0.91–0.98 with no detector change.** The
  0/18 collapse was one global scale variable, not 18 independent
  appearance failures. Detector tuning was never the problem.
- **Baskets regressed 18 → 13 on the normalized raster** — the downsample
  blurs the UI-scaled basket icons. UI elements (badges, basket icons) must
  keep detecting on the NATIVE raster; only the tee stage should run on the
  canonical-world-scale raster. The remaining tee gap (8 vs ~17) is mostly
  downstream of those 5 lost basket anchors in the grammar, plus resize blur.
- Free perf win: the tee stage on the normalized raster ran **3.5× faster**
  (smaller pixels to chew). Canonical rescaling is a speedup, not a cost.

**Production shape this implies**: measure world scale first (white-frame
pads and/or C1 putting-circle radius), gate every world-scaled stage on it:
native raster → UI detection (badges/baskets) → worldScale estimate →
tee detection on canonical-rescale crops → coordinates mapped back.
Appearance profiles (far/medium/close), if UDisc's rendering ever changes
qualitatively with zoom, should be selected by measured world scale — never
by image size.

Note on the synthetic scale-sweep guardrail: it scales raster and uiScalePx
TOGETHER, which proves the math is scale-relative but not that the live
pipeline estimates a genuinely different-zoom capture's world scale. This
diagnostic is the missing half.
