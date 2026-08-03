# P0-004: Domain mutations, history, and dirty state

## Status

`open`

## Objective

Make every durable Phase 0 edit explicit, reversible, and reflected accurately in project dirty state.

## Why this exists

The detailed plan requires deterministic undo/redo over domain changes rather than canvas-node history, and requires visible unsaved-change handling without putting view navigation or pending gestures into durable history.

## Scope

- Implement explicit domain actions or straightforward project snapshots for renaming the project; adding a complete pair; moving either side; editing a label; enabling/disabling, deleting, and reordering a pair; and replacing either image.
- Implement undo and redo over durable domain edits, with redo invalidation after a divergent edit.
- Define transaction/coalescing behavior so one completed drag is one understandable history step rather than every pointer move.
- Track a saved/opened checkpoint and expose whether current durable state is dirty.
- Provide hooks/actions for persistence to mark a successful save/open checkpoint later.
- Keep pending half-pair cancellation, selection, hover, marker visibility, pan, zoom, and fit outside durable history.

## Out of scope

- UI controls, keyboard shortcut wiring, browser unload prompts, or persistence implementation.
- Event buses, generic command frameworks, immutable-state libraries, or cross-session history.
- Phase 1 enable/disable semantics beyond retaining the required pair flag.

## Dependencies

P0-002

## Requirements

- Actions must update plain domain state without reading or mutating Konva nodes.
- Undo/redo must restore project name, stable pair IDs, coordinates, labels, enabled states, order, and affected image state exactly.
- Completing an add enters history once; cancelling a pending pair enters history zero times.
- A completed drag/move must undo in one step.
- Pan/zoom and other view-only interactions must not make the project dirty.
- Dirty state must clear only after successful save/open checkpointing or returning exactly to the saved history position; a failed save must leave it dirty.
- All mutations must enforce domain invariants or reject invalid input without partial state changes.
- Image-replacement history must retain runtime access to every image asset still referenced by current state, undo history, or redo history, so undo/redo can restore both metadata and renderable original content.

## Implementation notes

Use the simplest coherent command or snapshot approach that keeps tests clear. The expected project size is tiny, so snapshot history is acceptable if image bytes and decoded objects are kept outside plain project snapshots. A minimal transient runtime asset registry may retain the corresponding original bytes and decoded resource while any current-state, undo, or redo entry still references the asset. Replacing an image must not revoke or release a reachable asset; resources may be released once no live project/history state references them. Do not generalize this into a media repository, cache framework, persistent asset-management layer, or generalized undo framework.

## Acceptance criteria

- [ ] Every required durable mutation is available through the domain mutation boundary.
- [ ] Undo and redo restore exact before/after domain values for each mutation kind.
- [ ] Undoing or redoing image replacement restores a renderable original image as well as its plain metadata.
- [ ] Redo is cleared after a new edit from an undone state.
- [ ] A drag can be previewed transiently but commits as one history entry.
- [ ] Pending, selection, visibility, and view operations do not affect durable history or dirty state.
- [ ] Dirty state reflects edits, undo/redo around the saved checkpoint, successful checkpoints, and failed-save behavior correctly.
- [ ] No Konva or component instance participates in mutation or history data.

## Test requirements

- Unit-test project rename, add/undo/redo, move either side/undo/redo, label edit, enable/disable, delete/restore, reorder/restore, and image replacement/restore.
- Unit-test runtime asset reachability across replacement, undo, redo, divergent-edit redo invalidation, and eventual release after no live state/history entry references an asset.
- Unit-test redo invalidation and one-entry drag commit behavior.
- Unit-test pending cancellation and view-only operations leave history and dirty state unchanged.
- Unit-test saved checkpoint traversal and failed-save preservation of dirty state.

## Manual verification

None.

## Deliverables

- Focused mutation/history state logic.
- Dirty-checkpoint contract for later persistence/UI integration.
- Comprehensive domain-level unit tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
