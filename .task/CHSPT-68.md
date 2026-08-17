# CHSPT-68 — Fetch Clean Target happens inside the Clean target viewport

## Goal

The clean-target fetch flow moves into the Clean target pane itself: an empty pane
invites a dismissable location modal (search / saved-location prefill / manual
coordinates behind advanced), a chosen location shows the aerial preview in the pane,
and one "Use as clean target" commits it — with the UDisc source pane visible beside it
the whole time. The standalone "Fetch clean target from USGS NAIP" section disappears
from both of its current positions.

## Required behavior

- With no clean target committed, the Clean target pane walks a first-time user from
  course name to committed aerial: modal search → in-pane preview → one commit, UDisc
  source visible throughout.
- The location modal overlays ONLY the Clean target pane, follows the existing
  `focusManagement.ts` dialog conventions (`dialogKeyboard`, `isModalOpen` gating of
  global shortcuts), and is dismissable; dismissal lands on a usable pane (existing
  upload affordance + a reopen-search control), never a dead end.
- Choosing a location replaces the modal with the aerial preview in the pane; one commit
  decision at a time ("Use as clean target"), one discard; preview is exactly what
  commit produces.
- Progressive disclosure: manual coordinates behind an advanced toggle in the modal;
  exact-area selection and tile-grid fetch behind an explicit advanced affordance in the
  preview state — capabilities kept, not ambient.
- Known state shortens the path: saved location / recognized course / a CHSPT-65 arrival
  pre-fills the modal rather than adding banners. The CHSPT-65 above-the-panes placement
  of the section (`cleanTargetFirst()` render) becomes obsolete and is removed.
- After an alignment exists, verify the whole annotated course maps inside the committed
  aerial's bounds. If geometry falls outside AND the target is geo-referenced (retained
  `targetGeoCenter`/`targetGeoRadiusMeters`), offer a re-fetch that expands/re-centers to
  full coverage. The re-fetch must never silently lose placed correspondence points:
  remap them deterministically (same 2048px raster size → `replaceImage` with
  `retainPoints: true`, then `movePoint` per pair through the shared equirectangular
  pixel↔geo mapping). Non-geo-referenced targets get the coverage warning only.
- Investigate DiscGolfScene and DGCourseReview as course-location sources via sanctioned
  APIs/permission ONLY — no scraping, no ToS violations. A written finding on the ticket
  is a complete outcome if access isn't sanctioned.
- Plain-language labels; nothing assumes NAIP/mosaic/ground-scale vocabulary.

## Non-goals

- No changes to NAIP tile math or fetch internals beyond what the coverage re-fetch
  requires.
- No capability removal — manual coordinates, exact-area selection, and tile grid stay
  reachable, just not ambient.
- Preserve per-fetch-shape ground-scale/georeference rules: only the radius-based center
  fetch sets `targetGroundScaleMetersPerPixel`/`targetGeoCenter` (distance display and
  elevation profile depend on them); exact-selection and grid commits keep them null.
- No redesign of the source pane, correspondence, alignment, or hole-graphics areas; no
  app-wide modal system.
- Direct upload into the Clean target pane untouched.
- No scraping of DiscGolfScene/DGCourseReview or any source.

## Known context

- Branch base: CHSPT-65 is reviewed and accumulating on `staging/demo` en route to
  `main`; per the user's explicit instruction this branch is cut from
  `origin/staging/demo` (tip `7cf899e`) and will be rebased onto `main` once CHSPT-65
  lands there. (Deviation from the workflow's "never base on staging/*" rule, authorized
  by the user for this task.)
- Everything lives in `src/routes/create-graphics/+page.svelte`: the `naipFetchSection`
  snippet (rendered above the panes via `cleanTargetFirst()` and below them otherwise),
  geocode state/handlers, NAIP preview/commit handlers, coverage-box/grid/exact-selection
  handlers, and the per-fetch-shape state (`targetGroundScaleMetersPerPixel`,
  `targetGeoCenter`, `targetGeoRadiusMeters`).
- Commit paths all route through `intakeImageFile` (discard confirmation, undo/redo,
  dirty state) — the in-pane commit must keep doing so.
- `ProjectEditor.replaceImage({ retainPoints: true })` requires identical dimensions;
  radius fetches are always `NAIP_EXPORT_SIZE_PX` (2048) square, so a geo-referenced
  re-fetch qualifies. `movePoint(pairId, 'target', coords)` remaps individual points.
- Geo mapping building blocks: `bboxFromCenter` (`src/lib/naip.ts`),
  `naipImageGeoReference` (`src/lib/elevationProfile.ts`), alignment transform
  (`src/lib/alignment`). Both old and new rasters use the same linear equirectangular
  mapping, so old-pixel → geo → new-pixel is exact and deterministic.
- Dialog conventions: `src/lib/focusManagement.ts` (`dialogKeyboard` action traps
  Tab/Escape; `isModalOpen()` already gates the page's global shortcuts).
- Keyed vs keyless geocode rules (Google script-injection gating via `MapConfirm`,
  attribution per provider) must survive the move into the modal.
- Existing tests touching the section: `tests/unit/geocodeSearchKeyed.test.ts`,
  `geocodeSearchKeyless.test.ts`, `courseLocationCache.test.ts`, `thrownRoundFlow.test.ts`,
  `tests/e2e/naipCleanMap.spec.ts` — update to the new flow, don't delete coverage.
- Six AnnotationWorkspace pointer-interaction unit suites are known-red in remote
  containers at clean HEAD; unrelated to this task — do not fix, do not inherit helpers.

## Acceptance

- With no clean target, the Clean target pane offers the location search; the modal
  overlays only that pane, is dismissable, and dismissal leaves upload + reopen-search
  available.
- Choosing a location shows the aerial preview in the pane; a single "Use as clean
  target" commits exactly the previewed image through the normal intake path.
- After commit the pane is today's normal correspondence viewport; re-fetch/replace is
  reachable without a resurrected standalone section.
- The `naip-fetch` section is gone from both positions.
- With an alignment established and course geometry exceeding the aerial's bounds, the
  user is told; for geo-referenced targets a re-fetch expands to full coverage and
  placed pairs survive with deterministically remapped target points — never silent loss.
- Ground-scale/georeference behavior per fetch shape is unchanged (radius fetch sets
  them; exact/grid/upload commits leave them null and features degrade as today).
- Manual coordinates and exact/grid paths reachable behind advanced affordances.
- DiscGolfScene/DGCourseReview findings recorded on the ticket; integration only if
  sanctioned.
- Direct upload behavior unchanged.

## Proof Plan

_To be completed by the implementing agent before production-code changes._
