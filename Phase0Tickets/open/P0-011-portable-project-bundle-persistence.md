# P0-011: Portable project bundle persistence

## Status

`open`

## Objective

Export and reopen one portable, versioned ChainSpot ZIP bundle containing project JSON and both verified original images.

## Why this exists

The Phase 0 completion target requires user-controlled local save/reload with no backend, no broken external file references, image hash verification, and no change to original-image coordinates.

## Scope

- Consume the minimal transient runtime asset registry established by P0-004/P0-005 to access original uploaded bytes; do not introduce a second asset store.
- Compute SHA-256 hashes with native Web Crypto when original bytes enter through upload/open, and ensure each image manifest is populated before export.
- Add `fflate` as the one focused archive dependency and create a `.chainspot.zip` containing `project.json` plus both originals under stable `images/` bundle paths.
- Trigger a local browser download with a safe project-derived filename and preserve in-memory state if creation/download fails.
- Open a user-selected bundle through native File APIs; parse the archive and schema before atomically replacing the current project.
- Verify both required assets, manifest paths, decoded metadata, and hashes before treating the project as fully restored.
- Restore project metadata, original images, image metadata, pairs, labels, enabled/order state, and optional view state without coordinate changes.
- Implement specific visible outcomes for archive/JSON/schema/manifest/image-decode/hash failures, missing images, and save failures.
- Open a safely inspectable repair state for a missing bundled image; require explicit hash-compatible supply or explicit replacement/discard handling rather than silent substitution.
- Integrate save/open success with dirty-state checkpoints and pending-pair guidance.

## Out of scope

- IndexedDB autosave, recent-project lists, cloud storage, file-system sync, accounts, encryption, multiple project tabs, or automatic backups.
- Custom ZIP implementation, generic storage providers, schema migrations, or archive formats beyond the documented portable ZIP.
- Image transformation, recompression, thumbnails, deduplication, or content analysis.

## Dependencies

P0-004, P0-005, P0-009, P0-010

## Requirements

- Export must contain exactly one supported `project.json` plus the two original image assets referenced by their manifest bundle paths.
- Browser-provided File/download APIs must handle user selection/output; no network request or backend may be required.
- SHA-256 values must represent the loaded original bytes, be recomputed from bundled bytes, and be verified before full load.
- Export/import must preserve authoritative pixel coordinates, IDs, labels, enabled state, pair order, project/image metadata, and optional view state.
- Import must validate into temporary data and replace the active project atomically only after the bundle is accepted; recoverable repair state is explicitly distinct from a successful full open.
- Unsupported version or malformed data must surface the structured cause from P0-010.
- A pending half-pair cannot be silently saved; the UI must require cancellation/completion or an explicit save action that cancels it with clear notice.
- Successful save marks the current checkpoint clean; failed save preserves current state and dirty status. Successful open establishes a clean checkpoint.
- Missing or mismatched image content cannot become an empty/silently substituted canvas.

## Implementation notes

Use `fflate` only for browser-compatible ZIP read/write. Browsers do not provide a direct portable ZIP API, so this dependency is justified to avoid error-prone custom archive binary code. Use native `crypto.subtle.digest` for SHA-256 and native File/Blob/object-URL/download mechanics elsewhere. Keep archive code focused on the one documented layout.

## Acceptance criteria

- [ ] Save downloads a `.chainspot.zip` with valid `project.json` and both byte-identical originals at manifest paths.
- [ ] Both manifest SHA-256 hashes match the archived bytes.
- [ ] Opening a valid bundle restores both rendered images and all required project data without pixel-coordinate changes.
- [ ] Save/open checkpointing updates the dirty indicator correctly; save failure leaves the project usable and dirty.
- [ ] Archive, JSON, schema/version, manifest, decode, missing-image, and hash-mismatch failures are distinguishable and do not silently replace the valid active project.
- [ ] Missing-image repair and hash-mismatch replacement require explicit user action and follow the image-replacement/discard rules.
- [ ] Saving with a pending pair cannot produce an ambiguous/incomplete normal project.
- [ ] The workflow performs no network request and adds no persistence dependency other than `fflate`.

## Test requirements

- Unit/integration-test archive creation, expected entries, byte equality, SHA-256 generation, and manifest verification.
- Round-trip a valid project with fractional coordinates, labels, disabled/reordered pairs, both originals, and optional view state.
- Test corrupt archive, invalid JSON, unsupported schema, bad manifest path, missing image, failed decode, and hash mismatch.
- Test atomic open: every non-repair failure leaves the prior in-memory project unchanged.
- Test repair-state resolution with a matching image and explicit changed-image replacement/discard path.
- Test pending-pair save guidance, successful dirty checkpointing, and simulated save failure with retry.

## Manual verification

Save a populated project, inspect the archive layout with an external ZIP viewer, reload the browser, reopen the bundle, and visually confirm both originals and markers return to the same landmarks.

## Deliverables

- Focused ZIP bundle writer/reader using `fflate`.
- Native SHA-256 and browser save/open integration.
- Persistence/repair/error UI and dirty-state integration.
- Bundle round-trip and malformed-input tests.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
