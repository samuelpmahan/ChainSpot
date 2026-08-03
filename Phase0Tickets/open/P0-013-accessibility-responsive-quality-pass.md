# P0-013: Accessibility and responsive quality pass

## Status

`open`

## Objective

Make the complete Phase 0 workspace understandable and operable with proportional keyboard, screen-reader, focus, error, and narrow-screen support.

## Why this exists

The detailed plan requires an accessibility and keyboard review, all required visible states, and graceful narrowing for a desktop-first workspace. These concerns must be verified across the integrated UI rather than deferred indefinitely.

## Scope

- Review and correct semantic labels/names for project actions, file inputs, per-pane controls, point-list operations, coordinate fields, diagnostics, and errors.
- Establish logical focus order, visible focus indicators, and focus return after dialogs/actions.
- Announce add-source/add-target guidance, pending cancellation, save/open results, and validation errors through proportional live status semantics.
- Ensure every required pair-management action has a visible keyboard-operable control; review Escape, arrows, Shift+arrows, Delete/Backspace, and undo/redo shortcut conflicts.
- Ensure color is not the only marker/state signal and text/control contrast is adequate for the Phase 0 UI.
- Make the desktop two-pane layout narrow gracefully—stacking or reflowing panes/list as needed—without overlapping controls, inaccessible canvas, or annotation drift.
- Review all required visible states for consistent recovery: no/one/both images, adding source/target, selected pair, dragging, invalid image, pending/incomplete pair, dirty, and project save/open failure.

## Out of scope

- A custom design system, exhaustive WCAG certification, mobile/touch-first optimization, internationalization, cross-browser matrix, themes, animations, or optional visual polish.
- New product behavior, diagnostics, persistence cases, or editing operations omitted by earlier tickets.
- Replacing canvas interaction with a generalized accessibility framework.

## Dependencies

P0-005, P0-006, P0-007, P0-008, P0-009, P0-010, P0-011, P0-012

## Requirements

- Native semantic controls must be used where practical; custom controls require correct roles, names, state, and keyboard behavior.
- Canvas-only data management must have a corresponding point-list/control path.
- Shortcut handlers must not override browser/editor behavior in text and numeric fields.
- Focus must remain visible and predictable after add/cancel/delete, modal confirmation, import failure, and successful open.
- Status and errors must be programmatically associated/announced without excessive repeated announcements.
- At a documented narrow desktop viewport, all required controls remain reachable and both images can still be inspected sequentially.
- Responsive layout changes must not modify authoritative coordinates.

## Implementation notes

Prefer native buttons, inputs, labels, headings, and status/error elements plus scoped CSS. A small confirmation dialog may use the native dialog element or an equally simple accessible pattern. Do not add a component or accessibility dependency merely for this pass.

## Acceptance criteria

- [ ] A keyboard user can load images, create/cancel a pair, select/correct it, label/reorder/disable/delete it, undo/redo, and initiate save/open using visible controls.
- [ ] All controls and fields have meaningful accessible names, states, and error associations.
- [ ] Focus indicators/order and focus restoration are coherent across normal, confirmation, error, and open/save paths.
- [ ] Add-step guidance and important failures/successes are announced without relying only on visual color.
- [ ] Marker and list states use more than color alone and retain readable contrast.
- [ ] The documented narrow viewport has no overlapping/unreachable required controls and introduces no coordinate drift.
- [ ] The quality pass adds no design system, UI framework, or new product scope.

## Test requirements

- Add automated keyboard-flow tests for creation/cancel, nudge, list management, undo/redo, and shortcut suppression in fields.
- Assert accessible names/roles/states for critical controls and status/error associations using existing test tooling.
- Add a narrow-viewport browser test that checks control reachability/layout and fixed marker coordinates after reflow.
- Test focus restoration for replacement confirmation, delete, failed import, and successful open where deterministic.

## Manual verification

Complete the main workflow using keyboard controls, inspect focus and announcements with browser accessibility tools, and visually review the standard desktop and documented narrow viewport at representative zoom levels.

## Deliverables

- Semantic/focus/status improvements across existing Phase 0 UI.
- Minimal responsive CSS and documented narrow baseline.
- Accessibility and narrow-layout automated tests plus recorded manual checks.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
