# Clean-course tee bootstrap policy

ChainSpot should bootstrap a new course from a clean UDisc-style overview (or reuse Course Memory for a previously seen course). Played-round screenshots with shot/walk overlays are not the raw-course discovery contract.

Tee bootstrap deliberately separates **pad existence** from **pad ownership**. The old production path blurred those questions: weak course-grammar ownership triggered a hole-specific occluded-pad search, then another global assignment pass could cascade one bad guess through unrelated holes. The production path now evaluates evidence before grammar sees a tee.

## Evidence

### Pad appearance

- **strong** — independent primary tee detectors agree on the same physical pad.
- **weak** — only one detector supports the location, including the generic `template-search` path used for heavily occluded pads.

Weak does not mean wrong. It means the location needs human confirmation before it becomes course memory.

### Orientation

Pad orientation is measured with rotation-swept hollow-pad NCC.

- score `< 0.30`: **unmeasurable**
- score `0.30–0.40`: **weak**
- score `>= 0.40`: **strong**

Pad template size is **world-scaled**, not UI-scaled. Production derives a robust size bank from the course's tee-candidate population; it does not contain GoldenTeeSet/AlexClark/phone-resolution pad-size constants.

### Badge ownership

For a measurable pad, the major axis is compared with every visible number badge. A badge is compatible when the pad axis intersects the badge body; the nearest compatible badge wins only when it is clearly separated from the next compatible badge.

The badge is the ownership target because the physical regularity is the initial throw/fairway line: where badge and basket bearings diverge, measured pads track the badge.

Ray agreement is a strong prior, **not a sufficiency proof**. With enough random candidate peaks, some wrong locations align by chance.

## Decision ladder

| Pad appearance | Orientation | Badge ownership | Decision |
|---|---|---|---|
| strong | strong | unique + strong | **AUTO** |
| weak/occluded | strong | unique + strong | **REVIEW** |
| strong | weak/unmeasurable | clearly separated nearest badge | **REVIEW** |
| strong | strong | ambiguous competing badges | **REVIEW** |
| weak | unmeasurable | none/ambiguous | **UNRESOLVED** |
| any | measurable | no badge-body intersection | **UNRESOLVED** |

A close competing tee candidate downgrades an otherwise-AUTO result to REVIEW. Once at least four AUTO holes establish a trustworthy course baseline, measured REVIEW candidates must also fall inside a robust tee-to-badge distance band learned from those AUTO holes; distant accidental ray matches are suppressed back to UNRESOLVED. The system never forces every hole to own a tee just to complete an 18-way assignment.

## Generic weak-pad discovery

After the normal generic tee pool is assessed, unresolved badges receive one generic second pass:

1. derive pad world scale from the existing candidate population;
2. derive a robust tee-to-badge distance band from already-owned pads on this course;
3. search that learned annulus with the pad template constrained to point toward the badge;
4. emit the best measurable proposal as `template-search` support;
5. reassess the full candidate pool through the same policy.

`template-search` is always weak appearance evidence, so this path can create a **REVIEW** proposal but can never create **AUTO** by itself. This is the generalized handling for cases such as GoldenTeeSet H5 and the visually obscured H3 class: useful proposal, no fabricated certainty.

## Grammar boundary

AUTO and REVIEW assignments carry their explicit `holeNumber` into course grammar. Grammar may leave an owned tee unassigned, but it may **never reassign that tee to another hole**. REVIEW assignments also remain below the ready threshold even if downstream distance/polarity geometry looks excellent.

This prevents the previous failure mode where one missing pad caused a forced one-to-one ownership cascade across the course.

## Current two-course production probe

On the branch that introduced this policy:

- **GoldenTeeSet:** 14 AUTO, 4 REVIEW, 0 UNRESOLVED. All 14 AUTO tee locations are correct against labeled truth. H5 is recovered as a correct REVIEW proposal without any H5-specific search rule; 3/4 REVIEW locations are correct, with the remaining wrong H3 proposal intentionally kept out of AUTO.
- **AlexClark:** 12 AUTO, 2 REVIEW, 4 UNRESOLVED. All 12 AUTO tee locations are correct against labeled truth. The distance-band refinement suppresses the earlier implausibly distant review proposals instead of manufacturing coverage.
- Across both labeled courses, **AUTO precision is 26/26 with zero false AUTO assignments** in this probe. REVIEW is explicitly allowed to be wrong; its purpose is to narrow human correction, while UNRESOLVED is preferred over a low-evidence guess.

These counts are review-policy outcomes, not a new tee merge gate. Tees remain non-gating while the bootstrap/editor workflow is still being integrated.
