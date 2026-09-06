# DashsTrack ternary edge sensing — first experiment

The experiment gives each reader a material judgment: EDGE, RIBBON, TERRAIN, or unresolved UNKNOWN. This is fixed-heading sensing; it has not changed steering or demonstrated Badge-to-C2 tracking.

## What ran

All 18 saved Tee-to-Badge initial rays: 904 cross-sections, 82,264 reader positions. Every transverse RGB profile is sampled once and reused by the sensing comparisons. The profile observation is finite and declared; fitted interval width is not forced to 40 or 50 pixels.

A-live compares the two samples around a reader against the current central-band RGB median and distant flank RGB median. A-frozen uses the first exposed central reference at or beyond distance 30 instead. B fits left-flank / interior / right-flank RGB means with two movable transitions, minimizing residual squared color differences. Uniform, missing, weak-contrast, clipped, or monotone-gradient-like fits can return UNKNOWN. Margins and fit residuals are measurements, not probabilities.

## Source-visible result

At H18 distance 70, both expected edge readers straddle ribbon boundaries. At distance 130, the original left reader lies inside ribbon and the right lies on terrain: all three comparisons identify that distinction. At distance 180, the original center has also drifted onto terrain. A-live then wrongly labels the right reader RIBBON; A-frozen and B retain TERRAIN there.

The narrow B viewing window also produces a wrong 20 px interior patch at H18 distance 180. A separate wider-window ablation produces a 54 px candidate spanning more of the ribbon. Neither result is a verified physical width; these are transverse slices along a frozen initial heading.

On 14 source-inspected reader positions fixed before reviewing outputs, A-live matches 11 and mismatches 3; A-frozen matches 12 and mismatches 2; B matches 12 and returns 2 UNKNOWN. This is a tiny illustrative inspection set, not corpus accuracy. The two A failures shared by both versions are the left edge of straight H16 at distance 30 and 60. B returnsUNKNOWN on both H16 readers at 60 because its fitted regional means resemble a monotone terrain gradient. The source nevertheless shows a ribbon boundary, so this is an unresolved real-case failure.

## Reproduction and limitations

Use the named experiment entry under ternary-edge/exp/ternary-edge. The actual archived ABFeatureSet gateway invokes the Python sensing producer inside the operation, with exact declared/actual slot custody; disabling the feature performs zero operations. Raw trace, synthetic cases, execution receipts, images, code and source inputs are bundled.

Source coordinate frame is original 1290 × 2091 pixels. Seed provenance remains disclosed: most Tees come from saved detections; H3/H5/H12 use annotated diagnostic Tee seeds. Badge centers come from observed dark plate components. No bends or Basket endpoints enter the sensing producer. Badge occlusion is modeled, while Basket glyph and range-circle ownership remain unmodeled. Fixed observation margins and prototype acceptance thresholds are recorded in trace.params.

Figures in this directory consume the saved trace. H18-ternary-comparison.png shows material states at 70/130/180. H18-window-comparison.png shows the two fitted intervals at 180. H18-raw-samples.png and straight-source-samples.png show independent source-inspection locations. source-check-results.json retains every inspected match and mismatch.
