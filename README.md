# ChainSpot

A local-first creator tool that converts user-supplied disc golf round maps and clean basemaps into reusable, broadcast-ready hole graphics.

Planning and scope documents: `CHAINSPOT_OVERARCHING_PHASE_PLAN.md`, `CHAINSPOT_PHASE_0_DETAILED_PLAN.md`, and `Phase0Tickets/`.

## Prerequisites

- Node.js 22+ and npm
- A current Chromium-based desktop browser (the Phase 0 browser baseline)

## Setup

```sh
npm install
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server (Vite through SvelteKit) |
| `npm run check` | Strict TypeScript checking (SvelteKit sync + svelte-check) |
| `npm run test:unit` | Vitest unit and component tests |
| `npm run test:e2e` | Playwright browser tests on current Chromium |
| `npm run test` | Both unit and browser test suites |
| `npm run build` | Production build (static site via `@sveltejs/adapter-static`) |
| `npm run preview` | Preview the production build locally |

All commands are deterministic and run locally from a clean checkout after `npm install`.
The complete Chromium suite can take roughly 40 seconds on a development machine;
allow the command to finish after it yields its initial progress output. If Chromium
is not already installed for the locked Playwright version, run
`npx playwright install chromium` once before `npm run test:e2e`.

## Test foundation

- **Vitest** runs pure-logic and Svelte component tests in a `jsdom` environment. `jsdom` is a dev-only dependency, justified by the Phase 0 component/integration-test requirement; no Testing Library or other framework is used. Components are mounted with Svelte's native `mount`/`unmount` APIs.
- **Canvas in component tests** is intentionally unavailable. A small test setup shim returns `null` from `getContext()` because jsdom has no canvas implementation; actual Konva raster rendering is verified in Chromium rather than by adding a native canvas package.
- **Playwright** drives a current-Chromium project against the SvelteKit dev server and asserts the shell loads without console or page errors.
- **Synthetic fixtures** for deterministic image decoding live in `tests/fixtures/`; see `tests/fixtures/README.md` for the convention.
- **Integrated acceptance fixtures** are synthetic, repository-controlled map-like PNGs with five documented landmarks; regenerate them with `node scripts/generate-acceptance-fixtures.mjs`.
- **`fflate`** is the single runtime persistence dependency (P0-011). Browsers provide File, download, and SHA-256 (Web Crypto) primitives but no portable ZIP API; a small focused ZIP library avoids error-prone custom archive binary code. No validation, state, hashing, or utility packages are used.

## Phase 0 browser baseline

Current Chromium-based desktop browsers (Chrome, Edge, Brave) at recent versions. The application is browser-only: `npm run build` emits a static site, and no backend or deployment infrastructure is used.

## Usage

Load a UDisc overview as the source image and a clean map as the target image in the two panes, then use **Add correspondence** to click the same landmark in each image. Each completed pair appears once in the **Point pairs** list with its ordinal, label, native pixel coordinates, and normalized coordinates derived from the referenced image's intrinsic dimensions.

Pair management:

- **Select** a point: click a marker on a pane or the Source/Target entry in the list; the list, canvas marker, and exact-coordinate inspector stay synchronized by pair and side.
- **Label** a pair: type in the row's label field and press Enter or blur; cleared labels are stored as `null`.
- **Reorder**: use the row's ↑/↓ buttons, or select a pair and press `Ctrl/Cmd+ArrowUp`/`ArrowDown`. Ordinals regenerate; IDs and coordinates never change.
- **Enable/disable**: toggle the row's *Enabled* checkbox. Disabled pairs stay visible, selectable, and editable with a distinct appearance.
- **Delete**: use a row's **Delete** button, or select a point and press `Delete`/`Backspace`. Deletes are undoable.
- **Hide/show markers**: the toolbar **Hide markers/Show markers** control toggles overlay rendering only; it never changes project data, history, or selection.

Project persistence (entirely local, no network):

- **Save project** downloads a portable `*.chainspot.zip` bundle containing exactly `project.json` (schema version 1) plus the two original images at their manifest paths (`images/source-original.png`, `images/target-original.jpg`). The images are byte-identical to the uploaded originals, and the manifest SHA-256 hashes (native Web Crypto) always match the archived bytes. A successful save clears the unsaved-changes indicator; a failed save leaves the project usable and dirty so the save can be retried.
- **Open project** reads a selected bundle, verifies the archive, schema, paths, entry set, image hashes, and decoded dimensions before atomically replacing the project with a fresh, clean editor (empty undo/redo, no unsaved changes). Any non-repair failure leaves the current project, images, history, dirty state, selection, and pending state untouched.
- A **pending correspondence** is never saved silently: saving shows a dialog that either keeps the pending point (no save) or explicitly cancels it (no history) and saves.
- A missing or hash-mismatched bundled image opens an inspectable **repair** dialog instead of substituting a blank canvas. The live project stays intact; you can cancel, supply a local PNG/JPEG (an exact hash/type/dimension match restores the original atomically), or explicitly use the archived image, which follows the same replacement/discard confirmation rules as image intake.

History shortcuts (suppressed while editing a text field):

| Action | Shortcut |
| --- | --- |
| Undo | `Ctrl/Cmd+Z` or the toolbar **Undo** button |
| Redo | `Ctrl/Cmd+Shift+Z`, `Ctrl+Y`, or the toolbar **Redo** button |
| Move selected point by 1 px | `Arrow` |
| Move selected point by 10 px | `Shift+Arrow` |
| Delete selected point | `Delete` or `Backspace` |
| Cancel a pending correspondence | `Escape` |

## Stitch Map page

`/stitch-map` combines four higher-zoom screenshots of one map into a single higher-detail image before either downstream stage: `/annotate-round` (UDisc source capture; `/` redirects there) or `/create-graphics` (the correspondence workflow). The workflow is intentionally a controlled 2×2 screenshot compositor:

- **Capture protocol**: four screenshots at one fixed zoom/orientation, captured upper-left → upper-right → lower-left → lower-right with roughly 20–30% overlap, all at the same device/screenshot size. The first valid tile establishes the required dimensions; every other tile must match, and the requirement resets only when all four slots are empty. Each slot is protected against stale in-flight decodes: a newer selection, removal, or reset invalidates earlier decodes for that slot.
- **Shared crop**: one non-destructive crop (top/right/bottom/left insets in original pixels) applied to all four tiles, adjustable visually on the upper-left preview (edge-draggable handles) or with exact numeric fields, with **Reset crop** and a fit view. Crops that remove all width or height disable export and flag the offending fields.
- **Alignment**: the upper-left tile is anchored at `(0, 0)`; the other three are selected explicitly (canvas click on an exposed, non-overlapped region, or the selection buttons), then moved by dragging the selected tile, Arrow keys (1 px), Shift+Arrow (10 px), or exact integer `x`/`y` fields. Initial and reset arrangements use a rounded 25% overlap (integer-only placements). Export requires one **connected** arrangement: every tile must reach the upper-left anchor through positive overlaps along expected-neighbor edges. Visibility and opacity controls are preview-only and never change the exported PNG.
- **Shared viewport**: the Annotate Round and Create Graphics panes, the alignment view, and the crop view all use the same `ImageViewport` base — pointer-centered wheel zoom, background drag-to-pan, Fit, and resize anchoring — so navigation behavior is identical across surfaces. Viewport navigation is display state only and never changes image coordinates, crop values, tile placements, or readiness.
- **Export**: a native-resolution PNG whose bounds are the union of the four cropped placements, drawn at full opacity in stable order (upper-left, upper-right, lower-left, lower-right) with no resampling, no network request, and no stitch-session persistence (reload clears the session).
- **Handoff to Annotate Round / Create Graphics**: **Use as UDisc source** renders the PNG, holds it in an in-memory pending handoff, and navigates to `/annotate-round`; **Use as clean target** does the same and navigates to `/create-graphics`. Each destination shows a banner offering **Import** (through the normal image-intake and replacement rules, including point-discard confirmation, undo/redo, and dirty state, where applicable) or **Dismiss**. A pending handoff is never silently overwritten, and it survives round trips between the two pages until imported or dismissed.

The active editor for each stage also survives client-side navigation: `src/lib/editorSession.ts` retains the live `ProjectEditor` in memory per stage across `/annotate-round` ↔ `/create-graphics` ↔ `/stitch-map` moves, so loaded images, the project name, control points, undo/redo history, dirty state, and decoded image resources persist until a full page reload.

Phase 0.5 adds four new test cases (two unit, two browser) on top of P05-001's six, holding the combined Phase 0.5 total at the ten-case cap.

## Phase 0 acceptance workflow

The integrated acceptance test is `tests/e2e/integratedAcceptance.spec.ts` and runs as part of `npm run test:e2e`. It loads the two map-like fixtures, creates five distributed source/target correspondences, navigates both panes, corrects two markers by drag, labels a pair, deletes and restores a pair through Undo, reorders a pair, toggles Enabled, nudges a selected point by one original pixel, resizes the browser, and saves the bundle. It then reloads the application, reopens the downloaded bundle through the visible Open project file control, and compares every saved source/target pixel coordinate with the reopened value within one original pixel.

To repeat only this gate from a clean local checkout:

```sh
npm install
npm run check
npm run test:unit
npx playwright test tests/e2e/integratedAcceptance.spec.ts
npm run build
```

The baseline is a current Chromium-based desktop browser with Node.js 22+ and npm. The workflow is local-only: the browser reads local PNGs and the portable `.chainspot.zip` bundle, with no backend or network service. The bundle contains `project.json`, `images/source-original.png`, and `images/target-original.png`; original-pixel coordinates are authoritative, while normalized coordinates are derived for display.

Phase 0 creates editable correspondences only. It does not estimate alignment, warp or blend images, analyze imagery, extract overlays, upload to a backend, call map APIs, or export production graphics. A pending half-pair is transient and is never silently saved: finish it or explicitly cancel it in the save dialog.
