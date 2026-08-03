# Phase 0 coverage

References to the former Chainline codename are interpreted as ChainSpot. The authoritative inputs are `CHAINSPOT_OVERARCHING_PHASE_PLAN.md` and `CHAINSPOT_PHASE_0_DETAILED_PLAN.md`; the current technical direction in the planning brief resolves the detailed plan's otherwise-open frontend-framework choice in favor of SvelteKit.

## 1. Phase 0 definition of done

Phase 0 is complete when a local user in a current Chromium-based desktop browser can load a PNG or JPEG UDisc overview and clean basemap into independent side-by-side panes; create, inspect, and precisely revise 3–10 unambiguous point correspondences; pan, zoom, fit, resize, drag, nudge, save, close, and reopen without moving any annotation in original-image coordinates; and recover visibly from expected image or project errors. The project is a versioned portable bundle containing both original images and plain serializable project data. Domain state—not Konva—is authoritative. Unit, integration, and Playwright tests verify the stable contracts and workflow, and no registration, image analysis, backend, or production export behavior exists.

## 2. Requirements coverage matrix

The rows below cover the detailed plan's required scope, workflows, architecture, validation, testing, milestones, and final definition of done. When two tickets appear, the first owns the behavior and the second verifies its integration.

| Detailed Phase 0 requirement or constraint | Owning ticket(s) | Coverage boundary |
| --- | --- | --- |
| SvelteKit, TypeScript strict mode, Vite, and a browser-only application shell | P0-001 | Foundation only; no backend or deployment work |
| Konva image workspace plus Vitest and Playwright harnesses | P0-001 | Core stack plus tiny synthetic PNG/JPEG decoding fixtures available to early tickets |
| Current Chromium desktop baseline and local, one-project-at-a-time operation | P0-001, P0-014 | Documented and exercised in the acceptance workflow |
| Plain serializable authoritative project state | P0-002 | No Konva, decoded image, file handle, or Svelte object in durable state |
| Consistent image asset, source, target, control point, pair, pending/complete, coordinate, and view-transform terminology | P0-002 | Chainline is normalized to ChainSpot in new work |
| Project metadata, editable project name, and immutable IDs | P0-002, P0-004, P0-005 | Name is visible/editable in the workspace and participates in dirty history |
| Image metadata: role, filename, MIME type, intrinsic dimensions, hash, and bundle path | P0-002, P0-011 | Hash and bundle path are populated by persistence |
| Control-pair metadata: stable ID, ordinal, label, enabled state, timestamps, and two image references | P0-002 | Floating-point pixel coordinates are supported |
| Durable project state separated from transient editor state | P0-002 | Active tool, selection, pending pair, pointer, hover, drag, and decoded images remain transient |
| Optional view state remains separate from image annotations | P0-002, P0-011 | It may be persisted but cannot affect saved point coordinates |
| Original image pixels are authoritative | P0-003 | Bounds are `[0,width) × [0,height)` |
| Normalized coordinates are derived from original pixels | P0-003, P0-010 | Serialized values are verified/recomputed; pixels win on compatible discrepancies |
| Screen-to-image conversion through inverse view transform | P0-003, P0-006 | Never inferred solely from CSS bounds after transforms |
| Image-to-screen conversion and round-trip tolerance | P0-003 | Used by rendering and stable marker placement |
| Pan, zoom, fit, resize, and device-pixel ratio cannot alter domain coordinates | P0-003, P0-006, P0-014 | Covered by unit and browser tests |
| Explicit domain actions/snapshots own durable mutations | P0-004 | No arbitrary canvas-node mutation history |
| Minimum mutations: add, move either side, label, enable/disable, delete, reorder, and replace either image | P0-004 | Used by later UI tickets |
| Undo/redo covers geometry and image-replacement edits | P0-004, P0-009 | Completed pair operations are deterministic |
| Image replacement retains renderable assets while reachable from current state or undo/redo | P0-004, P0-005 | Minimal transient asset registry only; plain snapshots retain metadata, and unreachable resources are released |
| Pending cancellation does not enter durable history | P0-004, P0-007 | Escape cancels the transient half-pair |
| Pan and zoom stay outside domain undo history | P0-004, P0-006 | View operations remain independent |
| Dirty state tracks the current history checkpoint and save/open lifecycle | P0-004, P0-011 | Visible unsaved indicator; failed saves remain dirty |
| Local source and target PNG/JPEG upload with no server | P0-005 | Native File APIs and browser decode |
| Unsupported or unreadable images, zero dimensions, and role-specific errors are visible and recoverable | P0-005 | A valid image in the other pane is retained |
| Original dimensions and portrait/landscape/square orientation are reported | P0-005 | Derived from decoded intrinsic dimensions; no EXIF subsystem |
| No-image, one-image, and both-image states | P0-005 | Add correspondence is enabled only with both images |
| Side-by-side two-pane workspace and original raster rendering | P0-005 | Desktop first with quality-pass narrowing in P0-013 |
| Explicit raster, control-point, and interaction scene/layer responsibilities | P0-005, P0-007 | No empty future preview/overlay layers are implemented |
| Image replacement and different-dimension point-discard confirmation | P0-005, P0-004 | Replacement cannot silently invalidate annotations |
| Independent source and target pan/zoom | P0-006 | No synchronized navigation |
| Pointer-centered wheel/trackpad zoom and empty-canvas pan | P0-006 | Marker drag remains a separate interaction |
| Fit-to-view and reset-to-default-fit | P0-006 | Initial load also fits the image |
| Resize preserves landmark anchoring | P0-006, P0-014 | Pane geometry may change; image-space points do not |
| Explicit Add correspondence action and source-then-target state machine | P0-007 | Single-entry mode is the Phase 0 default |
| Unambiguous prompts for source and target steps | P0-007, P0-013 | Accessible status announcement included in quality pass |
| A second source point cannot be added while target is pending | P0-007 | Requires cancel before restarting |
| Pending marker and complete, matching numbered marker pair | P0-007 | Durable state receives only a complete pair |
| Screen-constant marker, precise anchor, readable ordinal, and enlarged hit target | P0-007, P0-013 | Quality pass verifies contrast over varied imagery |
| Pair and side selection with distinct selected state | P0-008 | Point list integration follows in P0-009 |
| Drag correction at arbitrary zoom | P0-008, P0-014 | Updates original-image coordinates through conversion boundary |
| Arrow nudge by one image pixel and Shift+Arrow by ten | P0-008 | Disabled while text fields are focused |
| Exact pixel-coordinate editing | P0-008 | Invalid/out-of-bounds input is rejected without partial mutation |
| Out-of-bounds protection for clicks, drags, nudges, and numeric edits | P0-003, P0-008 | Shared coordinate policy is tested |
| Point list shows ordinal, label, enabled/completion state, native coordinates, and normalized coordinates | P0-009 | Selection is synchronized with canvas markers |
| Pair labels, reorder, enable/disable, and deletion | P0-009 | Ordinals regenerate after reorder; IDs do not |
| Required keyboard interactions for cancel, nudge, delete, undo, and redo | P0-007, P0-008, P0-009, P0-013 | Shortcuts avoid editable fields and expose visible controls |
| Hide/show control-point overlays | P0-009 | Visibility is transient and does not alter project data |
| Versioned, directly serializable project document | P0-010 | Small explicit validation; no generic schema framework |
| Supported version handling, clear rejection of newer unsupported major versions, and compatible unknown-field tolerance | P0-010 | Never partially accepts an unsupported major version |
| Duplicate IDs, image-role/reference errors, bounds, dimensions, and complete-pair validation | P0-010 | Validation errors are structured for UI display |
| Pending pairs are excluded from normal saves | P0-007, P0-010, P0-011 | Creation keeps them transient, the schema excludes them, and persistence owns cancel/resolve save guidance |
| Serialize/deserialize without coordinate changes | P0-010 | Unit tests compare authoritative pixels exactly/tolerantly as appropriate |
| One portable `.chainspot.zip` bundle containing `project.json` and both originals | P0-011 | Uses `fflate`; no backend or external storage |
| SHA-256 content hashes for loaded originals and manifest verification | P0-011 | Native Web Crypto performs hashing on intake/open and verifies export/import bytes |
| Export/download and import/open via native browser File APIs | P0-011 | Current in-memory project survives save failure |
| Restore images, metadata, pairs, labels, enabled/order state, and optional view state | P0-011, P0-014 | Pixel coordinates cannot change on round trip |
| Corrupt JSON/manifest/archive and missing-image failures are identified specifically | P0-010, P0-011 | No silent empty-canvas substitution |
| Missing image opens a repair state; hash mismatch warns and requires explicit replacement | P0-011 | Other valid project information remains inspectable where safe |
| Complete/incomplete counts and future-method readiness counts without estimating a transform | P0-013 | Guidance only; never registration computation |
| Clustered-landmark and near-duplicate-point warnings | P0-013 | Non-blocking diagnostics |
| Magnified original-pixel cursor/selected-marker preview with exact crosshair | P0-013 | Precision aid only; no image analysis |
| Visible required states: adding either side, complete selection, dragging, invalid image, dirty, and save/open failure | P0-005, P0-007, P0-008, P0-011, P0-013 | Quality pass checks consistency and recovery |
| Accessible labels, focus order/visibility, status/errors, keyboard parity, and non-canvas point management | P0-013 | Proportional Phase 0 accessibility |
| Desktop-first layout with basic narrow-screen resilience | P0-013 | No full mobile or touch-first workflow |
| Deterministic coordinate, schema, persistence, and history unit tests | P0-003, P0-004, P0-010, P0-011 | Stable contracts rather than implementation details |
| Component/integration coverage for upload, pair creation, marker numbers, 200% drag, fit/reset, resize, save/reload, and replacement | P0-005–P0-011 | Owned alongside each behavior |
| End-to-end five-pair save/reopen acceptance workflow within one original pixel | P0-014 | Uses richer repository-controlled map-like fixtures with known landmarks, distinct from P0-001 decoding fixtures |
| Running, testing, and Phase 0 usage documentation | P0-001, P0-014 | Foundation commands first; completed workflow documented after integration |
| Final audit of every Phase 0 definition-of-done item and explicit absence of registration/extraction | P0-015 | Verification only; cannot introduce missing product behavior |
| Plain Phase 1 handoff consumes metadata and correspondences, never Konva/browser state | P0-002, P0-015 | No Phase 1 registration interface implementation beyond the domain contract |

### Recommended items deliberately not made required

| Detailed-plan recommendation | Decision |
| --- | --- |
| Local autosave / IndexedDB | Excluded from Phase 0 required work. Portable user-controlled save plus dirty-state handling satisfies the definition of done with less state machinery. |
| Optional 1:1 view | Excluded. Fit and reset are required; pan/zoom can reach equivalent inspection scales without a separate control. |
| Alt/Option subpixel nudge | Excluded by the detailed plan itself. Floating-point storage remains supported for future use. |

## 3. Dependency-ordered implementation sequence

Recommended sequence:

1. P0-001 — application and test foundation
2. P0-002 — authoritative project domain model
3. P0-003 — coordinate and view-transform mathematics
4. P0-004 — domain mutations, history, and dirty state
5. P0-005 — local image intake and two-pane scene
6. P0-006 — independent canvas navigation
7. P0-007 — correspondence creation and numbered markers
8. P0-008 — point selection and precision correction
9. P0-009 — point list and pair management
10. P0-010 — versioned project schema and validation
11. P0-011 — portable project bundle persistence
12. P0-012 — diagnostics, magnifier, and completion guidance
13. P0-013 — accessibility and responsive quality pass
14. P0-014 — integrated acceptance workflow and documentation
15. P0-015 — Phase 0 definition-of-done verification

After P0-001, P0-002 and P0-003 may proceed in parallel because the coordinate functions can be specified against primitive dimensions and view transforms. After P0-002, P0-004 and the non-coordinate portions of P0-005 may also proceed independently, but integration should wait for P0-003. P0-010 may proceed after P0-002 while editor UI tickets are underway. P0-012 may begin after P0-009 and can proceed in parallel with P0-011; P0-013 waits for both before the integrated P0-014 and final P0-015 gates.

## 4. Ticket summary table

| ID | Title | Purpose | Dependencies | Primary verification |
| --- | --- | --- | --- | --- |
| P0-001 | Application and test foundation | Establish the minimal SvelteKit/TypeScript/Konva project and test commands | None | Build, Vitest smoke, Playwright smoke |
| P0-002 | Authoritative project domain model | Define durable plain data and transient-state boundary | P0-001 | Domain unit tests and type checking |
| P0-003 | Coordinate and view-transform mathematics | Make original-image coordinates invariant under display transforms | P0-001 | Deterministic unit tests |
| P0-004 | Domain mutations, history, and dirty state | Centralize edits and reversible history | P0-002 | History/action unit tests |
| P0-005 | Local image intake and two-pane scene | Load, describe, replace, and render both images locally | P0-002, P0-003, P0-004 | Component tests and manual rendering check |
| P0-006 | Independent canvas navigation | Provide correct pan, zoom, fit, reset, and resize behavior | P0-003, P0-005 | Integration/browser interaction tests |
| P0-007 | Correspondence creation and numbered markers | Implement the safe two-step creation workflow | P0-004, P0-005, P0-006 | State-machine and component tests |
| P0-008 | Point selection and precision correction | Correct either point by drag, nudge, or exact entry | P0-003, P0-004, P0-006, P0-007 | Unit and zoomed-drag integration tests |
| P0-009 | Point list and pair management | Inspect, label, order, enable, hide, and delete pairs | P0-004, P0-007, P0-008 | Component and history integration tests |
| P0-010 | Versioned project schema and validation | Serialize and validate compatible project documents | P0-002, P0-003 | Schema/round-trip unit tests |
| P0-011 | Portable project bundle persistence | Export/import images and project data as one verified bundle | P0-004, P0-005, P0-009, P0-010 | Bundle round-trip and failure tests |
| P0-012 | Diagnostics, magnifier, and completion guidance | Improve placement confidence without doing registration | P0-008, P0-009 | Diagnostic unit and UI tests; manual magnifier check |
| P0-013 | Accessibility and responsive quality pass | Make the complete workspace operable and resilient | P0-005–P0-012 | Accessibility interaction tests and manual review |
| P0-014 | Integrated acceptance workflow and documentation | Prove and document the complete user journey | P0-011, P0-012, P0-013 | Happy-path Playwright test and doc review |
| P0-015 | Phase 0 definition-of-done verification | Audit the completed implementation without adding behavior | P0-001–P0-014 | Full automated suite plus manual exit checklist |

## 5. Explicit Phase 0 non-goals

Phase 0 does not include similarity, affine, projective, or any other registration/transform estimation; image warping; aligned blending, opacity previews, or flicker views; residual registration errors; automatic feature detection or matching; RANSAC; computer vision; segmentation; OCR; hole-shape or UDisc overlay extraction; hole, tee, basket, throw, corridor, route, or label detection; map overlays or satellite-provider/API integration; canonical course geometry; close-up registration; production graphic/video export; backend services; databases; authentication, accounts, authorization, payments, cloud storage, collaboration, telemetry, deployment infrastructure, CI/CD, plugins, provider abstractions, or production-scale asset management. It also does not add autosave, synchronized pane navigation, a mobile-first experience, or generalized annotation types.

## 6. Backlog completeness argument

P0-001 through P0-004 establish every indispensable correctness boundary before interactive behavior depends on it: a runnable/testable shell, plain project data, reversible domain edits, and isolated coordinate math. P0-005 through P0-009 deliver the complete local two-image correspondence editor, including every required creation, navigation, correction, list, keyboard, history, and dirty-state operation. P0-010 and P0-011 make the same authoritative state versioned, validated, hash-checked, portable with both originals, and recoverable on failure. P0-012 and P0-013 deliver the detailed plan's Phase 0D confidence, accessibility, visible-state, and narrow-layout requirements. P0-014 exercises the exact representative five-pair save/reopen workflow and documents it. P0-015 only audits those already-delivered behaviors against the exit gate.

Every ticket therefore maps to a documented requirement or an indispensable enabling boundary, and every required behavior maps to an owning implementation ticket plus proportionate verification. No final-ticket acceptance criterion asks P0-015 to implement missing behavior. Fifteen tickets provide coherent review units without splitting individual components, helpers, styles, test files, or configuration changes into administrative tasks.

## 7. Architectural boundaries

- **Project state:** Plain serializable TypeScript objects own project metadata, image metadata, complete point pairs, and optional view state. Decoded images, original bytes, file objects, selection, and pending gestures remain outside durable state; a minimal transient asset registry retains only assets reachable from current state or undo/redo.
- **Coordinate math:** Pure functions convert original pixels, normalized coordinates, and screen/view coordinates. Original pixel coordinates remain authoritative and device-pixel-ratio independent.
- **Domain mutations:** Explicit actions or coherent plain-data snapshots perform durable edits and feed undo/redo. Image-replacement entries retain runtime asset reachability separately so the old/new original can render; canvas gestures translate into actions and view navigation does not enter domain history.
- **Persistence:** Schema validation, compatibility rules, hashing, archive I/O, and repair/error results operate on plain domain data and image bytes.
- **Konva:** Konva renders the raster and markers and adapts pointer/drag input through coordinate conversion. Node state is never persisted or treated as authoritative.
- **Svelte UI:** Svelte composes controls, panes, lists, guidance, and transient editor state. It invokes domain actions and persistence operations rather than bypassing them.

No repository/service layer, event bus, dependency-injection framework, canvas abstraction, or future-CV extension point is planned.

## 8. Ambiguities and assumptions

- The overarching plan references a differently cased detailed-plan filename and older materials may say Chainline. The files present in the repository are authoritative, and all new backlog terminology uses ChainSpot.
- The detailed plan leaves the component framework conditional; the current planning brief selects SvelteKit, TypeScript, and Vite through SvelteKit.
- The overarching sketch includes future registrations, course geometry, render settings, history, and schema migrations. Phase 0 stores only its current project/images/correspondences/view data, and history is editor state rather than portable project content. No placeholder later-phase fields or migration registry is created until a second real schema requires migration.
- “Optional point-pair labels” in required scope conflicts with the final definition of done saying points can be labeled. The backlog includes labels as a required user capability; providing a label value remains optional per pair.
- The detailed plan calls several precision features “recommended before Phase 1” but also includes magnifier, marker visibility, diagnostics, and keyboard review in the Phase 0D deliverables. Those Phase 0D items are included; autosave and 1:1 view are not because no final exit criterion depends on them.
- A normal saved project contains only complete pairs. A pending half-pair remains transient; save provides resolve/cancel guidance rather than serializing it as incomplete.
- Pixel values are authoritative. Normalized values are included for inspection and portability, then checked/recomputed from pixels and intrinsic dimensions during compatible load.
- View state is optional project data. When present it may be restored, but fit/reset and responsive layout can choose a safe display transform without changing annotations.
- Image “orientation” means portrait, landscape, or square based on browser-decoded intrinsic dimensions. Phase 0 does not add an EXIF parsing/rotation pipeline.
- Replacing an image with different dimensions requires explicit confirmation to discard that role's points. Same-dimension replacement may retain points only through an explicit replacement path; hash verification prevents silent substitution.
- Missing bundle images produce a repair state that preserves safely readable metadata and annotations. The project is not treated as fully open until the user explicitly supplies a hash-compatible image or accepts the documented replacement/discard flow.
- P0-001 creates tiny synthetic PNG/JPEG fixtures for decoding and early image-workspace tests. P0-014 separately creates richer map-like fixtures with known landmarks for the full acceptance workflow; all fixtures remain repository-controlled and privacy-safe.

## 9. Future considerations

The following are non-binding and do not create Phase 0 work: IndexedDB autosave, a 1:1 view button, synchronized navigation, subpixel keyboard nudging, broader file/browser/mobile support, and all Phase 1+ registration, extraction, course, renderer, and productization capabilities. If validated later, a basemap provider boundary belongs to a later phase, not this workspace.

### Dependency decision

The only planned runtime dependency beyond SvelteKit/TypeScript/Konva is `fflate`, scoped to P0-011. Browsers provide File APIs, downloads, and SHA-256 through Web Crypto but no direct portable ZIP read/write API. A small, focused ZIP implementation materially reduces archive-corruption and interoperability risk compared with writing custom ZIP binary code. No validation, state-management, ID, hashing, accessibility, or utility package is planned.
