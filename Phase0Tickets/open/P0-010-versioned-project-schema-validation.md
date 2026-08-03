# P0-010: Versioned project schema and validation

## Status

`open`

## Objective

Define and validate a compact versioned project document that round-trips authoritative state without coordinate changes.

## Why this exists

Saved projects must be serializable, inspectable, compatible with safe future evolution, and rejected clearly when malformed or from an unsupported major version.

## Scope

- Define schema version 1 for project metadata, the two image manifests, complete control-point pairs, normalized values, and optional view state.
- Implement direct serialization from durable domain state and explicit parsing/validation back to domain data.
- Validate schema version, required project/image fields, image roles, non-zero dimensions, coordinate bounds, duplicate IDs, pair image references, and complete source/target sides.
- Ignore unknown fields for a supported schema version.
- Reject a newer unsupported major schema version with a clear structured error rather than partially loading it.
- Verify or recompute normalized coordinates from authoritative pixels and intrinsic dimensions under the documented compatible-load rule.
- Produce structured errors that the bundle-open UI can identify as JSON, schema/version, manifest, reference, or coordinate failures.

## Out of scope

- ZIP archive creation/opening, image-byte hashing, downloads/uploads, migrations beyond version 1, autosave, or UI repair flows.
- A generic schema library or dependency; the Phase 0 schema is small enough for focused TypeScript validation.
- Serializing transient pending pairs, selection, history stacks, decoded images, Konva nodes, or file handles.

## Dependencies

P0-002, P0-003

## Requirements

- `schemaVersion` must be explicit and parsed before the project is accepted.
- A normal saved document must include only complete pairs.
- Pixel coordinates remain authoritative; normalized values are derived/checked and cannot silently override pixels.
- Unknown fields in a supported version are ignored, while missing/invalid required fields fail with actionable context.
- Duplicate project/image/pair IDs and incorrect role/reference relationships fail validation.
- Non-finite or out-of-bounds points and zero/invalid dimensions fail validation.
- Serialization and parsing must not alter IDs, ordinals, labels, enabled states, timestamps, filenames, dimensions, hashes, bundle paths, or pixel coordinates.

## Implementation notes

Keep parsing explicit and close to the versioned document definition. Avoid reflection, decorators, generic validator frameworks, or placeholder migration registries. A future migration can be introduced only when a second schema exists.

## Acceptance criteria

- [ ] A valid schema-v1 project serializes and parses into equivalent durable state without coordinate drift.
- [ ] Unknown fields in a v1 document do not prevent load.
- [ ] Unsupported newer major versions fail before any state replacement and identify the version problem.
- [ ] Missing required fields, invalid dimensions/coordinates, duplicate IDs, wrong image roles, and missing/wrong image references each produce a structured validation failure.
- [ ] Normalized values are checked/recomputed from pixels according to the documented rule.
- [ ] Pending and other transient editor state cannot appear in normal serialized output.
- [ ] No general-purpose validation dependency or speculative migration system is added.

## Test requirements

- Unit-test a representative schema-v1 serialize/parse round trip with fractional pixel coordinates.
- Test unsupported major version and supported unknown fields.
- Test duplicate IDs, missing references, swapped/wrong image roles, incomplete pairs, invalid dimensions, non-finite values, and each image boundary.
- Test missing/mismatched normalized values are handled by the compatible-load rule without changing authoritative pixels.
- Test parsing failure leaves an existing in-memory project untouched.

## Manual verification

None.

## Deliverables

- Schema-v1 document types and focused serializer/parser/validator.
- Structured validation error contract.
- Comprehensive schema and round-trip unit tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
