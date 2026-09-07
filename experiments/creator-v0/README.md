# ChainSpot Creator v0.0

DiscCard + manually controlled DiscBattle + a basic reusable local disc shelf.
This is a product/design probe, not a new course workflow, video editor, or catalog service.

## Open it

No npm installation is needed for this isolated prototype. From the repository root:

```sh
python3 -m http.server 4173 --directory static
```

Open `http://localhost:4173/creator-v0/index.html`.
Keep the same scheme, hostname and port between visits: the local shelf belongs to that browser origin.
Use HTTPS on any eventual public host. No deployment is included in this checkpoint.

To produce a single file that can be shared without a build environment:

```sh
node experiments/creator-v0/build.mjs /tmp/chainspot-creator-v0.html
```

Open the resulting HTML file in a browser, or serve it from a stable local origin. File-origin
storage support varies by browser; the UI reports storage failures and supports downloadable
backups rather than pretending a failed save succeeded. The generated file embeds all code,
styles and sample artwork; there are no CDN resources, tracking requests, accounts or API keys.

The single-file packer is a deliberately finite adapter for these four named modules, not
an attempt to create bundler infrastructure. Edit the source modules, then rebuild the artifact.

## First two minutes

1. Click DiscCard. Pick a sample disc; change layout, size, theme or position.
2. Edit details & photo. Upload a photo of the actual physical disc. Its entire frame is retained.
3. Add discs to DiscBattle using the shelf's plus buttons. Enter any score text and highlight
   any entry. Selecting something to edit does not change the highlighted entry.
4. Save overlay PNG for a transparent still of the current state. Save backup to retain your
   shelf, embedded photos, current card, battle entries, scores and appearance together.

`Another of this mold` copies descriptive facts but creates a new physical identity and clears
its nickname and photo. A picture of one Buzzz must not silently become a picture of another.
Reset and restore are explicit replacement operations with confirmation. There is no silent
reseed when the user intentionally deletes every disc.

## Small object model

| Concept | Owns | Does not own |
| --- | --- | --- |
| Disc facts | Manufacturer, mold, four flight numbers | Catalog membership, image recognition or a data provider |
| Physical Disc | Stable ID, its facts, exact uploaded photo, nickname, optional plastic/weight | Battle scores or on-screen emphasis |
| BattleEntry | Stable entry ID, a Disc reference, manually authored score text | A turn, throw or automatic rank |
| Composition | Current DiscCard reference; ordered battle entries; explicit highlight/winner references | An editing timeline |
| Presentation | Theme, wide/portrait or row/stack, scale, anchor, visible fields | Stable facts about a disc |
| Editor state | Search, selection for editing, open dialog, temporary footage preview | A persisted gameplay workflow |

`types.d.ts` is the readable contract. Disc facts are embedded value snapshots for now: no
normalized catalog table is needed. This avoids editing one physical instance unexpectedly
rewriting another. A future catalog/manual/CV input can populate the same fields without
becoming the model's owner. Entry IDs are not disc IDs, so different uses of a disc cannot
accidentally share a score. Scores are strings (maximum 12 characters); decimals, negative
numbers and labels are all display values, not a scoring system. Neither a score change nor
selecting an entry infers a highlight or winner.

## Files and iteration seams

- `static/creator-v0/model.js`: initial samples, identity and collection/composition operations,
  validation before replacing state.
- `static/creator-v0/render.js`: pure SVG DiscCard, composed DiscBattle, and SVG-to-PNG export.
  **Preview and PNG use the same scene.** Card dimensions and typography live here.
- `static/creator-v0/app.js`: thin manual controls and editor state, wiring to the model,
  debounced local save and explicit backup/restore.
- `static/creator-v0/storage.js`: one isolated IndexedDB document and full-frame photo resizing.
- `static/creator-v0/index.html` and `styles.css`: workbench shell, responsive layout and controls.

The local document contains one shelf and one working composition, not a collection of projects.
A new PNG reflects the current state; it does not encode a transition or replay. Video/image upload
is context for visual judgment only, and is not part of a backup or an exported overlay.

### Existing code reused versus left alone

Inspected `main` at `b1f4c833d32426d3094c93403af5055057ea63f1` and
`samuelpmahan/chspt-82-frontend-rebuild-rederive-the-mvp-from-a-clean-room-app`.
Both inspected frontends still lead through mapping/CV. Main is a browser-only SvelteKit static
app; its `static/` delivery convention is the useful integration point. The prototype adopts
that convention and a compatible dark workbench treatment. No existing map routes, layout,
package manifest, session store, algorithms or project save format have been changed.

No useful DiscCard, disc shelf or physical-disc domain object was found in the inspected files.
The course editor, map persistence, viewport and raster/CV machinery are not prerequisites
for a disc score bug. Reusing them would add unrelated state and dependencies. This checkpoint
therefore adds an independent static subapp rather than importing the old map shell. It is not
claimed as a Svelte component migration or Storybook integration. The typed pure model and SVG
renderer are the intended small reusable pieces for a later Svelte shell, should that be useful.

## Local data behavior and limits

IndexedDB uses `chainspot-creator-v0`, a versioned store separate from course projects.
The Saved indicator waits for transaction completion. Open/load failures retain any existing
data, show an explicit session-only warning and do not silently replace it. Quota/save failures
are visible. A later-opened second tab is put in session-only mode to reduce accidental stale
writes; sophisticated concurrent editing and synchronization are not part of v0.0.

Photo input: JPEG/PNG/WebP, at most 12 MB and 64 megapixels. The entire image is resized to a
maximum 1400-pixel dimension and stored as an embedded raster; **the original archival bytes are
not retained**. There is no crop, circular mask, background removal or generated replacement.
Transparent PNGs are supported. HEIC conversion, arbitrary remote image URLs and a crop editor
are not implemented. Backups contain the local photo renditions, not temporary blob URLs.

Prototype bounds: 200 discs, four battle entries, 40 MB backup import/export. No cloud backup,
accounts, comprehensive disc database, timing, automatic winners, course or throw model,
map, CV, collection commerce, motion package or video encoding. Output is currently a
1920x1080 transparent PNG still. Appearance choices are provisional, not product defaults
that must be preserved forever. Extremely long names shrink to fit; secondary text at small
video sizes and phone authoring still warrant a designer's pass.

## Reproducible checks

Model, rendering and persistence-adapter contracts (Node 22+; no packages):

```sh
node --test experiments/creator-v0/tests/*.test.mjs
```

Strict typecheck for the pure model, renderer, storage adapter and public types, using the
repository's TypeScript installation. This does not typecheck the DOM controller:

```sh
npx tsc -p experiments/creator-v0/tsconfig.json
```

Real browser test (optional Python test dependencies: `playwright` and `Pillow`, plus Chromium):

```sh
node experiments/creator-v0/build.mjs /tmp/chainspot-creator-v0.html
python3 experiments/creator-v0/tests/browser.py \
  --html /tmp/chainspot-creator-v0.html --out /tmp/creator-proof \
  --executable /usr/bin/chromium
```

That mode injects the actual self-contained HTML into a blank Chromium page, with **no app
or persistence mocks**. It deliberately cannot prove native IndexedDB persistence on an
opaque origin. For the real reload proof, first serve `static/` as above and run in a browser
environment permitted to access localhost:

```sh
python3 experiments/creator-v0/tests/browser.py \
  --url http://localhost:4173/creator-v0/index.html --out /tmp/creator-origin-proof \
  --executable /usr/bin/chromium
```

The URL test uses a fresh browser context; it must not be pointed at a browser profile holding
someone's real collection. It includes reset/delete tests. Use your platform's executable path.

### Observed verification in this checkpoint

- 22 Node tests passed, including 120 composition geometry cases inside one test.
- Strict core typecheck passed.
- 30 real Chromium UI assertions passed, with zero uncaught page or console errors.
- Real file-input photo processing, negative/decimal scores, independent selection/highlight/
  winner, three/four entries, reordering, CRUD, empty shelf, malformed backup rejection,
  actual JSON download/restore, clean view, photo context and actual PNG downloads exercised.
- Distinct same-mold uploads kept different embedded bytes. Four colored source corners in
  deterministic synthetic raster fixtures survived resizing and rendering without cropping.
- PNG output measured 1920x1080, with transparent canvas and no context image included.
- Actual desktop (1536x1000) and narrow (390x844) workbench screenshots inspected. No horizontal
  document overflow at the narrow size; this is not comprehensive mobile acceptance.
- Exported artwork inspected at 1920x1080 and downsampled to 1280x720. Names, main flight values,
  scores and highlight were readable; secondary labels remain small at 720p.

**Not verified here:** native IndexedDB photo/collection survival across a real reload,
full SvelteKit build/integration, existing repo regression suite, Safari/Firefox, actual video
codec playback or a creator's real editing workflow. The environment blocks browser navigation
and outbound Git/npm access. Browser tests ran the real generated HTML in memory, without
changing those restrictions. Storage transaction contracts used an explicitly identified test
double, which is not evidence of native browser persistence.

The checkpoint uses a SHA-verified partial Git object checkout: exact upstream commit and
root/static tree objects were read through the connected GitHub API, while unchanged subtrees
remain referenced by their original SHAs. It is not a complete cloned worktree. All existing
upstream paths remain unchanged. No push, deployment or new Linear write was performed.

## Sample data provenance

Five synthetic, explicitly labeled illustrations describe two Buzzz instances plus Zone,
Athena and Luna. They are **not photographs of anyone's discs**. Colors, plastic/weight choices
and nicknames are illustrative fixtures. No product photography or logo assets are embedded.
Official mold-number references checked for this prototype:

- Buzzz — https://www.team.discraft.com/discs/buzzz — 5 / 4 / -1 / 1
- Zone — https://www.team.discraft.com/discs/zone — 4 / 3 / 0 / 3
- Athena — https://www.discraft.com/paul-mcbeth-athena-driver-mcbethathena — 7 / 5 / 0 / 2
- Luna — https://www.team.discraft.com/discs/luna — 3 / 3 / 0 / 3

User-entered values are authoritative for the displayed card. There is no automatic database lookup.
