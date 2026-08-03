# P0-005: Local image intake and two-pane scene

## Status

`open`

## Objective

Let a user load, inspect, replace, and locally render the source and target images in distinct workspace panes.

## Why this exists

Phase 0 begins with two user-selected images, must display their intrinsic metadata, and must retain a working pane when the other image fails. The canvas/layer boundary must be established before point interactions are added.

## Scope

- Build the project toolbar shell with a visible editable project name and two labeled panes for UDisc source and clean target roles.
- Use native browser File APIs and browser image decoding to accept common PNG and JPEG files locally.
- Populate image-asset metadata, including filename, MIME type, decoded intrinsic dimensions, and derived portrait/landscape/square orientation.
- Render each decoded original through a Konva raster image layer at an initial fit transform.
- Establish only the active Phase 0 scene responsibilities: raster layer, control-point layer, and interaction layer.
- Implement visible no-image, one-image, both-image, loading, unsupported-type, decode-failure, and non-zero-dimension validation states.
- Implement explicit image replacement. For changed dimensions, require confirmation before discarding affected annotations; never silently retain invalid points.
- Keep decoded images, object URLs, original bytes, and File/Blob objects outside durable project state. Retain the minimal runtime assets still reachable from current state or undo/redo history, and release resources only once no live project/history state references them.

## Out of scope

- Pan/zoom gestures, markers, pair creation, project ZIP open, content hashing, or persistence.
- EXIF parsing/rotation, image editing, multiple assets per role, drag-and-drop polish, or file types beyond common PNG/JPEG.
- Empty future registration/extraction layers, generic media pipelines, map providers, or server upload.

## Dependencies

P0-002, P0-003, P0-004

## Requirements

- Source and target uploads must remain entirely local and independent.
- Add correspondence must be visibly unavailable until both images decode successfully.
- A failure in one role must leave the valid image and project state in the other role intact.
- The UI must report each loaded image's original dimensions and simple orientation.
- Rendering scale and pane size must not alter image metadata or future annotation coordinates.
- Konva nodes and decoded browser objects must not enter durable project state.
- Image replacement must integrate with the minimal transient asset registry from P0-004 so undo/redo can render the restored original rather than metadata alone.
- Different-dimension replacement must route through the domain action and an explicit discard confirmation; cancellation preserves the current image and points.
- The source role is the UDisc overview and the target role is the clean basemap in UI and code terminology.
- Project-name edits must use the domain mutation boundary and participate in dirty state and undo/redo.

## Implementation notes

Use a small pane component only where it avoids duplicated source/target behavior. Native file inputs and browser decoding are sufficient. Do not add an upload library or media abstraction. Do not create empty nodes for layers that belong to later phases.

## Acceptance criteria

- [ ] A local PNG or JPEG can be loaded independently into each role without a network request.
- [ ] Both images render in their correct labeled panes at initial fit.
- [ ] Filename, intrinsic dimensions, and derived orientation are visible for each role.
- [ ] The project name is visible/editable, and renaming it is undoable and marks the project dirty.
- [ ] No-image, one-image, and both-image states are clear, and Add correspondence is gated correctly.
- [ ] Unsupported, unreadable, and zero-size image failures are specific and recoverable without clearing the other role.
- [ ] Replacing a different-sized image cannot silently preserve or discard affected points.
- [ ] The scene uses active raster, control-point, and interaction responsibilities without treating Konva as project state.
- [ ] Unreachable temporary resources are cleaned up on replacement, history truncation, or unmount without revoking assets still needed by current state or undo/redo.

## Test requirements

- Component/integration-test source-only, target-only, and both-image upload with the tiny synthetic PNG/JPEG fixtures owned by P0-001.
- Test unsupported MIME type and decode failure while verifying the other pane remains intact.
- Test intrinsic metadata/orientation display and Add correspondence gating.
- Test project-name editing, undo/redo, and dirty-state integration.
- Test changed-dimension replacement confirmation, cancellation, and confirmed discard action.
- Test replacement followed by undo/redo renders the correct old/new original and releases an asset only after it is unreachable from current state and both history directions.
- Test that durable project serialization contains metadata but no File, Blob, object URL, decoded image, or Konva node.

## Manual verification

Confirm representative portrait and landscape images are sharp, correctly oriented according to browser-decoded dimensions, fit in the intended pane, and cause no unexpected network transfer.

## Deliverables

- Two-pane workspace shell and role-specific local image controls.
- Minimal Konva pane/layer composition and decoded-image lifecycle handling.
- Image state/error UI and replacement confirmation.
- Focused component/integration tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
