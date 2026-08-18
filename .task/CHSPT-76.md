# CHSPT-76 — Pairwise semantic translation voting from UDisc landmarks

## Goal
Consume CHSPT-75 badge/basket source landmarks and solve pairwise source translation by same-family offset-vector voting, with explicit support, residual, family-diversity, and ambiguity diagnostics.

## Required behavior
- Form hypotheses only between matching landmark families.
- Cluster pA-pB translation votes and enforce independent one-to-one correspondence support.
- Report winner translation, inlier count, family diversity, RMS residual, runner-up, ambiguity margin, vote count, and point-arithmetic runtime.
- Require at least two independent correspondences by default; preserve abstention for unsupported or competitive repeated-UI hypotheses.
- Provide a code-rendered coincidence overlay without changing production stitch behavior.

## Non-goals
- No image compositing loop and no production pose-graph mutation.
- No requirement that CHSPT-75 detection be perfect; fixture/truth observations remain valid inputs.
- No badge identity or semantic hole labels.

## Known context
- Reuse CHSPT-75 SemanticSourceLandmarks exactly.
- Current OpenCV real-capture acceptance checks assignN against independently established ground truth within 4 px per axis; that remains the comparison baseline, not code to rewrite.
- The same branch remains based on prestaging/demo @ ba59447ac20dd6b680d627c37a561638956d7c3d by explicit task instruction.

## Acceptance
- Reusable pairwise semantic translation result with full ambiguity diagnostics.
- Two independent same-offset observations can verify translation; one observation abstains.
- Combining badge + basket evidence is measurable independently from each family alone.
- Diagnostic overlay can show B correspondences mapped into A space under the winning transform.

## Proof Plan
- Unit-test exact recovery with repeated same-family distractor pairings present.
- Unit-test one-correspondence abstention.
- Run detector-backed point voting over deterministic overlapping crops of a real UDisc raster with exact crop-offset ground truth; record transform error and pairwise runtime separately from localization.
- Compare badge-only, basket-only, and combined-family acceptance on the same crop pairs.
- Keep current cvMatch/poseGraph callers untouched and compare against the existing real-capture OpenCV acceptance contract rather than changing it.
