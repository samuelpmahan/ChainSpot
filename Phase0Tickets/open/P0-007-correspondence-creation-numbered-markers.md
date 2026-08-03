# P0-007: Correspondence creation and numbered markers

## Status

`open`

## Objective

Implement an explicit, unambiguous source-then-target workflow that creates complete numbered control-point pairs.

## Why this exists

Phase 0 must prevent accidental or ambiguous half-pairs. Users need clear guidance and matching visual numbers while all stored coordinates remain in original image space.

## Scope

- Add the explicit Add correspondence action, enabled only when both images are valid.
- Implement transient selection, add-source, and add-target states, using single-entry mode as the Phase 0 default.
- Prompt for a source/UDisc landmark, then the same target/clean-map landmark.
- Convert clicks to bounded original-image coordinates before changing state.
- Show a temporary source marker with the next ordinal while the target side is pending.
- Commit one complete pair through the domain action only after the valid target click.
- Render matching numbered markers for every complete pair in each pane, with a precise anchor, screen-constant readable symbol, and larger hit target.
- Cancel a pending half-pair with Escape or an explicit cancel control without changing durable history.

## Out of scope

- Repeated-entry mode, arbitrary side-first creation, incomplete-pair persistence, labels, dragging, numeric editing, registration, or point suggestions.
- Magnifier and final contrast/accessibility polish, which belong to P0-012 and P0-013.
- DOM elements positioned over the canvas as markers.

## Dependencies

P0-004, P0-005, P0-006

## Requirements

- A user must explicitly activate Add correspondence before image clicks create points.
- The order is source then target; a second source click while target is pending must not create or replace a point.
- Cancellation is explicit and leaves durable project state, undo history, and dirty state unchanged.
- A valid target click completes exactly one pair and returns to selection mode.
- Pending state must be visibly distinguishable from a completed pair.
- Pair IDs remain stable and ordinals are shared across the two markers.
- Marker anchors are image-space scene objects; their visible size/hit area remains usable as zoom changes.
- Clicks outside original image bounds do not create points.

## Implementation notes

Keep the add state machine in transient editor state and test it separately from rendering. Use the interaction layer for background pointer handling and the control-point layer for markers. Do not persist a pending pair in a normal project document.

## Acceptance criteria

- [ ] Add correspondence is unavailable until both images are loaded.
- [ ] Activating Add produces clear source guidance; a valid source click produces one pending numbered marker and target guidance.
- [ ] Additional source clicks cannot create an ambiguous second source point while target is pending.
- [ ] A valid target click commits exactly one complete, matching numbered pair and returns to selection mode.
- [ ] Escape and explicit cancel remove the pending marker without a domain/history change.
- [ ] Out-of-image clicks are ignored or explained without creating invalid state.
- [ ] Markers remain anchored and screen-legible through pan and zoom, and are Konva scene objects rather than persistent/DOM overlay state.

## Test requirements

- Unit-test every state transition, invalid-side click, cancellation path, and single-entry completion.
- Component-test Add gating and exact source/target guidance.
- Add a pair through clicks and assert original-image coordinates, stable ID, shared ordinal, and exactly one history entry.
- Test a second source click during pending state and clicks outside image bounds.
- Test Escape cancellation leaves domain data, dirty state, and history unchanged.
- Test marker visible size is screen-constant across at least two zoom levels while its anchor follows image coordinates.

## Manual verification

Create several pairs on differently scaled images and confirm the prompts, pending state, marker numbers, hit targets, and return to selection mode are unambiguous.

## Deliverables

- Add-correspondence controls and transient state machine.
- Pending and complete marker rendering in the existing scene.
- State-machine and component/integration tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
