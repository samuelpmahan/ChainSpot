# Asset deployment conventions

ChainSpot deploys as a static site via `@sveltejs/adapter-static` — there is no
server, no build-time asset pipeline that prunes unused files, and no runtime
that decides what to ship. This doc exists because that fact is easy to miss
if you're used to backend deploys, where "add a file to the repo" and "ship a
file to production" are different, gated steps. Here they are the same step
for one specific directory, and nothing stops you from accidentally shipping
25 MB of scratch PNGs to the public site (it happened once — see
`architecture-teardown.md` §9).

## 1. `static/` is copied verbatim into the deployed site

`adapter-static` (see `svelte.config.js`) takes everything under `static/` and
copies it byte-for-byte into the build output, which is what gets published
(GitHub Pages, in this repo's case). There is no manifest, no tree-shaking, no
"is this referenced" check — a file's presence in `static/` is the only
condition for it being deployed. The app then fetches these files by URL at
runtime, the same way any static asset host works.

**Rule: `static/` may contain only files the running app actually fetches by
URL.** Nothing else — no reference material, no working files, no "I'll clean
this up later."

As of this doc, that allowlist is:

- `favicon.svg` — browser tab icon, fetched by the browser itself.
- `static/resources/chainspot_cv_templates/` (including its `manifest.json`)
  — the CV template set fetched at runtime by the basket/course-detection
  worker (`autoAnnotation/basketDetection.worker.ts` and friends load it over
  HTTP, not via bundler import, because it needs to be a plain fetchable
  directory rather than bundled binary data).
- `.nojekyll` — read by GitHub Pages itself (not the app) to disable Jekyll
  processing, which would otherwise mangle the `_app/` directory Vite/SvelteKit
  generates.

If you add a new file under `static/`, ask: *does client-side code `fetch()`
this by URL at runtime?* If not, it doesn't belong there — put it under
`resources/` (§2) instead. `tests/unit/staticAssets.test.ts` enforces this
allowlist as a failing test, not a code-review hope: it walks `static/` and
fails on anything not explicitly listed there.

## 2. Everything else is repo-only — never deployed

- `resources/` — CV ground-truth fixtures (`.chainspot.zip` bundles, golden
  JSON, template source images) used by `scripts/detect-*.ts`,
  `scripts/verify-cv-guardrails.ts`, and their unit tests. Large, and
  deliberately never copied into `static/`.
- `tests/fixtures/` — tiny synthetic images used by unit/e2e tests.
- `docs/` — this file and its neighbors.
- `scripts/` — CLI tooling (detectors, guardrail verification, fixture
  generators, CV probes). Runs under `tsx`/Python at dev/CI time only.

None of these are read by the deployed app. If something in one of these
directories needs to reach production, it has to be copied or generated into
`static/` explicitly (and then it's covered by rule 1's allowlist) — being in
the repo is not being deployed.

## 3. Linked data stays together

Several of the directories above hold files that only make sense as a group —
an image plus the annotations that describe it, a template plus the manifest
that calibrates it, a fixture plus the script that produced it. Keep these
physically together so nobody can copy, rename, or delete half of a pair:

- **Ground truth travels as `.chainspot.zip` bundles.** A CV regression
  fixture (e.g. `resources/GoldenTeeSet.chainspot.zip`,
  `resources/GoldenBasketSet.chainspot.zip`) packages the source image and its
  hand-verified annotations (`project.json`) into one file — the same format
  the product itself reads/writes via `persistence.ts`. Don't split an image
  out from its annotations into separate loose files.
- **Template images live beside their `manifest.json`.** The CV template set
  (`static/resources/chainspot_cv_templates/`) keeps every template PNG/JPG in
  the same directory as the `manifest.json` that declares calibration
  constants and lists the template file names. Adding a template image
  without updating that manifest (or vice versa) leaves the pair
  inconsistent; `loadValidatedCvTemplateManifest` validates the manifest
  against the directory contents at load time specifically to catch that.
- **A fixture's generator script is named in the fixture directory's
  README.** Where a `resources/` fixture is produced by a script rather than
  hand-authored (e.g. the `generate-*.mjs` scripts under `scripts/`), the
  fixture directory's README says which script made it, so the fixture can be
  regenerated instead of hand-patched when the format changes.

## Adding a new deployed asset

1. Confirm client code will `fetch()` it by URL — if instead it's imported
   through the bundler (`import x from './foo.png'`), it doesn't go in
   `static/` at all; let Vite bundle it normally.
2. Add the file under `static/`.
3. Add an entry (or extend an existing directory-prefix entry) to the
   allowlist in `tests/unit/staticAssets.test.ts`, with a one-line comment
   saying what fetches it.
4. Run `npm run test:unit` — the new file must be covered or the test fails.
