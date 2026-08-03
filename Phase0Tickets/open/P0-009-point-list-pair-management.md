# P0-009: Point list and pair management

## Status

`open`

## Objective

Provide one inspectable list for selecting, labeling, reordering, enabling/disabling, hiding, and deleting control-point pairs.

## Why this exists

Phase 0 output must be durable and editable rather than only visual. The detailed plan requires native and normalized coordinate inspection plus pair label, order, enabled, delete, selection, and marker-visibility controls.

## Scope

- Build a point-pair list/sidebar showing ordinal, optional label, enabled state, source and target native pixel coordinates, and derived normalized coordinates.
- Synchronize list selection with the canvas pair/side selection and exact-coordinate inspector.
- Add inline pair-label editing.
- Add explicit pair reorder controls suitable for keyboard and pointer operation; regenerate ordinals while preserving IDs.
- Add pair enable/disable and pair deletion through domain actions.
- Support Delete/Backspace for a selected pair where safe, while protecting text-editing contexts and providing an accessible visible delete control.
- Add a transient hide/show control for all marker overlays without modifying pair data or dirty state.
- Wire visible Undo/Redo controls and conventional platform keyboard shortcuts to the domain history.

## Out of scope

- Drag-and-drop list sorting, bulk actions, folders, arbitrary annotation metadata, filtering, registration outlier logic, or inferred labels.
- Persisting marker-overlay visibility or selection.
- Diagnostic readiness/coverage warnings and magnifier, which belong to P0-012.

## Dependencies

P0-004, P0-007, P0-008

## Requirements

- Native coordinates must reflect authoritative pixels; normalized coordinates must be derived using each referenced image's intrinsic dimensions.
- List and canvas selection must identify the same stable pair and, where relevant, side.
- Label edits, enable/disable, delete, and reorder must be undoable/redoable and set dirty state.
- Reorder changes presentation ordinals consistently in both list and markers but never changes stable IDs or coordinates.
- Disabled pairs remain visible and editable with a distinct state; disabling does not calculate or preview registration.
- Hiding overlays affects rendering only and must not change domain state, history, or dirty state.
- Keyboard shortcuts must not trigger destructive/editing operations from text fields.

## Implementation notes

Use simple up/down reorder controls rather than a sorting dependency. Format displayed coordinates consistently without rounding stored values. Keep the list as the accessible non-canvas management surface for all pairs.

## Acceptance criteria

- [ ] Every complete pair appears once with ordinal, label, state, native coordinates, and normalized coordinates for both sides.
- [ ] Selecting from the list highlights the corresponding canvas markers, and canvas selection highlights the list entry.
- [ ] Labels can be added, changed, cleared, undone, and redone.
- [ ] Reorder updates list/marker ordinals but preserves IDs and coordinates through undo/redo.
- [ ] Enable/disable and delete operate through domain actions and are reversible.
- [ ] Visible and keyboard delete paths are safe around editable controls.
- [ ] Overlay hide/show removes/restores markers without altering project data, history, dirty state, or selection identity.
- [ ] Visible Undo/Redo controls and documented shortcuts reflect whether each action is available.

## Test requirements

- Component-test list rendering and native/normalized values for differently sized images.
- Test bidirectional list/canvas selection.
- Test label, reorder, enable/disable, and delete with undo/redo and dirty-state assertions.
- Test ID stability and ordinal regeneration after multiple reorders.
- Test Delete/Backspace and undo/redo shortcut suppression in editable fields.
- Test overlay visibility is transient and history-neutral.

## Manual verification

Manage 3–10 pairs using both canvas and list, including keyboard-only reorder/delete/undo/redo, and confirm numbers and selection remain synchronized.

## Deliverables

- Point list/sidebar and compact pair-management controls.
- Undo/redo UI and shortcut integration.
- Pair-management component/integration tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
