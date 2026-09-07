# Disc Studio validation — 2026-09-07

## Scope and environment

Executed on the supplied source snapshot described in README, not a fresh clone of today's entire upstream repository. Final validation ran after the formatting and bounded integration fixes. Node 22.16.0; Svelte 5.56.10; SvelteKit 2.70.3; Vite 6.4.3; Vitest 4.1.11; Playwright 1.62.1; system Chromium 144.0.7559.96.

| Check                                                              | Observed result                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Focused Svelte / TypeScript check, including new route and stories | 0 errors, 0 warnings                                     |
| Pure model and local-draft tests                                   | 20 tests passed                                          |
| Standalone Vite production build                                   | Passed; same Svelte components, 120 modules; no CV build |
| Self-contained HTML packing                                        | Passed; approximately 112 KB, no external runtime assets |
| Existing SvelteKit static application build                        | Passed; `/disc-studio` included in static output         |
| Browser interaction suite on compiled HTML                         | 25 checks passed; no uncaught JavaScript errors          |
| Human-style visual inspection by the implementing agent            | Actual screenshots opened and inspected; details below   |
| Existing full CV test suite                                        | Not run                                                  |
| Storybook runtime / visual stories                                 | Not run; stories typechecked only                        |
| Native hosted-route hydration and native persistent localStorage   | Not browser-verified in this environment                 |
| Nicole / Lexi / real user acceptance                               | Not yet observed                                         |

A separate clone of the delivered Git bundle rebuilt byte-identical standalone HTML and passed the 20 unit tests using the installed dependency directory. This cold-source check found that a new checkout needs `node node_modules/@sveltejs/kit/svelte-kit.js sync` before standalone Vite reads source TypeScript; the run instructions now include that step. This was not a fresh network dependency installation.

The full application build retains an existing large-chunk warning from the older app. The isolated Disc Studio output is separate. No claim of a clean unrelated repo-wide typecheck/test suite is made.

## Browser execution limitation, not hidden

System Chromium has a managed URL blocklist covering all normal navigations. A localhost navigation failed with `ERR_BLOCKED_BY_ADMINISTRATOR`. No browser policy was altered.

The actual production HTML was instead loaded into Chromium's `about:blank` document using Playwright `page.setContent`. This executes the compiled Svelte frontend, CSS, native inputs and local image decoder. Main screenshots use unmodified opaque-origin behavior, so storage is unavailable and the app reports **Not saved · session only**. This is why that warning appears in the proof; it is not silently removed from application logic.

The autosave/remount integration case separately uses an explicitly injected in-memory Storage fixture. It proves the application's serialization/save/restore wiring, **not persistence in a normal browser profile**. The normal URL variant of `smoke.mjs` uses native storage and is provided for the next environment.

Exact invocation used here, after building and packing:

```sh
CHROMIUM_PATH=/usr/bin/chromium node experiments/disc-studio/smoke.mjs --offline
```

Screenshots and the machine-readable `receipt.json` are generated in `artifacts/disc-studio-proof/`. Screenshots are delivered with the handoff instead of adding generated proof binaries to product source.

## What the browser suite exercised

Cold start with seven distinct specimens/four cards; visible unavailable-storage failure; editing selection independent of graphic highlight; manual highlight independent of score; signed fractional score input and real last-edit delta; independent manual winner; reorder identity preservation; three-card composition without deleting source discs; compact/paper/dark treatment; density warning; row/stack/grid; single-card idle/highlight/winner comparison; real local file decoding with full aspect ratio; contain/cover presentation; unsupported image rejection; new/duplicate specimens and unknown ratings; unused-disc deletion; search and add-to-battle; replacement preserving entry and score; invalid import rejection; save/remount with the labeled fixture; confirmed valid import/cancellation; confirmed reset; 390px viewport without document overflow and operable score controls; no uncaught runtime errors.

The upload test uses a synthetic 600×360 PNG labeled **PHOTO PIPELINE TEST — Synthetic fixture · not a disc photo**. It tests the real browser File → image decode → canvas JPEG preparation → DiscImage path. It does not establish the aesthetics of actual disc photos, transparent cutouts, reflective stamps, or difficult backgrounds.

## Visual observations and corrections

Opened actual PNG output, not just DOM/test counts:

- `02-default-desktop.png`: shelf at left, live result in the center, selected-disc facts and appearance at right. Four cards show manufacturer, mold, specimen note, numbers, scores and an independent highlight. Initial inspection led to larger sample illustrations and stronger secondary-text contrast.
- `03-compact-three-manual-states.png`: three compact paper cards with Zone highlighted at -2.5, Buzzz manually marked winner, and Destroyer idle. A score change is visible without animation or automatic sequencing.
- `04-stack.png`: same composition at a 320px output width in a vertical stack; the preview labels its actual output dimensions and 100% display scale.
- `05-grid.png`: same entry data and manual treatments in a grid; no composition rewrite.
- `06-card-workbench.png`: single card with flight-first hierarchy and the idle/highlight/winner contact sheet.
- `07-image-pipeline-contain.png` / `08-image-pipeline-cover.png`: synthetic input shows full prepared frame in Contain; Cover crops the display, not stored image data.
- `09-mobile.png`: controls remain usable without document overflow at 390px. A four-card 960px output fitted to this viewport is only 33% scale and too small for serious detail assessment. The UI reports that scale; use 1:1 inspection or an alternative layout. This is a mobile smoke check, not mobile-design acceptance.

## Relevant failed attempts, retained in this report

Shell clone/dependency downloads were unavailable because DNS/network access failed, so execution used the supplied runtime bundle. The archive lacked Git metadata and executable flags; it was labeled as a local source snapshot, and explicit Node entrypoints were used. Early focused checks caught a non-reactive input binding, missing standalone typecheck alias and a Storybook generic mismatch; these were fixed before final validation. The first cold-source bundle build failed because `.svelte-kit/tsconfig.json` had not been generated; explicit SvelteKit sync fixed the bootstrap requirement, and the subsequent build matched the delivered HTML byte for byte. Normal browser URL navigation was blocked as described above, not reported as a pass.

## Next validation boundary

Open the prototype on a normal fixed origin, add an actual disc photo, close/reopen the browser, and verify the local shelf and composition return. Then let Nicole and Lexi judge real-disc identity and small-size readability. No export workflow, automatic state transition, timing, or engagement claim is inferred from the current proof.
