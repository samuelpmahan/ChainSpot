# P0-015: Phase 0 definition-of-done verification

## Status

`open`

## Objective

Audit the completed Phase 0 implementation against every documented exit condition and record evidence without adding missing product behavior.

## Why this exists

Phase 0 control points will become authoritative Phase 1 inputs. A final independent gate must confirm coordinate stability, persistence, interaction completeness, scope restraint, and documentation after all implementation tickets are done.

## Scope

- Verify every row in `PHASE_0_COVERAGE.md` against completed tickets, implementation, automated tests, and manual evidence.
- Run the full type-check, unit/integration, Playwright, and production-build commands from documented clean-checkout instructions.
- Manually execute the 3–10-pair workflow with two differently sized representative images, including pan, zoom, Fit, Reset, resize, drag, nudge, exact edit, label, reorder, disable, delete, undo/redo, save, reload, and reopen.
- Confirm every pre-save/post-open point remains on the same native image location within one original pixel and that normalized values agree with authoritative pixels.
- Exercise representative image, replacement, save, malformed-bundle, missing-image, hash-mismatch, and unsupported-version recovery paths.
- Audit durable state and bundle contents to confirm no Konva/framework/transient state is serialized.
- Audit dependency and code scope for absence of Phase 1+ behavior and speculative infrastructure.
- Fill this ticket's completion record with the exact commands, manual checks, deviations, and any follow-up concerns.

## Out of scope

- Implementing, fixing, or polishing missing behavior. A failed gate returns the owning earlier ticket to active work or creates a reviewed necessary ticket and updates coverage.
- Registration, transform estimation, warping, alignment preview, CV, extraction, production export, backend, deployment, or optional future features.
- Expanding browser/file/mobile compatibility beyond the documented baseline.

## Dependencies

P0-001, P0-002, P0-003, P0-004, P0-005, P0-006, P0-007, P0-008, P0-009, P0-010, P0-011, P0-012, P0-013, P0-014

## Requirements

- This ticket may begin only when every earlier Phase 0 ticket is in `done/` with a completed record.
- Verification evidence must be traceable to the definition of done and coverage matrix.
- All automated suites and the production build must pass without skipped Phase 0 acceptance coverage.
- Manual checks must use both different image dimensions and multiple view/layout changes.
- Any failure must remain visible; this ticket cannot be marked done by weakening criteria or silently implementing the fix here.
- The final artifact must remain a local correspondence workspace with plain data and no registration or image understanding.

## Implementation notes

This is an objective integrated verification ticket, not a cleanup bucket. Small corrections to inaccurate documentation or test invocation may be recorded only if they do not mask missing behavior; product/code defects go back to their owning ticket process.

## Acceptance criteria

- [ ] P0-001 through P0-014 are in `done/` and contain completed completion records.
- [ ] Every coverage-matrix row has passing implementation/test evidence or a documented, reviewed interpretation consistent with the authoritative plans.
- [ ] Type checking, all Vitest tests, all required Playwright tests, and the production build pass from documented instructions.
- [ ] A manual 3–10-pair session completes every required create/correct/manage/history interaction safely.
- [ ] Pan, zoom, Fit, Reset, resize, export, reload, and reopen preserve every point within one original pixel.
- [ ] Bundle inspection confirms schema version, both original images, valid hashes, plain domain data, and absence of transient/Konva state.
- [ ] Representative image/project errors are visible and recoverable without silent data loss.
- [ ] Accessibility and narrow-layout manual checks pass the documented Phase 0 baseline.
- [ ] Dependency audit finds only the core stack plus the explicitly justified `fflate` runtime dependency.
- [ ] Scope audit finds no registration, warping, CV, overlay extraction, backend/account/cloud/deployment, or other Phase 1+ implementation.
- [ ] README instructions and limitations match the verified application.
- [ ] This ticket introduced no missing product behavior.

## Test requirements

- Run every documented type-check, Vitest, Playwright, and production-build command and record exact results.
- Run the integrated acceptance workflow at least once from a clean application/browser storage state.
- Inspect one exported bundle programmatically or with a standard ZIP viewer and compare its parsed coordinates/hashes with the open project.
- Review skipped/disabled tests and confirm none bypass a Phase 0 requirement.

## Manual verification

Perform and record the full exit-gate session, responsive/accessibility review, representative error recovery, archive inspection, and explicit Phase 1 scope audit.

## Deliverables

- Completed verification record in this ticket.
- Evidence that the existing implementation, tests, bundle, and documentation satisfy every Phase 0 exit condition.
- Reviewed coverage-matrix updates only if they clarify evidence without changing required scope.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
