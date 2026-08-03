# P0-008: Point selection and precision correction

## Status

`open`

## Objective

Let users select either side of a pair and correct its authoritative pixel location by drag, keyboard nudge, or exact coordinate entry.

## Why this exists

Trustworthy correspondences require correction methods that remain accurate at every zoom level. The detailed plan requires dragging, one- and ten-pixel keyboard nudges, exact pixel entry, selection, and bounds protection.

## Scope

- Support selecting a pair and a specific source/target marker from the canvas, with a clear selected state.
- Make markers draggable without triggering empty-canvas pan.
- Convert drag positions through the inverse view transform and commit a single domain move when the drag completes.
- Provide exact `xPx`/`yPx` editing for the selected marker.
- Support Arrow keys for one original-image-pixel movement and Shift+Arrow for ten pixels.
- Prevent marker shortcuts while a text input or other editable control has focus.
- Apply the shared bounds policy to drag, nudge, and exact entry, with visible rejection of invalid numeric input.
- Synchronize selection primitives needed by the point list in P0-009.

## Out of scope

- Labels, reorder, enable/disable, pair deletion, overlay visibility, magnifier, subpixel keyboard modifiers, or multi-selection.
- Snapping, automatic landmark refinement, pixel-content analysis, or registration residuals.
- Saving drag-preview frames into undo history.

## Dependencies

P0-003, P0-004, P0-006, P0-007

## Requirements

- Selection must identify both the stable pair ID and active side.
- Dragging at any zoom/pan must update original-image coordinates, not stage/screen coordinates.
- One completed drag must be one undoable history step.
- Keyboard movement is measured in original pixels regardless of zoom or device pixel ratio.
- Numeric entry must accept valid fractional coordinates because the model permits them.
- No correction method may store a point outside `[0,width) × [0,height)`.
- Selected state must remain visually distinguishable over the image and across view changes.

## Implementation notes

Use transient drag preview if needed for responsiveness, then commit once through the domain action. A small inspector near the point list/workspace is sufficient; do not build a form framework. Keep focus checks based on standard browser semantics.

## Acceptance criteria

- [ ] Clicking either marker selects the correct pair and side and displays a distinct selected state.
- [ ] Dragging at 50%, 100%, and 200% view scale commits the expected original-image coordinate.
- [ ] Arrow and Shift+Arrow move exactly one and ten original pixels respectively.
- [ ] Keyboard nudging does not fire while editing text/numeric fields.
- [ ] Valid exact pixel input moves the point; invalid, non-finite, and out-of-bounds input preserves the previous point and explains the problem.
- [ ] Marker drag does not pan the pane and commits one undoable history entry.
- [ ] Undo and redo restore all correction methods exactly.

## Test requirements

- Integration-test marker selection and source/target side identity.
- Test drag conversion after pan, at 200% zoom, and after combined pan/zoom.
- Test one-step drag undo/redo and ensure intermediate pointer moves do not create history entries.
- Test Arrow/Shift+Arrow deltas, edge bounds, and text-field shortcut suppression.
- Test fractional exact entry and invalid/out-of-bounds rejection.
- Test navigation still pans only from empty canvas.

## Manual verification

At several zoom levels, drag and nudge markers onto recognizable pixel landmarks and confirm the anchor, selected appearance, and exact-coordinate fields agree.

## Deliverables

- Marker/side selection and selected-state rendering.
- Drag, keyboard nudge, and exact-coordinate editing paths.
- Focus and bounds handling with focused tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
