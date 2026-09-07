# ChainSpot v0.0 — Disc Studio

A local, manipulable design workbench for **DiscCard + DiscBattle**, not a video-operation system. Open with seven sample specimens and four cards already composed. No account, server API, course, map, CV, timeline, auto-advance, or score interpretation is needed.

## Open it

The delivered `ChainSpot-Disc-Studio.html` is a self-contained build of the actual Svelte frontend, not a mockup. Save it and open it in a modern browser. It makes no runtime network requests. Direct `file:` opening and native persistence were not browser-verified in the build environment; use the fixed localhost origin below for repeat use. If storage is unavailable, the header says **Not saved · session only** and **Save draft** downloads the workspace, including its embedded photos.

From a ChainSpot checkout with these additive files applied (Node 22+, existing locked dependencies):

```sh
npm ci
node node_modules/@sveltejs/kit/svelte-kit.js sync
node node_modules/vite/bin/vite.js --config experiments/disc-studio/vite.config.ts
```

Open `http://127.0.0.1:5174`. The sync command generates SvelteKit type metadata on a fresh checkout; it does not run CV. The Vite command starts only the new frontend entry, without an algorithm or corpus build. There are no new dependencies or lockfile changes. Keep the origin/port stable to reuse that browser's local draft.

The same component is also available through the existing SvelteKit app:

```sh
npm run dev -- --host 127.0.0.1
```

Open the printed origin plus `/disc-studio`. The old root page is deliberately untouched; it is not the entry for this product probe.

### Build a shareable file

```sh
node node_modules/vite/bin/vite.js build --config experiments/disc-studio/vite.config.ts
node experiments/disc-studio/pack.mjs
```

Output: `artifacts/disc-studio-site/ChainSpot-Disc-Studio.html`. The companion `index.html` and `assets/` are a normal static site too. To serve the production build:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 --directory artifacts/disc-studio-site
```

Open `http://127.0.0.1:4174`. This origin has a different local draft from port 5174; use Save draft / Load to move it. No deployment was performed.

## What to manipulate

**Disc shelf.** Select a sample or create a blank disc, enter only the facts known, add a photo, duplicate a specimen, search, and reuse it. Two Buzzz specimens deliberately have different identities. Removing a battle entry does not delete its disc. Deleting a disc in use is blocked with a visible explanation.

**DiscCard.** Switch between showcase and compact layouts, name-first and flight-number-first hierarchy, ink and paper surfaces, optional specimen details, and contain/cover imagery. Preview idle, highlight, or winner treatment; Compare states shows the same card in all three treatments. These are experiments, not approved brand or placement decisions.

**DiscBattle.** Compose up to four entries, reduce to three (or fewer while editing), reorder, or replace a disc without losing the entry's score. Click a card/row to inspect; use Highlight to change the graphic. Edit scores directly or with +/−. The star toggles a manual winner treatment. Multiple winner treatments are possible; no highest/lowest-score rule is encoded. Clear emphasis removes treatments without changing scores.

**Readability.** Change row/stack/grid and the explicit output width; switch neutral, light, dark, or busy contrast backdrops. Fit reports its display scale. `1:1 pixels` disables downscaling and permits scrolling. These widths and backdrops are editor test conditions, not coordinates in a video. A small nominal per-card width produces a density warning, not a claim that larger widths guarantee readability.

**State.** State exposes domain, composition, presentation, and editor-only values separately. Save draft / Load is a minimal workspace transfer, not an image/video export system. Reset and valid import ask before replacing the current workspace.

## Smallest implemented object model

| Layer          | Objects                                                   | Meaning                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain         | `Disc`, `FlightNumbers`                                   | One authored physical specimen: stable ID, manufacturer, mold, specimen detail string, nullable numbers, nullable photo. No owner, catalog key, CV source, score, layout, or selection. |
| Composition    | `DiscBattle`, `BattleEntry`                               | One ordered composition of entry IDs referencing disc IDs. Score belongs to the entry, not the disc. The same disc can appear in different entries with independent scores.             |
| Presentation   | `CardAppearance`, `BattleAppearance`, `BattleVisualState` | Layout, hierarchy, surface, image fit, score visibility, manually highlighted entry and manually emphasized entries. Saved independently of domain facts.                               |
| Editor/session | Local Svelte state in `DiscStudio`                        | Selected disc/entry, open panels, search, preview width/backdrop, fit, single-card specimen state, last manual score change. Not serialized into the reusable workspace.                |

`Workspace` is a versioned local draft envelope, not another domain entity. `DiscCard` is a renderer, **not** a second stored copy of a disc. A future manual form, catalog adapter, or recognition adapter can produce the same `Disc` shape; none needs to dictate the renderer or battle controls. Producer metadata can remain outside this small domain until a real use requires it.

Flight values are authored ratings, not predictions of a physical specimen's actual flight. Unknown is `null`, displayed as an em dash; it is not silently converted to zero. A mold catalog could later fill a specimen's fields without requiring a catalog entity or ownership system now.

The entry limit of four and draft limit of 100 discs are explicit prototype/storage bounds, not universal domain rules. Highlight currently exposes none/one; emphasis is a set. If feedback requires multi-highlight, change the presentation state and control, not Disc or score semantics.

### One execution path

```text
samples / local photo + manual fields / validated draft
                         ↓
                  Workspace + editor state
                         ↓
          DiscStudio's explicit manual actions
                         ↓
                 BattleView → DiscCard → DiscImage
                         ↑
              direct DiscCard specimen view
```

`DiscCard` and `BattleView` read their supplied props; they do not infer scores, declare winners, store drafts, run algorithms, or advance time. The standalone app, SvelteKit route, and Storybook stories use those same renderers. The transient score delta is the previous and new value of the last manual edit; it persists until another edit or clear. It is not an event log, timing rule, animation trigger contract, or production workflow.

## Reuse audit and deliberate exclusions

See `SOURCES.md` for inspected references and source custody.

- **Reuse ChainSpot's Svelte 5 / Vite / static frontend toolchain.** Add a thin route and an isolated Vite entry; keep existing routes, package configuration, lockfiles, and algorithm files intact.
- **Reuse the evidence-workbench's projection discipline and Storybook discovery convention.** Views take data and view arguments; they do not become another producer. Product stories live under `Product/DiscCard` and `Product/DiscBattle`. The card specimen wrapper supplies explicit width for Storybook's centered layout. Existing global Storybook setup materializes badge specimens; that setup is not a dependency of this standalone workbench. Stories were typechecked, not launched or visually accepted in Storybook during this pass.
- **Borrow WumpusLab's visible selection and inspectable actual/alternate controls.** Keep editing focus distinct from the state shown by the output.
- **Borrow ChessLab's pure story projection and “edit is not play” boundary.** Changing a score or showing a winner is a manual visual manipulation, not a claim about a creator's process.
- **Ignore course/round/geo/session/CV objects, algorithm execution, PxC/PQL/PCR runtime, Konva/map rendering, and evidence provenance infrastructure.** These do not help Nicole or Lexi react to a card. There is no benefit to bringing an investigation engine into this state model.

No reusable disc-specific domain model or general product design-system component was found in the inspected frontend. The existing evidence-inspection components are domain-specific. New local component styles and semantic native controls are easier to change than extracting a generalized design system now.

## Iteration map

| Change                                                             | Edit                                      |
| ------------------------------------------------------------------ | ----------------------------------------- |
| Fields, state boundaries, pure entry operations, import validation | `src/lib/disc-studio/model.ts`            |
| Seed specimens                                                     | `src/lib/disc-studio/samples.ts`          |
| Card geometry, typography, score treatment                         | `src/lib/disc-studio/DiscCard.svelte`     |
| Photo display / clearly marked no-photo illustration               | `src/lib/disc-studio/DiscImage.svelte`    |
| How multiple cards compose                                         | `src/lib/disc-studio/BattleView.svelte`   |
| Preview scaling and contrast backdrop                              | `src/lib/disc-studio/PreviewStage.svelte` |
| Shelf, inspector, manual controls and editor-only state            | `src/lib/disc-studio/DiscStudio.svelte`   |
| Local draft storage and bounded photo preparation                  | `src/lib/disc-studio/localDraft.ts`       |
| Repeatable isolated visual cases                                   | `src/lib/disc-studio/*.stories.ts`        |

No template registry, plugin architecture, generic stores, backend schema, account system, or animation engine was added. CSS appearance options are deliberately ordinary editable branches. The renderer has explicit props that a future delivery mechanism can consume without turning that mechanism into today's domain model.

## Images and local persistence: exact scope

The seven seeds have realistic names and manufacturer ratings but **fictional specimen descriptions and marked CSS illustrations**, not stock images or photos of physical discs. No image-generation service, product photo downloads, or runtime external image URLs are used. Upload your own exact-disc photo to assess real stamps, finishes, and framing.

Upload accepts JPEG, PNG, and WebP up to 15 MB. It decodes in the browser, retains the full image frame/aspect ratio, bounds the longest edge to 1000 pixels, and stores a JPEG copy. Transparency is flattened onto a light background. **The original file bytes, original full resolution, metadata, and alpha channel are not retained.** This is a bounded visual probe, not an archival asset pipeline or finished transparent-overlay export. Cover is only a display crop; Contain shows the full prepared frame. No background removal or recognition occurs. HEIC/SVG and larger images are rejected visibly.

One draft lives under `chainspot.disc-studio.v1` in localStorage, with a 300 ms save debounce. Image copies are embedded. Each photo is bounded to 850,000 characters; the whole draft is bounded to roughly 4.5 MB and the browser's actual quota may be lower. Storage errors are explicit and leave the session usable. Invalid saved data is not silently overwritten. There is no multi-tab synchronization or cross-device account. Download a JSON draft before resetting or moving browsers. A draft includes the photos, so share it intentionally.

## Validation and exact replay

```sh
# Initialize framework metadata on a cold checkout
node node_modules/@sveltejs/kit/svelte-kit.js sync

# Focused code/type validation (does not traverse unrelated CV checks)
node node_modules/svelte-check/bin/svelte-check --tsconfig experiments/disc-studio/tsconfig.json
node node_modules/vitest/vitest.mjs run --config experiments/disc-studio/vitest.config.ts

# Standalone production build and self-contained artifact
node node_modules/vite/bin/vite.js build --config experiments/disc-studio/vite.config.ts
node experiments/disc-studio/pack.mjs

# Browser checks against a running standalone dev server on port 5174
# Install Playwright's Chromium once on a network-enabled machine if needed:
node node_modules/playwright/cli.js install chromium
node experiments/disc-studio/smoke.mjs

# Or check the production server on port 4174
BASE_URL=http://127.0.0.1:4174 node experiments/disc-studio/smoke.mjs

# Existing SvelteKit static integration
node node_modules/vite/bin/vite.js build
```

The browser smoke test starts isolated contexts, makes local edits, uses a **synthetic labeled image fixture** to exercise the real file decoder, and writes screenshots and a receipt into `artifacts/disc-studio-proof/`. It never touches an existing user's profile. See `VALIDATION.md` for results and limitations, including the exact alternate rendering invocation used in this environment.

## First product read, not a usage prescription

Nicole's useful experiment is to replace a sample with a photo of an actual disc, reuse it from the shelf, and judge whether enough identity survives in the card. Lexi's is to change hierarchy, density, surface and emphasis at realistic widths, then describe which differences deserve motion. Sam can inspect the state while each change happens and modify the relevant renderer directly. None of these experiments specifies when a creator must operate a control in a video.

Visual inspection here found the normal four-card view and three-card compact view coherent. The default four-card 960px composition becomes tiny when fit to a phone; the preview explicitly reports 33% display scale there. This is not a claim of polished mobile overlay readability. A narrow stack is another available experiment. Real-disc photo aesthetics and collaborators' repeated-use behavior remain unobserved.

## Source custody and checkpoint

Live GitHub reads inspected ChainSpot `main` and `lab/stages`, Wumpus `lab/wumpus-core`, and ChessLab `main`. Shell networking could not clone GitHub. Execution used the supplied **ChainSpot-Sweep-Ready-no-chromium(1).zip**, whose manifest identifies implementation `9a6a69e1e5c6568fe1875faa8d303f7de4677824` and remote head `60f53cd9ae8ab210dc73aa884086e315dccbe0a2` on `lab/dev-pathfinding`.

That archive has no `.git`. It was committed locally as a labeled source snapshot (`229e04c`) before any feature changes. The work is on local branch `task/disc-studio-v00`. **The local checkpoint has archive-snapshot ancestry, not reconstructed upstream ancestry. No branch has been pushed, no PR created, and nothing landed or deployed.**

All feature changes are additions in four paths: `src/lib/disc-studio/`, `src/routes/disc-studio/`, `experiments/disc-studio/`, and `tests/disc-studio/`. Apply the delivered format-patch to a new branch of the intended real checkout with `git am /path/to/ChainSpot-Disc-Studio.patch`; Git checks collisions rather than overwriting existing files. The resulting upstream-based commit will naturally have a different SHA. The delivered Git bundle preserves the exact local checkpoint and source snapshot for audit/replay.
