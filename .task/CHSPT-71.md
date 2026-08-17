# CHSPT-71 — Register a held played round to the clean course

## Goal

Give an operator a trustworthy, correctable workflow for registering the held played-round screenshot to the already-annotated clean UDisc course, with a composed proof on the clean target when its existing registration is usable.

## Required behavior

- Open registration from the held thrown-round state without replacing the clean course or clean target.
- Show played-round and clean-course registration surfaces using the established correspondence interaction grammar.
- Support similarity and affine estimation, full pair correction/enable/delete behavior, actionable residual quality, and explicit confirmation.
- Update played-to-clean and composed clean-target previews live after every relevant correction.
- Hand a confirmed, usable played-to-clean registration to extraction while keeping later correction possible.

## Non-goals

- Landing/path extraction, hole assignment, or shot ordering.
- Broadcast graphic design or Gate 3 work.
- GPS, native iOS, UDisc integration, or a general registration-framework rewrite.
- Replacing the clean course or clean target with the played screenshot.

## Known context

- `ThrownRoundSource` from CHSPT-65 is a distinct active session input and currently appears only as a note in Create Graphics.
- Existing clean-course to target correspondence is stored in `ProjectState.controlPointPairs` and must remain unchanged.
- The new transform direction is played-round pixels to clean-course pixels. Target proof composes that result with the existing clean-course to target transform.
- Existing `ImageViewport`, pair management, alignment estimators, residual validation, and ghost-course preview are the preferred interaction primitives.
- Current `main` is `4da01fba601a250e2fd4e7b8683c9fdd6bf0401b`.
- This corrective candidate intentionally starts from unmerged `integration/demo@fd8b57f`; the reproduced failures cross the Gate 1/Gate 2 integration seam and cannot be repaired or proven from `main` alone.
- Browser review reproduced a mounted-component lifecycle defect: replacing either registration input can leave the old decoded image, pairs, and confirmation state alive behind the newly displayed parent image.
- Detector-derived accepted shots contain no registration provenance by design. Until reprojection lineage exists, a changed registration must require an explicit operator decision before a new fit can drive extraction.

## Acceptance

- A real played-round fixture can be registered manually to its clean course.
- Invalid or visibly poor registration is actionable rather than silently accepted.
- Disabled/deleted/corrected pairs update both intermediate and composed previews immediately.
- Confirmation produces the small Gate 1/2 handoff without mutating accepted round semantics.
- Browser/manual proof exercises the complete workflow and a meaningful bad-registration correction.

## Proof Plan

- Unit-test the played-to-clean registration state, validity rules, pair invalidation, transform composition, and proposal invalidation boundary.
- Add a browser scenario that enters from a held thrown round, places spread landmarks, observes live played-to-clean and target proof, corrects a bad pair, and confirms.
- Re-run existing correspondence, alignment, target-rotation, CHSPT-65 handoff, and registration-preview coverage at focused scope.
- Inspect the running UI at a realistic desktop viewport; unit/type checks cannot prove pointer usability or preview legibility.
- Record any reload/persistence limitation explicitly; do not imply session retention is durable save/open persistence.
- Reproduce input replacement while registration is closed, then prove the next open remounts both surfaces and invalidates the old confirmation before exposing the replacement.
- Accept detector proposals, change the registration, and prove reconfirmation cannot silently coexist with throws mapped by the obsolete transform; the MVP flow must explicitly discard those session-tracked detector throws or leave extraction blocked.
