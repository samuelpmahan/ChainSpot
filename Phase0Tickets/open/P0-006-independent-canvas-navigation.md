# P0-006: Independent canvas navigation

## Status

`open`

## Objective

Provide independent, predictable pan, pointer-centered zoom, fit, reset, and resize behavior for both image panes without coordinate drift.

## Why this exists

Users must inspect differently sized images at useful scales while all annotations remain tied to original pixels. Source and target view transforms are deliberately independent in Phase 0.

## Scope

- Implement wheel/trackpad zoom around the pointer in each pane.
- Implement pan by dragging empty canvas space without conflicting with later marker drag behavior.
- Add per-pane Fit and Reset view controls; reset returns to the default fit transform.
- Recompute safe pane geometry on container/window resize while preserving an intentional user view where practical and never changing domain coordinates.
- Keep source and target transforms independent and transient, except for the optional plain persisted view-state shape already allowed by the model.
- Establish reasonable minimum/maximum view scales based on interaction usability, not image processing.

## Out of scope

- Synchronized pane navigation, a required 1:1 button, rotation, image warping, touch-first gestures, mini-maps, or registration previews.
- Point creation or marker correction.
- Putting pan, zoom, fit, or reset into domain undo/redo.

## Dependencies

P0-003, P0-005

## Requirements

- Zoom must preserve the image location beneath the pointer, subject only to explicit bounds/scale limits.
- Panning and zooming one pane must not move the other pane.
- Fit must show the entire image and preserve aspect ratio.
- Reset must return to the same default fit behavior for the current pane size.
- View operations must not change image dimensions, point data, domain history, or dirty state.
- Resizing must not cause stored or converted original-image coordinates to drift.
- Empty-canvas pan and marker drag must have separable event paths for P0-008.

## Implementation notes

Use Konva's stage/group transform directly with the pure functions from P0-003. Store a small per-pane scale/translation value in transient editor state. Avoid a generalized camera system or library abstraction.

## Acceptance criteria

- [ ] Each pane pans and zooms independently.
- [ ] Zoom is centered on the active pointer location and remains usable across configured limits.
- [ ] Fit displays the full image; Reset restores default fit after arbitrary navigation.
- [ ] Navigation and resize do not alter durable project state, dirty state, or history.
- [ ] Repeated pan/zoom/fit/resize conversion checks resolve to the same original-image coordinate within the documented tolerance.
- [ ] Empty-space pan does not consume the event path reserved for a draggable marker.

## Test requirements

- Integration-test pointer-centered zoom math and independent pane transforms.
- Test pan followed by zoom and zoom followed by pan against expected image coordinates.
- Test Fit and Reset for differently sized portrait/landscape fixtures.
- Resize the browser/pane and verify a fixed image-space probe still maps to the correct landmark/screen position.
- Verify all navigation leaves history length and dirty state unchanged.

## Manual verification

With two differently sized images, pan and zoom each pane independently using a mouse wheel/trackpad, then Fit and Reset each side and confirm navigation feels predictable.

## Deliverables

- Per-pane transient view-transform behavior and controls.
- Resize handling integrated with image panes.
- Navigation integration tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
