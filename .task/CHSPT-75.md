# CHSPT-75 — Pure-TS UDisc landmark localization before OpenCV

## Goal
Build and measure a deliberately small, source-space, OpenCV-free localizer for physical UDisc badge bodies and basket sprites, with batch-level family consensus suitable for semantic stitch seeding.

## Required behavior
- Scan RGBA source rasters with ordinary TypeScript/JavaScript raster operations only.
- Keep badge and basket families separate and return compact source-space point/geometry observations.
- Learn robust family geometry across the intake batch so a source containing one landmark can inherit scale evidence from other sources.
- Report explicit family abstention instead of manufacturing a landmark family without batch support.
- Preserve the result shape for direct reuse by CHSPT-76 translation voting.

## Non-goals
- No badge identity, hole ownership, tee ownership, course grammar, or Annotate Course handoff.
- No OpenCV invocation and no production stitch behavior change.
- No attempt to replace the full Pancake raw-object pipeline.

## Known context
- Explicit task exception: this three-ticket research thread is based on prestaging/demo @ ba59447ac20dd6b680d627c37a561638956d7c3d, as requested, despite the normal workflow rule against staging-derived task branches.
- rawObjectMask.ts already proves useful bright/dark masks, connected components, and repeated-size family geometry; this task reuses only the small stitch-relevant ideas.
- CHSPT-76 and CHSPT-77 must reuse this exact landmark representation, fixtures, overlays, and timing seam.

## Acceptance
- Reusable source-landmark batch result with badge/basket geometry and robust scale estimates.
- Batch-level consensus allows a one-landmark source to participate when the family is established elsewhere.
- Explicit no-candidate / insufficient-consensus abstention behavior.
- Real-raster timing and diagnostic overlays can be generated without OpenCV.

## Proof Plan
- Unit-test batch consensus with a multi-landmark source plus a one-landmark source, and prove the latter is retained only because the family is established across the batch.
- Unit-test abstention when a whole batch has only one family candidate.
- Measure the implementation on the real uploaded UDisc full-course rasters and inventory accepted badge/basket counts plus robust scale estimates.
- Render source-space diagnostic overlays and visually inspect for badge/basket false positives; use exact-dimension annotations where available as basket recall controls.
- Keep all production stitch callers untouched so tests cannot accidentally prove a behavior mutation that this ticket forbids.
