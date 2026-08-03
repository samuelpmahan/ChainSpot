# P0-012: Diagnostics, magnifier, and completion guidance

## Status

`open`

## Objective

Give users proportionate precision aids and non-blocking feedback for creating trustworthy correspondences without estimating alignment.

## Why this exists

The detailed Phase 0D milestone requires a magnifier and point-distribution diagnostics, while the workflow requires clear completion-state guidance and warnings for incomplete or poorly distributed point sets.

## Scope

- Add a compact magnified preview around the pointer or selected marker using original image pixels where practical, with an exact anchor crosshair.
- Show complete-pair count and transient incomplete/pending-pair count.
- Show simple readiness text for the minimum count needed by a future similarity or affine registration, without calculating any transform or residual.
- Compute non-blocking warnings for tightly clustered landmark coverage in either image and near-duplicate points within one image.
- Show incomplete-pair warning/guidance while a pending source point exists, with clear complete-or-cancel actions in the correspondence workflow.
- Refine marker visuals so ordinal, precise anchor, selected/disabled/pending distinctions, and hit target remain readable over bright and dark fixture imagery.
- Keep all diagnostics derived and informational; they must not mutate, disable, or reject otherwise valid pair data.

## Out of scope

- Registration estimation, residuals, confidence scoring, outlier detection, feature matching, image-content inspection, or automatic landmark suggestions.
- A generalized analytics/diagnostic framework.
- Requiring a specific point distribution or blocking save because points are clustered.

## Dependencies

P0-008, P0-009

## Requirements

- The magnifier must identify the exact stored/candidate anchor and must not substitute downscaled screen pixels when original decoded pixels are available.
- Counts must distinguish complete durable pairs from the current transient pending half-pair.
- Readiness language may use only pair counts (for example, two for future similarity and three for future affine); it must not claim that points are geometrically suitable or aligned.
- Coverage/near-duplicate thresholds must be simple, deterministic, documented, and unit-testable.
- Warnings guide but never block pair creation, editing, export, or import.
- Marker styling must retain a screen-constant visual size and a smaller exact anchor at all supported zoom levels.

## Implementation notes

Use normalized bounding-box/span statistics or another equally small deterministic measure for coverage. Use simple image-space distance for near duplicates. These are diagnostics over existing coordinates, not a precursor registration engine. Avoid spatial indexes or CV dependencies for 3–10 pairs.

## Acceptance criteria

- [ ] The magnifier shows original image detail and an exact crosshair for pointer placement/selected correction.
- [ ] Complete and pending counts update correctly through add, cancel, complete, delete, undo, and redo.
- [ ] Readiness copy changes at the documented pair-count thresholds and never reports an estimated transform.
- [ ] Clustered and near-duplicate fixtures trigger deterministic, non-blocking warnings; distributed points do not.
- [ ] Pending state produces clear completion/cancel guidance and cannot be mistaken for a saved complete pair.
- [ ] Marker ordinals, anchors, and pending/selected/disabled states are readable over representative bright and dark areas at multiple zooms.
- [ ] Diagnostics never mutate domain state or dirty/history state.

## Test requirements

- Unit-test count/readiness derivation and diagnostic thresholds at boundary cases.
- Component-test diagnostics through add/cancel/delete/undo/redo transitions.
- Test that warning calculation leaves domain state and history unchanged.
- Test magnifier source sampling/coordinate calculation against known fixture pixels where stable.
- Test marker size/anchor distinction across zoom levels and state variants.

## Manual verification

Use the magnifier to place and correct markers on fine landmarks at low and high view scales. Confirm bright/dark imagery remains readable and diagnostic wording does not imply registration has occurred.

## Deliverables

- Magnifier/precision preview integrated with each image pane.
- Small derived diagnostic functions and guidance UI.
- Marker visual quality adjustments and focused tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
