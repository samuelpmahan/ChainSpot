# P0-014: Integrated acceptance workflow and documentation

## Status

`open`

## Objective

Prove the complete five-pair local workflow in Playwright and document how a reviewer runs, tests, and uses the finished Phase 0 workspace.

## Why this exists

The detailed test plan specifies an end-to-end save/reopen workflow using representative images, and the planning brief requires integrated happy-path coverage plus practical running/testing/usage documentation.

## Scope

- Add richer, privacy-safe, repository-controlled map-like source-overview and clean-map fixtures with known landmarks and different intrinsic dimensions for integrated acceptance; these are distinct from the tiny decoding fixtures owned by P0-001.
- Implement the detailed-plan Playwright acceptance flow: load both images; create five distributed pairs; pan/zoom both panes; drag two markers; label one pair; delete and restore one through undo; export the bundle; reload the application; reopen the bundle; and verify every marker remains at the same native coordinate/landmark within one original pixel.
- Include a browser resize, Fit, Reset, pair reorder, disable/enable, keyboard nudge, and dirty/clean checkpoint assertions in the integrated suite without duplicating every lower-level edge case.
- Update the repository README with installation, development, type-check, unit/integration test, Playwright, and build commands.
- Document the supported Phase 0 baseline, concise new/save/open workflow, correction controls/shortcuts, bundle contents, pending-pair behavior, and explicit Phase 0 limitations.
- Ensure test setup is deterministic and does not depend on network access, private screenshots, timing-sensitive manual actions, or a backend.

## Out of scope

- New product behavior or error cases missing from earlier tickets.
- Screenshot-diff perfection, full cross-browser/mobile matrices, CI/CD, deployment docs, tutorial content, or later-phase concepts beyond clear non-goals.
- Treating the integrated test as the sole coverage for coordinate, history, schema, or persistence contracts.

## Dependencies

P0-011, P0-012, P0-013

## Requirements

- Fixtures must be safe to commit and sufficiently detailed to identify exact landmark coordinates.
- The test must use browser-visible interactions and actual download/reupload of the generated project bundle where Playwright supports it.
- Pre-export expected original-pixel coordinates must be compared with post-import values/marker anchors within one original image pixel.
- The workflow must verify source and target can have different dimensions and view transforms.
- Documentation must match actual command names and implemented controls, not planned or future behavior.
- Limitations must explicitly state that Phase 0 creates correspondences only and performs no alignment, warping, image analysis, overlay extraction, backend upload, or production graphics export.

## Implementation notes

Prefer compact synthetic or appropriately licensed fixtures with high-contrast known landmarks if real project screenshots are not safe to commit. Use stable test-facing semantics already exposed for accessibility rather than implementation-specific Konva internals wherever possible.

## Acceptance criteria

- [ ] The complete detailed-plan happy path passes deterministically in Playwright from a clean application state.
- [ ] Five distributed pairs survive navigation, two corrections, labeling, delete/undo, export, reload, and import within one original pixel.
- [ ] Integrated checks cover resize, Fit/Reset, reorder, enable state, nudge, and dirty-to-clean save/open transitions.
- [ ] The test uses two differently sized, privacy-safe committed image fixtures and no network/backend.
- [ ] README commands have been executed successfully and usage/shortcuts/bundle/error expectations match the product.
- [ ] Documentation states the browser/file baseline and Phase 0 non-goals without promising later-phase behavior.
- [ ] No missing product behavior is implemented as an incidental part of this ticket.

## Test requirements

- Add the described Playwright happy-path test and keep it independent of test execution order.
- Run the full Vitest suite before the Playwright workflow to ensure integrated changes did not weaken unit contracts.
- Run strict type checking and the production build using the exact documented commands.
- Verify the E2E test catches an intentionally altered expected coordinate during test development, then restore the correct assertion.

## Manual verification

Follow only the README from a clean checkout to run the app and repeat the five-pair save/reopen workflow. Confirm the documentation is sufficient and no landmark visibly shifts.

## Deliverables

- Richer privacy-safe map-like acceptance fixtures with known landmarks.
- Deterministic integrated Playwright acceptance coverage.
- Completed repository running, testing, usage, baseline, bundle, shortcut, and limitation documentation.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
