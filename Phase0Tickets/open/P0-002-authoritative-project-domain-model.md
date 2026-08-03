# P0-002: Authoritative project domain model

## Status

`open`

## Objective

Define the plain, serializable project and image-asset model that remains authoritative independently of Svelte and Konva.

## Why this exists

Phase 0 must produce durable, inspectable point correspondences and original-image metadata. Konva nodes, decoded images, file handles, and editor gestures must never become persistent project state.

## Scope

- Define compact TypeScript types and constructors for project metadata, the two image roles, immutable image-asset metadata, complete control-point pairs, points, and optional persisted view state.
- Represent stable pair IDs, presentation ordinals, optional labels, enabled state, timestamps, source/target image references, and floating-point pixel coordinates.
- Define the boundary between durable project state and transient editor state such as active tool, selection, pending half-pair, hover, pointer, drag, decoded image, file object, and history cursor.
- Provide minimal domain invariants/default creation behavior needed by later tickets.
- Use the ChainSpot terminology from the detailed plan throughout new code and user-facing definitions.

## Out of scope

- Schema parsing, archive persistence, content hashing, migrations, or browser file handling.
- Domain mutation/history implementation.
- Registration records, course geometry, render settings, arbitrary annotations, or Phase 1 handoff implementation.
- Generic repositories, services, stores, entity frameworks, or extensibility interfaces.

## Dependencies

P0-001

## Requirements

- Durable state must contain only plain serializable data.
- Exactly two semantic image roles must be supported: source overview and target basemap.
- Image metadata must be able to retain immutable ID, role, original filename, MIME type, intrinsic width/height, SHA-256 value, and bundle path once known.
- A complete pair must reference the correct source and target assets and retain pixel coordinates for both sides.
- Pair IDs remain stable; ordinals may be regenerated after reorder.
- Labels are optional values, while the ability to label a pair is required later.
- Coordinate fields must allow fractional pixels; normalized values must not replace authoritative pixel values.
- Transient pending pairs and library/framework objects must not be included in normal durable project state.

## Implementation notes

Prefer a few direct types and pure constructors over a class hierarchy. If an application-level Svelte state holder is needed later, it should contain or expose this domain object rather than redefine it. Keep the Phase 1 consumption boundary implicit in these plain types; do not build registration interfaces or adapter layers now.

## Acceptance criteria

- [ ] A new project can be created as a plain serializable object with project metadata and empty image/pair collections.
- [ ] Source and target assets are distinguishable by explicit roles and carry all required metadata fields.
- [ ] Complete pair data represents both image-space points, stable identity, order, label, and enabled state.
- [ ] Durable and transient fields are explicitly separated and documented near their definitions.
- [ ] JSON serialization of a representative domain object does not encounter framework, Konva, File, Blob, or decoded-image objects.
- [ ] No later-phase entities or speculative abstraction layers are present.

## Test requirements

- Unit-test default project construction and uniqueness/stability of generated IDs using controllable test inputs where needed.
- Unit-test source/target role and complete-pair invariants.
- Unit-test that a representative durable state is JSON-serializable and excludes named transient fields.
- Run strict type checking.

## Manual verification

None.

## Deliverables

- Plain TypeScript domain types and minimal construction/invariant helpers.
- Focused unit tests.
- Short code-level documentation of the durable/transient boundary and ChainSpot terminology.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
