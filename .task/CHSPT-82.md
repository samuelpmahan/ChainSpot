# CHSPT-82 — Frontend rebuild — rederive the MVP from a clean-room app (bootstrap only)

## Goal

Quarantine the existing application implementation under `old-stuff/` and bootstrap a
genuinely fresh, minimal SvelteKit app at the repository root whose complete visible
product at `/` is `<h1>Stitch Map</h1>`. No feature migration in this task.

## Required behavior

- All old application/build implementation (src, tests, scripts, resources, static
  assets, app docs, package/build/test config) lives under `old-stuff/`, unmodified,
  as read-only reference material with a README stating the archive rule.
- Repository governance/workflow material stays at root: `.git`, `.github`,
  `AGENTS.md`, `CLAUDE.md`, `.task/`, `CHANGELOG-dev.md`.
- A fresh minimal SvelteKit application exists at root: `src/routes/+layout.svelte`
  and `src/routes/+page.svelte`, plus only the config/type files SvelteKit requires,
  all newly written (not restored from the old app).
- `npm install` then `npm run dev` serves `/` rendering only `Stitch Map` as an H1,
  browser-default presentation.
- The new app imports nothing from `old-stuff/`.
- Dependency surface is minimal and each dependency is explainable.

## Non-goals

- No Stitch Map functionality, image loading, viewport, stitching math, persistence,
  session state, CV, Konva, nav, demo tooling, or styling.
- No compatibility wrappers around or imports into `old-stuff/`.
- No preservation of old unit/e2e suites in runnable form.
- No deployment, no merge to main.

## Known context

- Old app: SvelteKit (Svelte 5 runes, static adapter), routes under
  `src/routes/{annotate-course,map-round,create-graphics,stitch-map,demo,ribbon-editor}`,
  large `src/lib` (domain/editor/session/CV/stitch), Vitest + Playwright suites,
  fixture generators in `scripts/`, ~resources and static demo assets.
- `.github/workflows/deploy-pages.yml` deploys only on push to `main`; this branch does
  not trigger it. It will need rework before any future production merge of the rebuild
  (out of scope here; noted so it isn't forgotten).
- Root `README.md` documents the old app and moves to quarantine; a short fresh README
  takes its place.

## Acceptance

- `old-stuff/` contains the old implementation and an archive-rule README.
- Fresh root app: `npm run dev` serves `/` showing only the H1 `Stitch Map`.
- `npm run check` (svelte-check) and `npm run build` pass for the new app.
- `grep` over new `src/` finds no reference to `old-stuff`.
- Governance files remain at root; `CHANGELOG-dev.md` untouched until merge prep.

## Proof Plan

- Highest-value invariant: the served page at `/` contains exactly one `<h1>` with text
  `Stitch Map` and no legacy routes respond. Proof: start `npm run dev`, curl `/`
  and assert the H1; curl a legacy route (e.g. `/annotate-course`) and assert 404.
- Isolation invariant: no new-app import references `old-stuff/`. Proof: grep new
  `src/`, config files, and `package.json` for `old-stuff`; expect zero matches.
- Build health: `npm run check` and `npm run build` succeed from a clean install
  (`npm ci` after lockfile creation) — this is the regression test that fails if the
  minimal config is wrong.
- Manual browser verification is not required for this bootstrap: the behavior is a
  static H1, fully provable by fetched HTML; visual/pointer behavior is out of scope.
- Limitation: automated proof cannot show that quarantine judgment calls (what counted
  as "governance" vs "application") match intent — the file-by-file move list is
  reported for human review instead.

## Slice 1 — single screenshot load & display

User action: the user selects one screenshot file, and the app displays it with
its native pixel dimensions.

### Contract

- `src/lib/image.ts` — plain TypeScript, no Svelte imports (service layer wrapping
  the browser boundary):
  - `interface LoadedImage { readonly file: File; readonly objectUrl: string;
readonly widthPx: number; readonly heightPx: number }` — immutable.
  - `type LoadImageResult = { ok: true; image: LoadedImage }
| { ok: false; reason: 'not-a-decodable-image' }` — discriminated union;
    expected failures are returned as values, not thrown.
  - `async loadImageFromFile(file: File): Promise<LoadImageResult>` — decodes via
    `createImageBitmap` to obtain native pixel dimensions (bitmap closed after
    reading them); display URL via `URL.createObjectURL`.
  - `releaseImage(image: LoadedImage): void` — revokes the object URL.
- `src/routes/+page.svelte` owns the state: `image: LoadedImage | null` and
  `error: string | null` as Svelte 5 `$state` runes. No store; the page is the
  sole owner for now.
- `<input type="file" accept="image/*">` with an `onchange` handler. On success
  show `<name> — <w> × <h> px` and `<img src={objectUrl}>`; on failure show a
  plain error paragraph and clear the image. No CSS at all (deliberate:
  functionality and contracts first).
- Replacing an image must `releaseImage()` the old one.
- Race guard: a selection sequence counter, so a slow decode that completes after
  a newer selection is dropped and its object URL released immediately.

### Proof Plan (slice 1)

- `npm run check` and `npm run build` stay green.
- Manual, in `npm run dev`: select a real screenshot; the name/dimensions line and
  the image render. Select a `.txt` file; the error paragraph shows and no image
  remains.
- Replacement + race behavior: select image A then image B; only B renders.
  Optionally inspect devtools for revoked/leaked `blob:` URLs.
- Limitation: the race guard's timing window is not deterministically provable by
  hand; it is proven by code review of the sequence-counter logic in this slice.

## Slice 2 — multi-image intake + round-screenshot selection

User action: the user uploads up to 6 images (course-blank tiles plus their
thrown-round screenshot), sees them all, and marks which one is the round
screenshot. (Later CV will propose this; user selection is also the visual
confirmation step.)

### Contract

- `src/lib/image.ts` unchanged.
- `+page.svelte` state: `images: LoadedImage[]` (max 6), `roundIndex: number |
  null`, `error: string | null`. File input gains `multiple`; each selection adds
  to the set. Non-decodable files and over-limit files are skipped and named in
  the error line; decodable ones still land.
- Each image renders with its name/dimensions line, the image itself, and a radio
  ("this is my round screenshot"); exactly zero or one can be marked.
- "Clear all" releases every object URL and resets all state.
- Race guard: sequence counter survives; late decode batches after a newer
  selection or a clear are dropped and released.

### Proof Plan (slice 2)

- `npm run check` / `npm run build` green.
- Manual: multi-select several screenshots at once → all appear; add more in a
  second selection → appended; exceed 6 → overflow named in error, first 6 kept;
  include a bogus file → named in error, others still added; radio-mark one;
  Clear all empties the page.

## Slice 3 — ImageViewport + minimal AutoCrop/AutoStitch (2 tiles + round)

Objective: a coherent stitch-map flow for 2 course tiles + 1 thrown-round
screenshot. Algorithms are minimal clean rederivations (never imports from
old-stuff/), pure TS over plain arrays so CLI/Vitest can drive them; the LAB
can later benchmark them against the old corpus.

### Division of labor (coaching mode amendment)

Claude writes the pixel-math lib modules; the user types all Svelte components
and page orchestration, coached.

### Contract

- `src/lib/raster.ts` (Claude) — the only browser-touching helper: decode to
  `{ widthPx, heightPx, gray: Uint8Array }` grayscale rasters.
- `src/lib/autoCrop.ts` (Claude) — pure. 2-tile cross-capture agreement scan:
  chrome is bit-identical at fixed screen coordinates across captures; scan
  inward from each edge until tiles stop agreeing; return proposed insets.
  Proposal only — user confirms; never silently applied.
- `src/lib/stitch.ts` (Claude) — pure translation-only search: two cropped
  rasters → best `{ dx, dy, score }` (same device/zoom capture protocol makes
  rotation/scale out of scope).
- `src/lib/components/ImageViewport.svelte` (user) — the single image-handling
  viewport for the whole flow. Renders N positioned layers:
  `{ objectUrl, x, y, widthPx, heightPx, borderColor, opacity }`. Zoom (wheel,
  cursor-anchored) + pan (drag). Per-layer colored border and opacity so
  overlap can be inspected. Layer nudging for manual adjustment. Emits
  adjustments up ("props down, events up"); owns only view state (zoom/pan),
  never document state.
- Page flow: intake (slice 2) → auto-crop proposal + confirm → auto-stitch →
  viewport inspection/adjust → confirm. Unstyled beyond what inspection needs.

### Proof Plan (slice 3)

- `npm run check` / `npm run build` green.
- Lib modules provable headless (Vitest/CLI with synthetic rasters): agreement
  band detected on synthetic chrome; known-offset synthetic pair recovered by
  stitch search.
- Manual: two real UDisc tiles + round screenshot through the full flow; crop
  proposal looks sane and is confirmable; stitched placement inspectable via
  zoom/opacity; a deliberate misalignment is nudgeable then confirmable.
