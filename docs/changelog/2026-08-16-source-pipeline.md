# 2026-08-16 — Source pipeline changelog

## Unified import and stitch flow

Importing screenshots is now one flow regardless of count: pick captures, AutoCrop runs, AutoStitch runs too if there's more than one, and the assembled result appears immediately with no forced review or approval click in between. A single capture gets AutoCrop only. A high-confidence result proceeds straight through; a weak or ambiguous one still shows its best assembled result but visibly flags itself for review rather than looking indistinguishable from a confident one. The old mandatory crop-review and "Approve crop and assemble" steps are gone from the happy path — they're still available, along with pixel-level detail, behind "Adjust manually" for anyone who wants them. No original capture is ever discarded, even after cropping or stitching.

## Rotated and irregular capture layouts

Stitch Map no longer assumes captures form a straight grid or share a pure left/right, up/down offset. Placement is now solved from whatever overlap the captures actually share, and only reaches for rotation or independent-axis scaling when the evidence genuinely calls for it — an ordinary flat grid of screenshots is placed exactly as before. When a capture set's overlaps genuinely don't agree with each other, Stitch Map now says so and stops rather than forcing a plausible-looking but wrong stitch.

## Capture provenance

Every stitched result now carries a real record of how it was built: each original capture's identity and hash, its crop, the transform that places it into the final image, and whether that crop and that placement were auto-detected or hand-adjusted. This record survives saving, reopening, and exporting, and can be used to reconstruct or re-render a composite later from its originals. A composite with missing or self-contradictory provenance is now rejected outright instead of silently accepted.

## Manual correction safety

"Apply adjustments" in Stitch Map's manual-correction surface no longer does anything if nothing was actually changed this session, so an idle click can't silently re-render the result. If a capture in the current result was auto-aligned with rotation, a clear warning now appears before applying, since manual adjustment can currently only reposition tiles and would straighten that rotation back out.

## Annotate Course keyboard review

Undo and redo (Ctrl-Z, Ctrl-Shift-Z / Ctrl-Y) now behave like a normal editing history instead of a one-way stack, so redo works correctly after an undo instead of being unavailable. Fixed a bug in the keyboard review flow where rejecting a proposal with X could remove the wrong bend — a manually-added one — instead of the auto-proposed one actually being reviewed.

## Rendered-sprite pose lookup

Locating where a detected marker (a hole-number badge, or similar) actually sits — which original capture it came from and where on that capture — now works for any capture layout, not just the original fixed grid. Basket-number detection is the first thing built on top of this general lookup, not a special case baked into it.
