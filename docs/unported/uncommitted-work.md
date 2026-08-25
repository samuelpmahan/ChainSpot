# uncommitted-work

**READ THIS FIRST.** Everything below exists in exactly one place on earth: three
dirty working trees on the C: drive of one Windows machine. There is no commit,
no stash, no remote, no reflog entry. A `git checkout .`, a disk failure, or a
machine reset destroys it permanently. For this file only, the verbatim diffs
below **are** the specification — they are not illustrations of the spec, they
are the last copy of the source.

Captured 2026-08-25 by read-only inspection. Nothing was committed, stashed,
checked out, or cleaned.

---

## Source

Three worktrees of the OLD lineage repo `C:/Users/tenni/workspace/ChainSpot`.
All three are `git worktree` checkouts sharing that repo's object store, so
their *committed* history is recoverable; only the working-tree deltas below
are not.

### A. `C:/Users/tenni/workspace/ChainSpot-chspt-82` — LAB sweep renderer fixes

- Branch: `integration/claude-t1-t6`
- HEAD: `0615c93c3fa52c3bbad2033e2fe91dbbd3049b94` — "Merge branch
  'claude/t6-sweep-completion' into integration/claude-t1-t6" (Sun Aug 23
  23:44:54 2026 -0500)
- Committed? **No.** Three tracked files modified, never staged.

```
 M scripts/chainspot-lab/sweep/artifactIo.ts
 M scripts/chainspot-lab/sweep/artifactRenderers.ts
 M scripts/chainspot-lab/sweep/rendererContract.ts
?? .claude/
?? scripts/chainspot-lab/prompts/
?? static/tmp-corpus/
```

Untracked content in this tree:
- `.claude/launch.json` — trivial dev-server config, reproduced below for
  completeness, worth nothing.
- `scripts/chainspot-lab/prompts/groundcheck-step0.md` — a real,
  non-reproducible artifact. Reproduced verbatim below. **This is the most
  valuable untracked file in any of the three trees.**
- `static/tmp-corpus/TheRec-L.PNG`, `TheRec-R.PNG` — binary UDisc screenshots,
  duplicated in the demo tree at `static/resources/`. Not reproducible as text;
  see "Binary payloads" below.

Note: this worktree is on the NEW `packages/alg/` layout (it has
`packages/alg/src/detectors/threeFactor/` and `packages/alg/src/g0/crop.ts`),
not the old `src/lib/detectors/`. It is closer to the rebuild than the other
two trees.

### B. `C:/Users/tenni/workspace/ChainSpot-demo` — guided review rework

- Branch: `demo/mock-engine`
- HEAD: `0850f75131cbdd856d8890758be810c501b72fa8` — "CHSPT-82: evidence-image
  renders + family-on deviation sweep" (Sun Aug 23 12:40:13 2026 -0500)
- Committed? **No.** Seven tracked files modified, six untracked paths.

```
 M src/lib/components/GuidedReviewPanel.svelte
 M src/lib/components/ImageViewport.svelte
 M src/lib/guidedReview.ts
 M src/lib/session.ts
 M src/routes/+page.svelte
 M src/routes/map-round/+page.svelte
 M tests/unit/guidedReview.test.ts
?? src/lib/components/reviewMarker.ts
?? src/lib/reviewDraft.ts
?? static/resources/
?? tests/unit/mapRoundConnectedControls.test.ts
?? tests/unit/reviewDraftPersistence.test.ts
?? tests/unit/sessionReset.test.ts
```

`794 insertions, 407 deletions` across the tracked files, plus ~300 lines of
brand-new untracked source. This is by far the largest body of uncommitted
work. Old layout (`src/lib/...`).

### C. `C:/Users/tenni/workspace/ChainSpot-clickfix-ab` — local-snap ClickFix A/B

- Branch: `codex/ab-local-snap-clickfix`
- HEAD: `ebbc61d0b316dc5257a99efac28b203fdc18161d` — "Remove accidental sentinel
  file" (Sat Aug 22 02:08:00 2026 -0500)
- Committed? **No.** Five tracked files modified.

```
 M src/lib/autoAnnotation/basketDetection.ts
 M src/lib/autoAnnotation/basketDetection.worker.ts
 M src/lib/components/AnnotationWorkspace.svelte
 M src/lib/cv/localSnap.ts
 M tests/unit/localSnap.test.ts
?? node_modules.windows/
```

`node_modules.windows/` is an installed dependency tree, not work. Ignore it.

**Cross-lineage fact that matters:** the behavior this diff makes optional was
shipped in commit `4da01fb` — "localSnap: rank candidates within the snap
radius, not crop-wide". `4da01fb` is *also the last commit shared with the
D:/LAB/ChainSpot rebuild*. So the rebuild already contains the ClickFix
behavior as unconditional, always-on code. This uncommitted diff is a
**partial retreat from it**: it puts the shipped behavior behind an
off-by-default flag. A rebuilder who applies this diff naively will silently
turn off a behavior the rebuild currently has on. Old layout (`src/lib/...`).

---

## What it detects

Plain language, per tree.

### A. LAB sweep renderer fixes

Not a detector. This is the **evidence-rendering** layer of the LAB sweep tool
— the part that turns the algorithm's binary output artifacts (masks, scalar
fields, candidate lists) into PNGs and text a human can look at. Two bugs, both
in the same family: *the tool was telling you it had produced evidence when it
had not.*

1. **`renderMask` produced a solid black image.** A "mask" here is one byte per
   pixel saying yes/no — is this pixel dark, is it bright. The algorithm writes
   `1` for yes and `0` for no. The renderer copied that byte straight into the
   red, green and blue channels of a PNG. RGB(1,1,1) out of 255 is black. Every
   mask evidence image ever rendered by this tool was a black rectangle. The fix
   scales any non-zero byte to 255.

2. **A declined render was counted as a successful render.** When a renderer
   cannot draw something (usually because the artifact's pixel dimensions were
   never recorded by whatever produced it), it writes a small `.stub.txt` note
   instead of a PNG. `renderArtifact` was returning `rendered: true` for those,
   and `sweepCli.ts` counts that flag to print
   `--- Renderer inventory: N rendered, M stubbed ---`. The printed coverage
   number was inflated. The fix detects the stub and reports it honestly.

3. **The contract doc was wrong, and the wrongness caused bug 1.** The
   top-of-file comment in `rendererContract.ts` asserted masks were 0/255. That
   assertion is what a renderer author read before writing the black-image
   renderer. The fix corrects the doc, cites the two real source lines that
   prove it, and records that the doc error shipped a bug.

### B. Guided review rework (demo)

The human-in-the-loop annotation review screen. Before this diff: the reviewer
saw a hole, clicked "Accept hole", and moved on — one decision per hole, and
any single placement action (`replace`) silently marked the whole hole
accepted. After this diff: each hole is reviewed as **three explicit decisions
in a fixed order — tee, then basket, then bends** — and each must be either
accepted or *explicitly skipped*. A hole is only "accepted" once all three
decisions exist.

Other behavior in the same diff:
- Multiple bends per hole (previously exactly one; `replace` on a bend replaced
  the entire bends array with a one-element array).
- Draggable/clickable/deletable review markers drawn directly on the stitched
  image, with a review "camera" that zooms and centers on the current hole.
- Save/open an annotation draft as validated JSON.
- Tee/basket/bend geometry is now seeded from the detector's own
  `association` events (`tee-of`, `basket-of`, `on-path`), averaged per hole,
  instead of arriving empty.
- Walk paths render as `polyline` through all bends, not a quadratic curve
  through only the first bend.
- A one-click "LOAD REC DEFAULT" demo button and a session reset.

### C. Local-snap ClickFix A/B

When a user first places a tee or basket marker, a small object-finding pass
runs in a window around the click and the marker snaps to a real nearby
feature. This diff does not change what is detected. It changes **the order of
two filters** and makes that order a runtime experiment flag:

- **OFF (new default):** rank every candidate in the whole crop window, take
  the single highest scorer, then check whether it is within the snap radius.
  If it is not — return nothing. The click becomes a no-op.
- **ON (`?localSnapClickFix=1`):** discard out-of-radius candidates *first*,
  then rank what remains.

Same crop, same score floor, same radius, same calibration, same coordinate
frame. Only selection order differs.

---

## Why it exists

### A.
The LAB discipline in this project is that **every claimed number ships with a
rendered evidence image**. Both bugs attacked that directly: mask evidence
images were uniformly black (useless as evidence, and worse, *plausibly*
useless — a black mask looks like "the detector found nothing," which is a
wrong conclusion presented as a picture), and the sweep CLI's coverage line was
overstating how much evidence actually existed. Someone reading
`12 rendered, 3 stubbed` would believe twelve artifacts had pictures when some
of them had text notes.

The `rendererContract.ts` doc change exists because the doc was the *cause*.
Its own new text says so: *"Doc previously claimed 0/255 — that error shipped a
solid-black mask renderer; caught in review 2026-08-23."*

### B.
The old reducer conflated *"the reviewer looked at this"* with *"the reviewer
edited this"*. `replace(state, n, anchor, p)` set `status: 'accepted'` as a side
effect of placing a point. So moving a tee marked the hole reviewed — including
its basket and bends, which the reviewer may never have looked at. Worse, the
old `+page.svelte` auto-accepted every hole the CV service flagged
`strong-hole`, so a "high confidence" verdict from the detector removed the
human gate entirely.

That is the exact inversion of this project's HITL-for-momentum principle:
gates exist so drift is caught small and early. An auto-accept driven by
detector confidence is the detector grading its own homework. The diff removes
the auto-accept and downgrades the strong-hole signal to a note in the status
line (`(N high-confidence labels)` instead of `(N strong, auto-accepted)`).

The multi-bend support exists because the old model physically could not
represent a course hole with two bends — `replace` on `'bend'` wrote
`bends: [p]`, discarding any others, with the honest comment *"This slice
supports exactly ONE bend per hole"*.

The `map-round` and `+page.svelte` cleanups remove buttons labeled
`disabled title="Not implemented"` — the diff's own test asserts the page no
longer advertises actions it cannot perform.

### C.
Read the comment this diff **deletes** — it is the entire justification for
`4da01fb` and it survives nowhere else in prose:

> Rank only candidates within the snap radius. The crop is deliberately wider
> than the accept radius (so nearby false positives are visible and can be
> *rejected*), which means a neighboring feature can outscore the one actually
> under the click; ranking the whole crop first and radius-testing the single
> winner turned those clicks into no-ops even though an acceptable in-radius
> candidate existed. Corpus profiling (samuelpmahan/toph,
> examples/chainspot-clicksnap-profile) measured that in every such rejection
> the in-radius runner-up was the real feature, and shipping this ranking moved
> corpus-wide snap rates from 0.778 to 0.838 (tee) and 0.796 to 0.968 (basket)
> with median accuracy unchanged.

So why retreat from a change with those numbers? The diff's own new comment
gives the stated reason — reversibility, not doubt:

> A small, explicit A/B control for local marker snapping. OFF deliberately
> preserves the crop-wide ranking that preceded `4da01f`; ON applies that
> commit's radius-first ClickFix. It is request-scoped rather than persisted
> with an annotation, so an experiment cannot change saved course geometry.

**Honest reading:** this is an A/B harness built so the two arms can be
compared on this machine's corpus, on a branch literally named
`codex/ab-local-snap-clickfix`, in a workspace full of sibling `codex/ab-*`
A/B worktrees. It is scaffolding for a measurement, not a considered rollback.
Nothing in the tree records a result from running it.

---

## Signal and evidence

### A.
- **`renderMask`** reads `input.bytes` — the raw `Mask.data` as written by the
  Node sink, one byte per pixel, no header (`Mask.width`/`height` are dropped by
  `maskBytes()`; dimensions arrive separately via `artifactRef.rasterDims`).
  The 0/1 claim is **verified against real source**, not asserted:
  - `packages/alg/src/detectors/labEndpoint/raster.ts:74` → `if (v <= DARK_V_MAX) dark[i] = 1;`
  - `packages/alg/src/detectors/labEndpoint/raster.ts:78` → `if (s <= BRIGHT_S_MAX) bright[i] = 1;`
  - `packages/alg/src/detectors/threeFactor/raster.ts:97` → `if (v <= knobs.darkVMax) dark[i] = 1;`
  - `packages/alg/src/detectors/threeFactor/raster.ts:101` → `if (s <= knobs.brightSMax) bright[i] = 1;`
- **`rendered` flag** is derived by string-sniffing:
  `output.summary.endsWith('stub only')`. The producing side is
  `artifactRenderers.ts:31` → ``return { filesWritten: [resolve(path)], summary: `${reason} — stub only` };``
  Note the em-dash. This is a **stringly-typed contract across a module
  boundary** and is the single most fragile line in this diff.
- Consumer: `scripts/chainspot-lab/sweep/sweepCli.ts:113` → `if (result.rendered) rendered++;`

### B.
- `labEndpointDetector` emits events of kinds `object` (with `objType`:
  `hole-badge`, `tee`, `basket`, `walk-vertex`), `label` (badge → hole number
  `n`), `association` (with `relation`: `tee-of`, `basket-of`, `on-path`, and
  `fromDetId`/`toDetId`), and `strong-hole`.
- The new `approveLayout` path walks `association` events, resolves whichever
  endpoint of the association is the labeled badge, maps the other endpoint
  through `objectByDet`, translates it out of per-image local pixels into
  stitched composite pixels via `placements[i]` and the applied crop insets
  (`left`/`top`), and buckets it into `tees` / `baskets` / `bends` for that
  hole number. Each bucket is then reduced to its **arithmetic mean point**.
- Review markers live in stitched/composite original pixels
  (`ReviewMarker.xPx/yPx`), explicitly *not* layer-local pixels — the
  `ImageViewport` prop doc says so, and the viewport converts with
  `offsetX + marker.xPx * scale`.
- Detection results are now streamed into `detections` on every emitted event
  rather than assigned once after the detector resolves, so partial results are
  visible while a long detection runs.

### C.
- Same pixels as before the diff. `localFeatureSnap` crops a square window from
  the analysis raster centered on the click, runs the real calibrated tee-pad or
  basket-template detector over only that crop, and gets back candidates with
  `{xPx, yPx, score}` in crop-local coordinates. Crop origin is added back
  (`originXPx + candidate.xPx`) before any distance test — both arms use the
  same source-image frame.
- The only new signal is a URL query parameter read once per request from
  `window.location.search`.

---

## Thresholds and constants

| name | value | how derived | confidence |
| --- | --- | --- | --- |
| **A. sweep renderers** | | | |
| mask "set" pixel display value | `255` | Forced: the underlying mask alphabet is 0/1, verified at four real source lines (see above). 255 is simply "white". Not tuned. | High — this is a fact, not a threshold |
| stub-detection sentinel | string suffix `'stub only'` | Chosen to match `artifactRenderers.ts`'s existing stub summary format. Not measured. | **Low as engineering** — correct today, silently breaks if any renderer's summary wording changes. Not a numeric threshold, but the same class of landmine |
| `DARK_V_MAX`, `BRIGHT_S_MAX`, `knobs.darkVMax`, `knobs.brightSMax` | not in this diff | Referenced only as proof of the 0/1 alphabet. **Their own derivations are UNKNOWN from this diff** and must be recovered from the raster.ts specs. | n/a here |
| **B. guided review** | | | |
| `STEPS` order | `['tee', 'basket', 'bends']` | Product decision, stated nowhere as measured. Fixed order is load-bearing: `firstPendingStep` and `currentStep` both depend on it, and the draft validator re-derives `currentStep` from it. | Medium — deliberate, undocumented rationale |
| marker hit-vs-drag threshold | `5` px (`Math.hypot(...) < 5`) | **UNKNOWN.** Copied from the pre-existing canvas-click handler in the same file, which also uses `< 5`. No measurement anywhere. | **Low — UNKNOWN derivation** |
| review camera initial zoom | `courseFit * 2`, clamped to `[reviewMinScale, 1]` | **UNKNOWN.** No measurement, no comment. `2` is bare. | **Low — UNKNOWN derivation** |
| review camera zoom step | `1.1 ** delta`, clamped to `[reviewMinScale, 4]` | **UNKNOWN.** `1.1` per keypress and a hard max of `4` are both bare. | **Low — UNKNOWN derivation** |
| review camera fit padding | `48` px (`center.x * 2 - 48`) | **UNKNOWN.** Bare. | **Low — UNKNOWN derivation** |
| review viewport safe-width inset | `24` px (`container.clientWidth - toolbarWidth - 24`) | **UNKNOWN.** Bare. | **Low — UNKNOWN derivation** |
| `reviewMinScale` initial | `0.02` | **UNKNOWN.** Bare; immediately overwritten by `Math.min(scale, courseFit)` on camera start, so it only matters before the first focus. | **Low — UNKNOWN derivation** |
| marker button size | `34` px diameter, `3` px white border, `16` px bold font, `z-index: 3` | Presentation. Freely changeable. | High that it doesn't matter |
| marker colors | tee `#166534`, basket `#b91c1c`, bend `#7e22ce` | Tailwind green-800 / red-700 / purple-700. Presentation. | High that it doesn't matter |
| path stroke | `#465446`, width `4` | Pre-existing, unchanged by this diff. | n/a |
| `THROWN_ROUND_PURPLE_MASS_MIN` | `0` | Pre-existing, unchanged. Its own comment says real-capture evidence can raise it later. **A threshold of 0 is a disabled gate.** | Flagged, not this diff's problem |
| `PAGE_MARGIN_PX` | `8` | Pre-existing; matches browser default body margin. | High |
| `REC_DEFAULTS` | `['TheRec-L.PNG','TheRec-R.PNG','TheRec-Thrown-full.PNG']` | Hard-coded demo fixture names, fetched from `/resources/`. | High |
| `SCHEMA_VERSION` (reviewDraft) | `1` | New format, first version. | High |
| **C. local snap** | | | |
| `DEFAULT_LOCAL_SNAP_EXPERIMENT.clickFix` | `false` | **This is the dangerous one.** Chosen so the default arm reproduces pre-`4da01fb` behavior. It is *not* a measurement result — it is an experiment's control arm. Shipping it as-is reverts a change with published corpus numbers. | **Low as a product default** |
| `LOCAL_SNAP_CLICKFIX_QUERY_PARAMETER` | `'localSnapClickFix'`, opt-in value exactly `'1'` | Arbitrary but explicit; every other value is control. Tested. | High |
| `LOCAL_SNAP_CROP_FEATURE_MULTIPLE` | `4` | Pre-existing, unchanged. Comment: big enough that an off-center feature is fully inside, small enough to stay local. Tuned against timings in the module header (tee-pad 90×90 crop ≈1.3 ms/call; basket ≈170×170 ≈23 ms/call on Node `@techstark/opencv-js` after ~400 ms module load). | Medium — timings are real and stated, the multiple itself is judgement |
| `LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE` | `0.5` | Pre-existing, unchanged. "Half of the expected feature footprint." No measurement cited. | **Medium-low — round number, no derivation** |
| `LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX` | `24` | Pre-existing, unchanged. Long comment explains the *need* for a cap (uiScalePx grows with DPI, or is inflated by a bad badge match, letting the relative radius reach hundreds of px) but **never explains why 24**. | **Low — the rationale is documented, the number is UNKNOWN** |
| `LOCAL_SNAP_MIN_SCORE` | `0.5` | Pre-existing, unchanged. Deliberately equal to `basketTemplateDetection.ts`'s `DEFAULT_MIN_SCORE`; applied to tee pads too on the argument that a local crop is a cleaner search than a full pass. | Medium — the *linkage* is reasoned; the underlying 0.5 is inherited and its own origin is UNKNOWN |
| `TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE` | `26` | Pre-existing, unchanged. Restated copy of `teePadDetection.ts`'s edge-loop major-axis ceiling `26 * scale`; the comment is the only thing enforcing the link. **Origin of 26 itself is UNKNOWN.** | **Low — duplicated constant with a prose-only link** |
| `MIN_CROP_SIDE_PX` | `4` | Pre-existing, unchanged. "Below this a crop can't meaningfully contain a feature." No measurement. | Low — UNKNOWN, but low blast radius |
| snap rate, tee | `0.778 → 0.838` | Corpus profiling in an **external repo not present on this machine** (`samuelpmahan/toph`, `examples/chainspot-clicksnap-profile`). Recoverable only from commit `4da01fb`'s comment text. | **See "What proves it works" — nothing on this machine backs it** |
| snap rate, basket | `0.796 → 0.968` | Same. | **Same — unbacked here** |

---

## Gate placement

None of this uncommitted work lives inside G0–G5. That is worth saying plainly:
**zero lines of the highest-fragility content are algorithm gate code.** It is
all evidence tooling (A), human-review UI (B), and one selection-order flag in
an interactive snap helper (C).

### A. LAB sweep renderers
Runs **after** every gate, not inside any. `sweepCli.ts` executes the compiled
plan, collects `receipts`, then walks every `receipt.artifacts` and calls
`renderArtifact(outDir, receipt.opId, gate, artifactRef)`. `gate` here is a
label carried along for output foldering (`gateByOpId`, defaulting to
`'shared'`) — the renderer never influences gate behavior. Depends on: the Node
sink having already written `<outDir>/artifacts/<kind>/<id>.bin`, and
`artifactRef.rasterDims` being populated by whichever gate produced the raster.
**Missing `rasterDims` is precisely what triggers the stub path**, so a gate
that forgets to record dimensions silently costs you an evidence image — and
before this diff, silently still counted as one.

### B. Guided review
Downstream of all detection. Page phase flow is
`import → annotate → clean`. `approveLayout()` is the transition into
`annotate`; it consumes finished `labEndpointDetector` output (all gates done)
and builds the review state. `confirmAnnotation()` is the exit, and it is the
point at which **the pixels are discarded and only vectors survive** — the
existing code comments call this out for fair-use reasons, and the thrown-round
registration is deliberately performed *before* the discard. The new
`isReviewValid` guard sits directly in front of that irreversible step.

Depends on: `detectCourse(seeds)` for hole proposals, `association` events for
endpoint geometry, `placements[]` + applied crop insets for the local→composite
coordinate transform, `$lib/session` for cross-page handoff.

### C. Local snap
Not a gate. It is an interactive, per-click pass that runs *after* a full
course detection has already warmed the OpenCV worker. Its own header is
explicit that it never re-fires on a drag of an already-placed marker, because
re-running CV on every reposition risked silently overriding a user's own
correction. It depends on `courseDetection.numberDetection.anchor` (the
number-badge anchor) for calibration — the worker re-derives `UiScalePx` and
`BasketTemplateScale` from it — and on the existing
`basketDetection.worker.ts` owning a warm WASM instance.

---

## Known failure cases

### THE BOUNDING-BOX / NEGATIVE-EVIDENCE WARNING — READ THIS

The project's named catastrophic failure is: a trophy-shaped basket sprite gets
a square bounding box, the square swallows a nearby tee pad, an inspector
concludes "no tee here," and deletes correct code. **Tree C is a live instance
of that exact failure family, and the uncommitted diff sets the default to the
failing side.**

The mechanism, spelled out:

1. The snap crop is `4 ×` the feature footprint. The accept radius is
   `min(0.5 × footprint, 24 px)`. The crop is **deliberately** much wider than
   the radius — the pre-diff comment says why: *"so nearby false positives are
   visible and can be rejected."*
2. A basket template match near a tee pad (or vice versa) can outscore the
   feature actually under the user's click. This is the square-bounding-box
   swallow, in scoring form rather than geometric form.
3. **OFF arm:** rank the whole crop → the neighbor wins → radius-test the
   single winner → it fails → `return null`.
4. `return null` is rendered to the user as *nothing happened*. The click is a
   silent no-op. There is no "I found something but rejected it" channel.
5. A human — or an inspector agent — watching clicks do nothing concludes the
   detector cannot see the feature. That conclusion is **false**: the profiling
   comment states that in *every* such rejection, the in-radius runner-up was
   the real feature.

That is negative evidence produced by an occlusion-shaped scoring artifact,
presented as absence. If anything in the rebuild acts on "local snap returned
nothing" as a signal about the image, it is acting on a lie. Do not delete tee
detection because snaps near baskets go quiet.

Additional failure cases:

### A.
- **`endsWith('stub only')` is the entire stub contract.** Any renderer whose
  summary is reworded, translated, punctuated differently (note the em-dash in
  `— stub only`), or that appends a suffix, is silently miscounted again. The
  bug reappears with no test failure.
- Only the *registered-renderer-declined* path is fixed. The
  *no-renderer-registered* path already returned `rendered: false` and is
  untouched — correct, but it means two independent code paths now express the
  same idea in two different ways.
- `renderMask` still trusts `artifactRef.rasterDims` blindly for the
  `width * height * 4` allocation. If `bytes.length !== width * height` the loop
  either under-fills (leaving alpha-0 garbage) or writes past the intended
  region — the diff does not add a length check. Not introduced here, not fixed
  here.
- The mask fix makes the renderer **lossy on purpose**: any mask that genuinely
  carried graded values (not 0/1) is now flattened to pure black and white by
  truthiness. That is correct for the four verified writers and wrong for any
  future non-binary mask kind.

### B.
- **`selectHole` on an accepted hole silently wipes its step decisions**, resetting
  `stepStatus` to all-`pending`. Jumping back to double-check hole 3 discards
  the fact that you already reviewed it, and forces three fresh decisions.
- `removeAnchor` does not decrement `replacements` counters, so the
  edit-count telemetry drifts upward under delete/re-place cycles.
- `replace(..., 'bend', p)` replaces **only bend index 0** (`[p, ...bends.slice(1)]`)
  while `moveBend` takes an explicit index. Two overlapping ways to edit a bend
  with different semantics.
- The review camera is driven by `setTimeout(...)` with no delay to wait for
  layout, then re-checks `reviewFocusKey === focusKey` before applying. A focus
  change inside the same tick is dropped, not queued.
- `onPointerMove` returns early whenever a review marker is captured, so the
  marker does not visually follow the cursor during a drag — the position only
  updates on pointer-up. Dragging is invisible until you release.
- `parseReviewDraft` enforces cross-field consistency between `done`,
  `currentIndex`, `status`, and `stepStatus`. That is good, and it also means
  **any hand-edited or externally generated draft that is even slightly
  inconsistent is rejected outright** with no repair path.
- `saveReviewDraft` builds an object URL, clicks a synthetic link, then calls
  `URL.revokeObjectURL(url)` **synchronously in the same tick**. This is a
  known-flaky pattern; the download can be cancelled before it starts in some
  browsers.
- `loadRecDefaults` calls `clearAll()` and then `loadFiles(files)`; `clearAll`
  increments `selectionSeq`, which is the guard the async detection path uses.
  The ordering is probably fine but is not covered by any test.
- The `Export debug JSON` button is still present and still labeled
  `TEMP DEBUG (remove before merge prep)`.

### C.
- **Applying this diff to the rebuild turns off shipped behavior.** `4da01fb` is
  in the rebuild's history. The default here is `clickFix: false`.
- The flag is read from `window.location.search` at request time, per click.
  Changing the URL mid-session changes behavior mid-session, and nothing records
  which arm produced any given placement. Corrections logged during a mixed
  session are not attributable to an arm.
- The diff deletes the only prose record of the corpus profiling numbers.
  After this diff lands, those numbers exist solely in `4da01fb`'s blob.
- `experiment` is threaded through the worker message boundary as a plain
  object. `basketDetection.ts` fills a default when the caller omits it, and
  `localFeatureSnap` has its own default parameter — three places that must
  agree on what OFF means.
- The A/B is structurally sound (same crop, same floor, same radius, same
  frame — the diff comment says so and the code backs it) but **no result from
  running it is recorded anywhere in the tree.**

---

## What proves it works

### A.
- `tests/unit/artifactRenderers.test.ts` exists and pins a SHA-256 golden per
  artifact kind, including `mask`.
- **That test file is NOT dirty.** It still holds the pre-fix golden.
- The mask case input is `new Uint8Array([0, 255, 128, 64])` with
  `dims = {width: 2, height: 2}`, and the pinned golden is
  `mask: 'ac9e6595c296e742c1bee1175e7f8ff92c0541bf7ae9019c1d5bd0992cedde63'`.
- Under the old renderer those bytes produce RGB `(0,0,0) (255,255,255)
  (128,128,128) (64,64,64)`. Under the new one they produce
  `(0,0,0) (255,255,255) (255,255,255) (255,255,255)`. Different PNG bytes,
  therefore a different hash.

  **Conclusion: this working tree is red.** The uncommitted change breaks a
  committed golden test that was not updated alongside it. Stated from code
  inspection; I did not execute vitest, to keep the tree untouched. A rebuilder
  must re-pin that golden, and should treat "the golden changed" as the *proof*
  the fix landed, not as a failure to paper over.
- Nothing tests `renderArtifact`'s `rendered` flag or the stub-suffix sniff.
- No evidence image backs the "masks were black" claim. The claim is instead
  backed by four cited source lines, which is stronger than an image for this
  particular assertion.

### B.
- `tests/unit/guidedReview.test.ts` was **rewritten**: ~270 lines of old tests
  removed, ~144 lines of new ones added. The new suite covers empty-review
  invalidity, sort order, "placing never accepts", the deterministic
  tee→basket→bends progression, zero-bend holes, explicit skipping, multi-bend
  `replace`, replacement counters, legacy accepted-fixture compatibility, the
  legacy whole-hole `accept`, and unknown-hole no-ops. This is a genuinely good
  suite for a pure reducer.
- `tests/unit/reviewDraftPersistence.test.ts` (new, untracked) covers
  round-trip, malformed JSON, wrong schema version, inconsistent queue state,
  non-mutation of the input string, per-step preservation, and the
  status-vs-stepStatus conflict.
- `tests/unit/sessionReset.test.ts` (new, untracked) covers `resetSession`.
- `tests/unit/mapRoundConnectedControls.test.ts` (new, untracked) is a **source-text
  regex assertion** that `map-round/+page.svelte` contains no `disabled`,
  `Not implemented`, `Create Graphics`, `Project round`, `Re-run projection`, or
  `Per-hole corrections`. This is a lint disguised as a test and will produce
  false failures the moment any legitimate `disabled` attribute appears on that
  page. Record it, do not rebuild it.
- **Nothing tests any of the UI work.** `ImageViewport.svelte`'s review camera,
  marker dragging, zoom clamps, and keyboard handling have zero coverage.
  `GuidedReviewPanel.svelte` has zero coverage. `+page.svelte`'s
  `approveLayout` association-to-endpoint transform — the one piece of real
  geometry logic in this diff — has **zero coverage and no evidence image**.
- No evidence images anywhere for tree B.

### C.
- `tests/unit/localSnap.test.ts` is dirty and gains a flag-parsing test plus a
  **two-arm assertion** on the same fixture: the control arm must return `null`,
  the ClickFix arm must return a point inside the radius. That is a good A/B
  test — it pins both behaviors rather than only the new one.
- The renamed test (`'prefers an in-radius candidate over a higher-scoring one
  outside the radius'` → `'keeps the crop-wide historical result OFF and uses
  radius-first ranking only ON'`) is honest about what changed.
- **The corpus numbers 0.778/0.838/0.796/0.968 are backed by nothing on this
  machine.** I grepped `src`, `tests`, and `docs` of the clickfix tree for those
  values and for `clicksnap-profile` and `toph`: zero hits. The cited profiling
  lives in an external repository (`samuelpmahan/toph`,
  `examples/chainspot-clicksnap-profile`) that is not present here. **No rendered
  evidence image backs any of the four numbers.** Per this project's own rule,
  they should be treated as unvalidated until re-measured.
- No result of actually running the A/B is recorded anywhere.

---

## Regeneration notes

### Must get right

1. **Do not adopt tree C's default without re-measuring.** `clickFix: false`
   reverts `4da01fb`, which is already in the rebuild. If you port the flag,
   port it with `clickFix: true` as the default and treat OFF as the
   experimental arm — or re-run the A/B on the rebuild's corpus and let the
   number decide. The one thing you must not do is inherit `false` silently.
2. **Preserve the corpus numbers as prose before the diff is applied anywhere.**
   They are reproduced in this file and in `4da01fb`'s comment. Nowhere else.
3. **Re-pin the mask golden.** The rebuild's equivalent of
   `tests/unit/artifactRenderers.test.ts` must get a new `mask:` hash. Treat the
   hash change as confirmation, and render one actual mask PNG and *look at it*
   — a mask evidence image whose pixels are 0/1 and a mask evidence image whose
   pixels are 0/255 are trivially distinguishable by eye, which is the whole
   point of the evidence-image rule.
4. **Replace the stub string-sniff with a real field.** `RendererOutput` should
   carry `stubbed: boolean` (or a discriminated union) rather than having
   `artifactIo` parse `artifactRenderers`' prose. Same fix, no landmine.
5. **Keep the mask alphabet documented at the writer, not only at the reader.**
   The doc error in `rendererContract.ts` caused a shipped bug. The four
   `dark[i] = 1` / `bright[i] = 1` sites are the source of truth; whatever
   documents the alphabet should cite them by path and line, as the fixed
   comment does.
6. **Keep review completion three explicit decisions, and keep skipping
   explicit.** The point of tree B is that "reviewed" ≠ "edited" and that a
   deliberately-skipped basket is a *reviewed* basket. Collapsing back to one
   accept-per-hole reintroduces the original defect.
7. **Do not restore detector-confidence auto-accept.** The removal of the
   `strong-hole → accept(r, n)` loop is the most valuable single line of tree B.
   High detector confidence may inform the reviewer; it may not stand in for
   the reviewer.
8. **Keep the coordinate-frame boundary explicit.** Review markers are in
   stitched/composite original pixels; layer markers are in layer-local display
   pixels. The `approveLayout` transform
   (`placements[i].x + (endpoint.xPx - left)`) is the only conversion, and it is
   untested. In the rebuild it deserves a unit test with a real crop inset,
   because it is exactly the frame-shift trap that `groundcheck-step0.md`
   (below) exists to train people out of.
9. **Guard the irreversible step.** `confirmAnnotation` discards pixels.
   `isReviewValid` in front of it is load-bearing, and it deliberately
   *evaluates* old states rather than trusting a persisted `valid` flag.
10. **Multiple bends must be representable end to end** — reducer, marker ids
    (`${n}:bend:${index}`), renderer (`polyline`, not `Q`), and draft schema.
    The old single-bend model was a data-model bug wearing a UI-limitation
    costume.

### Freely changeable

- Every marker color, size, border, font, and z-index in tree B.
- All seven UNKNOWN camera constants (`2`, `1.1`, `4`, `48`, `24`, `0.02`, `5`).
  None has a derivation; re-derive them or pick new ones deliberately and write
  down why. Do not copy them forward as if they were measured.
- The `?localSnapClickFix=1` parameter name and the `'1'` sentinel.
- The `REC_DEFAULTS` filenames and the "LOAD REC DEFAULT" button entirely — pure
  demo affordance.
- `mapRoundConnectedControls.test.ts`. Do not rebuild it; it is a regex over
  source text pretending to be a behavioral test.
- The `Export debug JSON` button — its own comment says remove before merge.
- The Svelte-5-specific idioms (`$props`, `$state`, `$derived`, `$effect`,
  `bind:clientWidth`) if the rebuild's UI framework differs. Only the *state
  machine* in `guidedReview.ts` and the *validator* in `reviewDraft.ts` are
  framework-independent, and those two files are the parts actually worth
  carrying.

### Binary payloads (not reproducible here)

- `ChainSpot-demo/static/resources/TheRec-L.PNG` (3,844,146 B),
  `TheRec-R.PNG` (3,988,936 B), `TheRec-Thrown-full.PNG` (4,740,039 B), all
  dated Aug 16 23:17.
- `ChainSpot-chspt-82/static/tmp-corpus/TheRec-L.PNG`, `TheRec-R.PNG` —
  same names, likely the same files.

These are UDisc course screenshots. The `+page.svelte` comments treat the raw
pixels as fair-use-sensitive (they are deliberately discarded at
`confirmAnnotation`). If these are the only copies, **copy the bytes off this
machine separately** — this document cannot carry them, and a rebuilt
`loadRecDefaults` is useless without them.

---

## Verdict

**partially-worth-it.**

Split by tree, because they differ sharply:

- **Tree A (sweep renderers) — worth regenerating, and it is nearly free.** Two
  small, verified, high-value fixes to the evidence layer this whole project's
  epistemics depend on. The mask fix is grounded in four cited source lines, not
  in taste. Rebuild it, with the stub sniff replaced by a real boolean and the
  golden re-pinned.
- **Tree B (guided review) — the reducer and the draft validator are worth
  regenerating; the UI is not.** `guidedReview.ts` and `reviewDraft.ts` are
  well-tested pure logic encoding a genuine correctness insight (reviewed ≠
  edited; skipped is a decision) plus the removal of detector self-grading. The
  ~270 lines of untested Svelte camera/marker code carry seven undocumented
  magic numbers and would cost more to audit than to rewrite against the new
  contract.
- **Tree C (ClickFix A/B) — discard the diff, keep the prose.** The rebuild
  already has the behavior this diff makes optional, the diff's default silently
  reverts it, its headline numbers are backed by nothing reachable from here,
  and no result from running the experiment was ever recorded. What is worth
  saving is the deleted comment and the failure mechanism it documents — both
  preserved above. If the A/B is genuinely wanted, rebuild it fresh with
  `true` as the default and record an outcome this time.

---

# Appendix — verbatim diffs

Everything below is reproduced exactly as `git diff` emitted it. Line-ending
warnings from Git (`LF will be replaced by CRLF`) have been stripped; nothing
else has been altered.

## A. `ChainSpot-chspt-82` (branch `integration/claude-t1-t6`, HEAD `0615c93`)

```
 scripts/chainspot-lab/sweep/artifactIo.ts        | 5 ++++-
 scripts/chainspot-lab/sweep/artifactRenderers.ts | 9 ++++++---
 scripts/chainspot-lab/sweep/rendererContract.ts  | 9 ++++++---
 3 files changed, 16 insertions(+), 7 deletions(-)
```

```diff
diff --git a/scripts/chainspot-lab/sweep/artifactIo.ts b/scripts/chainspot-lab/sweep/artifactIo.ts
index dd319ac..76c45a7 100644
--- a/scripts/chainspot-lab/sweep/artifactIo.ts
+++ b/scripts/chainspot-lab/sweep/artifactIo.ts
@@ -54,9 +54,12 @@ export function renderArtifact(
 			opId,
 			gate
 		});
+		// A renderer that declined (dims unknown etc.) writes a stub and says
+		// so in its summary — counting that as rendered overstates coverage.
+		const stubbed = output.summary.endsWith('stub only');
 		return {
 			artifactRef,
-			rendered: true,
+			rendered: !stubbed,
 			summary: output.summary,
 			filesWritten: output.filesWritten
 		};
diff --git a/scripts/chainspot-lab/sweep/artifactRenderers.ts b/scripts/chainspot-lab/sweep/artifactRenderers.ts
index 09cdae5..b51dddf 100644
--- a/scripts/chainspot-lab/sweep/artifactRenderers.ts
+++ b/scripts/chainspot-lab/sweep/artifactRenderers.ts
@@ -110,9 +110,12 @@ export const renderMask: RendererFn = (input) => {
 	const rgba = new Uint8Array(dims.width * dims.height * 4);
 	for (let i = 0; i < input.bytes.length; i++) {
 		const offset = i * 4;
-		rgba[offset] = input.bytes[i];
-		rgba[offset + 1] = input.bytes[i];
-		rgba[offset + 2] = input.bytes[i];
+		// Masks are 0/1 per byte (see alg raster.ts) — scale to 0/255 for
+		// display or every set pixel renders RGB(1,1,1), i.e. black.
+		const v = input.bytes[i] ? 255 : 0;
+		rgba[offset] = v;
+		rgba[offset + 1] = v;
+		rgba[offset + 2] = v;
 		rgba[offset + 3] = 255;
 	}
 	const path = join(input.outDir, `${fileBase(input)}.png`);
diff --git a/scripts/chainspot-lab/sweep/rendererContract.ts b/scripts/chainspot-lab/sweep/rendererContract.ts
index 60bdb4a..3316533 100644
--- a/scripts/chainspot-lab/sweep/rendererContract.ts
+++ b/scripts/chainspot-lab/sweep/rendererContract.ts
@@ -42,9 +42,12 @@ import {
 //
 // mask               Uint8Array = Mask.data alone (Mask.width/height are
 //                    NOT included — maskBytes() drops them). One byte per
-//                    element; this codebase's Mask is 0/255 per pixel, not
-//                    bit-packed (confirm against raster.ts's mask writers
-//                    before assuming bit-packing).
+//                    element; this codebase's Mask is 0/1 per pixel (see
+//                    alg raster.ts mask writers: dark[i]=1, bright[i]=1),
+//                    NOT 0/255 and not bit-packed. Renderers must scale to
+//                    0/255 for display or set pixels render as black.
+//                    (Doc previously claimed 0/255 — that error shipped a
+//                    solid-black mask renderer; caught in review 2026-08-23.)
 //
 // scalarField        Float32Array's raw bytes (floatBytes(): a view over
 // orientationField    the buffer, no header). Example: supportField's
```

### Untracked: `scripts/chainspot-lab/prompts/groundcheck-step0.md`

This is a reusable epistemic-discipline prompt — a coordinate-frame trap with a
real pass/fail signal. It is the GUM-AVE loop applied to a specific, verifiable
failure mode (carrying a stale pixel coordinate across a crop). Preserve it.

```markdown
STEP 0 — before anything else, do this exactly, in order. This uses real
files in a real repo, not a hypothetical — you can verify every claim
below yourself.

REPO: C:\Users\tenni\workspace\ChainSpot-chspt-82
BRANCH: integration/claude-t1-t6 (as of commit 0615c93)
RAW IMAGE: chainspot-corpus/dev/Heritage/HeritagePark-full.png
TRUTH FILE: chainspot-corpus/dev/Annotated/Heritage/HeritagePark-full.annotation.json

1. Open HeritagePark-full.png. Before running anything, state your own
   estimate, in plain language, of where the densest cluster of
   disc-golf course content is (baskets, tees, badges) — roughly which
   region of the image. This is a guess. Write it down before step 2.

2. Run the real crop script and read its output:
     cd C:\Users\tenni\workspace\ChainSpot-chspt-82
     npx vitest run tests/unit/g0EvidenceHeritage.test.ts
   This calls the real applyCrop function (packages/alg/src/g0/crop.ts)
   on this exact file and prints the actual crop it applied: raw frame
   1290x2796 -> crop insets {top:429, bottom:252} -> canonical frame
   1290x2115. Those numbers are ground truth for this file, not a
   simulation — if your run prints something different, that itself is
   a finding, not a step to paper over.

3. Your step-1 guess was made in the RAW 1290x2796 frame. The script's
   real output is in the CROPPED 1290x2115 frame — every y-coordinate
   shifted by -429. Explicitly re-state where your point of interest
   actually is in the cropped frame's coordinates. Do not reuse any
   pixel number from step 1 unmodified — shift it, or re-read it, and
   show which you did.

4. Check your reconciled coordinate against real ground truth: open
   HeritagePark-full.annotation.json and find the tee/basket position
   nearest your reconciled estimate. State which hole it is and the
   pixel distance. This is your actual pass/fail signal — a close
   distance means your reconciliation was real; a large one means you
   drifted and should say so, not round it away.

5. Only after step 4 is written down do you proceed to the actual task.

Why: your first guess is allowed to be wrong — that's not the point being
tested. The point is whether you notice and correct when the frame
changes under you, checked against a real number (step 4), instead of
carrying a stale coordinate forward because it "felt" right.
```

Note the concrete numbers this prompt pins as ground truth for
`HeritagePark-full.png`: raw frame `1290 × 2796`, crop insets
`{top: 429, bottom: 252}`, canonical frame `1290 × 2115`, y-shift `-429`.
Those are asserted as real output of `packages/alg/src/g0/crop.ts` via
`tests/unit/g0EvidenceHeritage.test.ts`. I did not execute that test.

### Untracked: `.claude/launch.json`

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "lab",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 5173
    }
  ]
}
```

---

## B. `ChainSpot-demo` (branch `demo/mock-engine`, HEAD `0850f75`)

```
 src/lib/components/GuidedReviewPanel.svelte | 116 +++++++--
 src/lib/components/ImageViewport.svelte     | 151 +++++++++++-
 src/lib/guidedReview.ts                     | 289 ++++++++++++++--------
 src/lib/session.ts                          |   6 +
 src/routes/+page.svelte                     | 257 ++++++++++++++++++--
 src/routes/map-round/+page.svelte           |  24 +-
 tests/unit/guidedReview.test.ts             | 358 +++++++++-------------------
 7 files changed, 794 insertions(+), 407 deletions(-)
```

### B1. `src/lib/guidedReview.ts` — the state machine (highest-value file in tree B)

```diff
diff --git a/src/lib/guidedReview.ts b/src/lib/guidedReview.ts
index b28c0f8..340d331 100644
--- a/src/lib/guidedReview.ts
+++ b/src/lib/guidedReview.ts
@@ -3,13 +3,10 @@ export interface Point {
 	readonly yPx: number;
 }
 
-// Structurally identical to courseDetect.ts's HoleProposal (kept as a local
-// copy, not an import, so this module has zero dependency on that sibling
-// task's file existing yet — any real HoleProposal[] from courseDetect.ts
-// satisfies this type as-is).
+// Structurally identical to courseDetect.ts's HoleProposal. Keeping this
+// module independent lets the review state remain a small pure reducer.
 export interface HoleProposal {
 	readonly n: number;
-	/** merged badge position, composite px — the hole's visual anchor */
 	readonly badge: Point;
 	readonly tee: Point | null;
 	readonly basket: Point | null;
@@ -17,6 +14,14 @@ export interface HoleProposal {
 }
 
 export type Anchor = 'tee' | 'basket' | 'bend';
+export type ReviewStep = 'tee' | 'basket' | 'bends';
+export type ReviewStepStatus = 'pending' | 'accepted' | 'skipped';
+
+export interface ReviewStepState {
+	readonly tee: ReviewStepStatus;
+	readonly basket: ReviewStepStatus;
+	readonly bends: ReviewStepStatus;
+}
 
 export interface ReviewHoleState {
 	readonly n: number;
@@ -26,131 +31,225 @@ export interface ReviewHoleState {
 	readonly bends: readonly Point[];
 	readonly status: 'pending' | 'accepted';
 	readonly replacements: { readonly tee: number; readonly basket: number; readonly bend: number };
+	/** Optional for compatibility with existing persisted accepted fixtures. */
+	readonly stepStatus?: ReviewStepState;
 }
 
 export interface ReviewState {
-	readonly holes: readonly ReviewHoleState[]; // queue order = ascending n, fixed at createReview()
-	readonly currentIndex: number; // index of the hole under review; === holes.length when done
+	readonly holes: readonly ReviewHoleState[];
+	readonly currentIndex: number;
+	/** Present on states created by createReview; optional for old draft literals. */
+	readonly currentStep?: ReviewStep | null;
 	readonly done: boolean;
+	/** False for an empty review and until every hole has been explicitly reviewed. */
+	readonly valid?: boolean;
+}
+
+const STEPS: readonly ReviewStep[] = ['tee', 'basket', 'bends'];
+const EMPTY_STEPS: ReviewStepState = { tee: 'pending', basket: 'pending', bends: 'pending' };
+
+function stepStatus(hole: ReviewHoleState): ReviewStepState {
+	return hole.stepStatus ?? (hole.status === 'accepted'
+		? { tee: 'accepted', basket: 'accepted', bends: 'accepted' }
+		: EMPTY_STEPS);
+}
+
+function firstPendingStep(hole: ReviewHoleState): ReviewStep | null {
+	const steps = stepStatus(hole);
+	return STEPS.find((step) => steps[step] === 'pending') ?? null;
 }
 
-export function createReview(proposals: readonly HoleProposal[]): ReviewState {
-	// Sort a COPY of proposals ascending by n
-	const sorted = [...proposals].sort((a, b) => a.n - b.n);
+function rebuild(holes: readonly ReviewHoleState[], preferredIndex?: number): ReviewState {
+	const preferredPending = preferredIndex !== undefined && holes[preferredIndex]?.status === 'pending';
+	const currentIndex = preferredPending ? preferredIndex : holes.findIndex((hole) => hole.status === 'pending');
+	const index = currentIndex === -1 ? holes.length : currentIndex;
+	const hole = holes[index];
+	const done = index >= holes.length;
+	return {
+		holes,
+		currentIndex: index,
+		currentStep: done || !hole ? null : firstPendingStep(hole),
+		done,
+		valid: holes.length > 0 && done
+	};
+}
 
-	// Map each to a ReviewHoleState with status:'pending', replacements:{tee:0,basket:0,bend:0}
-	const holes: ReviewHoleState[] = sorted.map((proposal) => ({
+function reviewHole(proposal: HoleProposal | ReviewHoleState): ReviewHoleState {
+	if ('status' in proposal) {
+		return {
+			...proposal,
+			bends: [...proposal.bends],
+			stepStatus: proposal.stepStatus
+				? { ...proposal.stepStatus }
+				: proposal.status === 'accepted'
+					? { tee: 'accepted', basket: 'accepted', bends: 'accepted' }
+					: { ...EMPTY_STEPS },
+			replacements: { ...proposal.replacements }
+		};
+	}
+	return {
 		n: proposal.n,
 		badge: proposal.badge,
 		tee: proposal.tee,
 		basket: proposal.basket,
-		bends: proposal.bends,
-		status: 'pending' as const,
-		replacements: { tee: 0, basket: 0, bend: 0 }
-	}));
+		bends: [...proposal.bends],
+		status: 'pending',
+		replacements: { tee: 0, basket: 0, bend: 0 },
+		stepStatus: { ...EMPTY_STEPS }
+	};
+}
 
-	// currentIndex = index of first pending hole (0 for non-empty, holes.length for empty)
-	const currentIndex = holes.length > 0 ? 0 : 0;
+/** Create a sorted review, also accepting old persisted ReviewHoleState fixtures. */
+export function createReview(items: readonly HoleProposal[] | readonly ReviewHoleState[]): ReviewState {
+	const holes = [...items]
+		.sort((a, b) => a.n - b.n)
+		.map((item) => reviewHole(item));
+	return rebuild(holes);
+}
 
-	// done = currentIndex >= holes.length
-	const done = currentIndex >= holes.length;
+function updateHole(
+	state: ReviewState,
+	holeN: number,
+	update: (hole: ReviewHoleState) => ReviewHoleState
+): ReviewState {
+	const index = state.holes.findIndex((hole) => hole.n === holeN);
+	if (index === -1) return state;
+	const holes = state.holes.map((hole, i) => (i === index ? update(hole) : hole));
+	return rebuild(holes, state.currentIndex);
+}
 
-	return { holes, currentIndex, done };
+function setStep(hole: ReviewHoleState, step: ReviewStep, status: ReviewStepStatus): ReviewHoleState {
+	const steps = { ...stepStatus(hole), [step]: status } as ReviewStepState;
+	const complete = STEPS.every((name) => steps[name] !== 'pending');
+	return { ...hole, status: complete ? 'accepted' : 'pending', stepStatus: steps };
 }
 
-export function accept(state: ReviewState, holeN: number): ReviewState {
-	// Find the hole with the given n
-	const holeIndex = state.holes.findIndex((h) => h.n === holeN);
+function place(
+	state: ReviewState,
+	holeN: number,
+	anchor: 'tee' | 'basket',
+	p: Point
+): ReviewState {
+	return updateHole(state, holeN, (hole) => ({
+		...hole,
+		[anchor]: p,
+		status: 'pending',
+		stepStatus: { ...stepStatus(hole), [anchor]: 'pending' },
+		replacements: { ...hole.replacements, [anchor]: hole.replacements[anchor] + 1 }
+	}));
+}
 
-	// If no hole has that n, or it's already accepted, return the SAME state reference unchanged
-	if (holeIndex === -1 || state.holes[holeIndex].status === 'accepted') {
-		return state;
-	}
+export function placeTee(state: ReviewState, holeN: number, p: Point): ReviewState {
+	return place(state, holeN, 'tee', p);
+}
 
-	// Otherwise return a NEW ReviewState: new holes array where only the matched hole becomes
-	// a NEW object with status:'accepted' (everything else on it unchanged)
-	const newHoles: ReviewHoleState[] = state.holes.map((hole, idx) => {
-		if (idx === holeIndex) {
-			return { ...hole, status: 'accepted' as const };
-		}
-		return hole;
-	});
+export function placeBasket(state: ReviewState, holeN: number, p: Point): ReviewState {
+	return place(state, holeN, 'basket', p);
+}
 
-	// Recompute currentIndex by scanning from START for first pending hole
-	let currentIndex = 0;
-	while (currentIndex < newHoles.length && newHoles[currentIndex].status !== 'pending') {
-		currentIndex++;
-	}
+export function addBend(state: ReviewState, holeN: number, p: Point): ReviewState {
+	return updateHole(state, holeN, (hole) => ({
+		...hole,
+		bends: [...hole.bends, p],
+		status: 'pending',
+		stepStatus: { ...stepStatus(hole), bends: 'pending' },
+		replacements: { ...hole.replacements, bend: hole.replacements.bend + 1 }
+	}));
+}
 
-	// Recompute done
-	const done = currentIndex >= newHoles.length;
+export function selectHole(state: ReviewState, holeN: number): ReviewState {
+	const index = state.holes.findIndex((hole) => hole.n === holeN);
+	if (index === -1) return state;
+	const holes = state.holes.map((hole, i) =>
+		i === index && hole.status === 'accepted'
+			? { ...hole, status: 'pending' as const, stepStatus: { ...EMPTY_STEPS } }
+			: hole
+	);
+	return { ...state, holes, currentIndex: index, currentStep: firstPendingStep(holes[index]), done: false, valid: false };
+}
 
-	return { holes: newHoles, currentIndex, done };
+export function moveBend(state: ReviewState, holeN: number, bendIndex: number, p: Point): ReviewState {
+	return updateHole(state, holeN, (hole) => {
+		if (!hole.bends[bendIndex]) return hole;
+		const bends = hole.bends.map((bend, index) => (index === bendIndex ? p : bend));
+		return {
+			...hole,
+			bends,
+			status: 'pending',
+			stepStatus: { ...stepStatus(hole), bends: 'pending' },
+			replacements: { ...hole.replacements, bend: hole.replacements.bend + 1 }
+		};
+	});
 }
 
-export function replace(
+export function removeAnchor(
 	state: ReviewState,
 	holeN: number,
 	anchor: Anchor,
-	p: Point
+	bendIndex = 0
 ): ReviewState {
-	// Find the hole with the given n
-	const holeIndex = state.holes.findIndex((h) => h.n === holeN);
+	return updateHole(state, holeN, (hole) => ({
+		...hole,
+		tee: anchor === 'tee' ? null : hole.tee,
+		basket: anchor === 'basket' ? null : hole.basket,
+		bends: anchor === 'bend' ? hole.bends.filter((_, index) => index !== bendIndex) : hole.bends,
+		status: 'pending',
+		stepStatus: { ...stepStatus(hole), [anchor === 'bend' ? 'bends' : anchor]: 'pending' }
+	}));
+}
 
-	// If no hole has that n, return state unchanged
-	if (holeIndex === -1) {
-		return state;
-	}
+/** Accept one current step; completion happens only after all three decisions. */
+export function acceptStep(state: ReviewState): ReviewState {
+	const hole = currentHole(state);
+	const step = currentStep(state);
+	return hole && step ? updateHole(state, hole.n, (h) => setStep(h, step, 'accepted')) : state;
+}
 
-	const hole = state.holes[holeIndex];
+/** Explicitly skip one current step; skipped data is still a reviewed decision. */
+export function skipStep(state: ReviewState): ReviewState {
+	const hole = currentHole(state);
+	const step = currentStep(state);
+	return hole && step ? updateHole(state, hole.n, (h) => setStep(h, step, 'skipped')) : state;
+}
 
-	// Build a new hole object based on which anchor
-	let newHole: ReviewHoleState;
-	if (anchor === 'tee') {
-		newHole = {
-			...hole,
-			tee: p,
-			replacements: { ...hole.replacements, tee: hole.replacements.tee + 1 },
-			status: 'accepted' as const
-		};
-	} else if (anchor === 'basket') {
-		newHole = {
-			...hole,
-			basket: p,
-			replacements: { ...hole.replacements, basket: hole.replacements.basket + 1 },
-			status: 'accepted' as const
-		};
-	} else {
-		// anchor === 'bend'
-		// This slice supports exactly ONE bend per hole
-		newHole = {
+/** Compatibility action for callers that explicitly accept a whole hole. */
+export function accept(state: ReviewState, holeN: number): ReviewState {
+	return updateHole(state, holeN, (hole) => ({
+		...hole,
+		status: 'accepted',
+		stepStatus: { tee: 'accepted', basket: 'accepted', bends: 'accepted' }
+	}));
+}
+
+/** Replace one anchor without accepting or advancing the hole. */
+export function replace(state: ReviewState, holeN: number, anchor: Anchor, p: Point): ReviewState {
+	if (anchor === 'tee') return placeTee(state, holeN, p);
+	if (anchor === 'basket') return placeBasket(state, holeN, p);
+	return updateHole(state, holeN, (hole) => {
+		const bends = hole.bends.length ? [p, ...hole.bends.slice(1)] : [p];
+		return {
 			...hole,
-			bends: [p],
-			replacements: { ...hole.replacements, bend: hole.replacements.bend + 1 },
-			status: 'accepted' as const
+			bends,
+			status: 'pending',
+			stepStatus: { ...stepStatus(hole), bends: 'pending' },
+			replacements: { ...hole.replacements, bend: hole.replacements.bend + 1 }
 		};
-	}
-
-	// Create new holes array with the updated hole
-	const newHoles: ReviewHoleState[] = state.holes.map((h, idx) => {
-		if (idx === holeIndex) {
-			return newHole;
-		}
-		return h;
 	});
-
-	// Recompute currentIndex by scanning from START for first pending hole
-	let currentIndex = 0;
-	while (currentIndex < newHoles.length && newHoles[currentIndex].status !== 'pending') {
-		currentIndex++;
-	}
-
-	// Recompute done
-	const done = currentIndex >= newHoles.length;
-
-	return { holes: newHoles, currentIndex, done };
 }
 
 export function currentHole(state: ReviewState): ReviewHoleState | null {
 	return state.holes[state.currentIndex] ?? null;
 }
+
+export function currentStep(state: ReviewState): ReviewStep | null {
+	const hole = currentHole(state);
+	return state.currentStep ?? (hole ? firstPendingStep(hole) : null);
+}
+
+/** Explicit confirmation guard; old states are evaluated instead of trusted. */
+export function isReviewValid(state: ReviewState): boolean {
+	return state.holes.length > 0 && state.done && state.holes.every((hole) => {
+		const steps = stepStatus(hole);
+		return hole.status === 'accepted' && STEPS.every((step) => steps[step] !== 'pending');
+	});
+}
```

### B2. `src/lib/session.ts`

```diff
diff --git a/src/lib/session.ts b/src/lib/session.ts
index 59f1c99..8aaa1d7 100644
--- a/src/lib/session.ts
+++ b/src/lib/session.ts
@@ -32,3 +32,9 @@ export function setMappedRound(round: MappedRound | null): void {
 export function getMappedRound(): MappedRound | null {
 	return mappedRound;
 }
+
+/** Clear all cross-page artifacts before starting a new import. */
+export function resetSession(): void {
+	courseMap = null;
+	mappedRound = null;
+}
```

### B3. `src/routes/map-round/+page.svelte`

Removes four `disabled title="Not implemented"` buttons; switches the walk path
from a one-bend quadratic curve to an all-bends polyline.

```diff
diff --git a/src/routes/map-round/+page.svelte b/src/routes/map-round/+page.svelte
index 6b72cd7..540cca1 100644
--- a/src/routes/map-round/+page.svelte
+++ b/src/routes/map-round/+page.svelte
@@ -87,15 +87,9 @@
 {:else}
 	{@const viewBox = computeViewBox(courseMap)}
 
-	<!-- Controls row -->
-	<div style="display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; border-bottom: 1px solid #ccc;">
-		<button disabled title="Not implemented">Project round</button>
-		<button disabled title="Not implemented">Re-run projection</button>
-		<button disabled title="Not implemented">Per-hole corrections</button>
-		<button disabled title="Not implemented">Continue → Create Graphics</button>
-		<a href="/" style="margin-left: auto;">
-			<button>Back to Import</button>
-		</a>
+	<!-- The page currently renders the connected downstream artifact only. -->
+	<div style="padding: 0.5rem; border-bottom: 1px solid #ccc;">
+		<a href="/">Back to Import</a>
 	</div>
 
 	<!-- Course SVG with optional walk trace and droplets -->
@@ -121,8 +115,8 @@
 		{#each courseMap.holes as h (h.n)}
 			<!-- Path from tee to basket through bends -->
 			{#if h.tee && h.basket}
-				<path
-					d={`M ${h.tee.xPx} ${h.tee.yPx} ${h.bends.length ? `Q ${h.bends[0].xPx} ${h.bends[0].yPx}` : 'L'} ${h.basket.xPx} ${h.basket.yPx}`}
+				<polyline
+					points={[h.tee, ...h.bends, h.basket].map((point) => `${point.xPx},${point.yPx}`).join(' ')}
 					stroke="#465446"
 					fill="none"
 					stroke-width="4"
@@ -180,12 +174,4 @@
 		text-decoration: none;
 	}
 
-	a button {
-		cursor: pointer;
-	}
-
-	button:disabled {
-		opacity: 0.5;
-		cursor: not-allowed;
-	}
 </style>
```

### B4. `src/lib/components/ImageViewport.svelte` — review markers + review camera

All seven UNKNOWN magic numbers live in this diff.

```diff
diff --git a/src/lib/components/ImageViewport.svelte b/src/lib/components/ImageViewport.svelte
index 37b7cce..d026265 100644
--- a/src/lib/components/ImageViewport.svelte
+++ b/src/lib/components/ImageViewport.svelte
@@ -2,6 +2,7 @@
 	import type { Snippet } from 'svelte';
 	import type { ViewportLayer, ViewportMarker } from '$lib/viewport';
 	import type { CropInsets } from '$lib/raster';
+	import type { ReviewMarker, ReviewMarkerPoint } from './reviewMarker';
 
 	import { untrack } from 'svelte';
 
@@ -14,7 +15,16 @@
 		height = '70vh',
 		fitKey = 0,
 		markers = [],
+		reviewMarkers = [],
+		reviewBadgePoints = [],
+		reviewFocus = null,
+		reviewFocusKey = null,
+		reviewZoomStep = 0,
 		onCanvasClick,
+		onReviewMarkerClick,
+		onReviewMarkerMove,
+		onReviewMarkerDelete,
+		onReviewMarkerReassign,
 		animate = false,
 		clipInsets = null,
 		clipAnimate = false
@@ -28,8 +38,18 @@
 		fitKey?: number; // bump to re-frame the content (new stitch result etc.)
 		/** per-layer detection markers, in that layer's local (display) pixels */
 		markers?: ViewportMarker[][];
+		/** review markers in stitched/composite original pixels (not layer-local pixels) */
+		reviewMarkers?: readonly ReviewMarker[];
+		reviewBadgePoints?: readonly ReviewMarkerPoint[];
+		reviewFocus?: ReviewMarkerPoint | null;
+		reviewFocusKey?: number | null;
+		reviewZoomStep?: number;
 		/** fired for a true click (no drag): point in CONTENT coordinates */
 		onCanvasClick?: (p: { x: number; y: number }) => void;
+		onReviewMarkerClick?: (id: string) => void;
+		onReviewMarkerMove?: (id: string, p: ReviewMarkerPoint) => void;
+		onReviewMarkerDelete?: (id: string) => void;
+		onReviewMarkerReassign?: (id: string) => void;
 		/** transition layer transforms (choreography only — keep off for drags) */
 		animate?: boolean;
 		/** animated shared clip applied to every layer (the crop "drawers") */
@@ -72,6 +92,11 @@
 	let scale = $state(0.2);
 	let offsetX = $state(0);
 	let offsetY = $state(0);
+	let toolbarWidth = $state(0);
+	let reviewCameraActive = false;
+	let lastReviewFocusKey: number | null = null;
+	let reviewMinScale = 0.02;
+	let lastReviewZoomStep = 0;
 
 	// one capture target (the container) for both pan and layer-drag, so
 	// pointermove routing never depends on which child started the gesture
@@ -93,9 +118,10 @@
 		const cw = container.clientWidth - margin * 2;
 		const ch = container.clientHeight - margin * 2;
 		if (cw <= 0 || ch <= 0) return;
-		scale = Math.min(cw / (x1 - x0), ch / (y1 - y0));
-		offsetX = margin + (cw - (x1 - x0) * scale) / 2 - x0 * scale;
-		offsetY = margin + (ch - (y1 - y0) * scale) / 2 - y0 * scale;
+		const nextScale = Math.min(cw / (x1 - x0), ch / (y1 - y0));
+		scale = nextScale;
+		offsetX = margin + (cw - (x1 - x0) * nextScale) / 2 - x0 * nextScale;
+		offsetY = margin + (ch - (y1 - y0) * nextScale) / 2 - y0 * nextScale;
 	}
 
 	$effect(() => {
@@ -103,8 +129,56 @@
 		fitToContent();
 	});
 
+	function reviewCenter(): { x: number; y: number } {
+		const safeWidth = Math.max(1, container.clientWidth - toolbarWidth - 24);
+		return { x: safeWidth / 2, y: container.clientHeight / 2 };
+	}
+
+	function centerReviewPoint(point: ReviewMarkerPoint) {
+		const center = reviewCenter();
+		offsetX = center.x - point.xPx * scale;
+		offsetY = center.y - point.yPx * scale;
+	}
+
+	function startReviewCamera(points: readonly ReviewMarkerPoint[], focus: ReviewMarkerPoint) {
+		const center = reviewCenter();
+		let courseFit = scale;
+		if (points.length > 1) {
+			const xs = points.map((point) => point.xPx);
+			const ys = points.map((point) => point.yPx);
+			const width = Math.max(1, Math.max(...xs) - Math.min(...xs));
+			const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
+			courseFit = Math.min((center.x * 2 - 48) / width, (center.y * 2 - 48) / height);
+		}
+		reviewMinScale = Math.min(scale, courseFit);
+		scale = Math.min(1, Math.max(reviewMinScale, courseFit * 2));
+		centerReviewPoint(focus);
+	}
+
+	$effect(() => {
+		const focus = reviewFocus;
+		const focusKey = reviewFocusKey;
+		if (!focus || focusKey === null) {
+			reviewCameraActive = false;
+			lastReviewFocusKey = null;
+			return;
+		}
+		if (!reviewCameraActive) {
+			reviewCameraActive = true;
+			lastReviewFocusKey = focusKey;
+			const points = [...reviewBadgePoints];
+			setTimeout(() => {
+				if (reviewFocusKey === focusKey) startReviewCamera(points, focus);
+			});
+		} else if (focusKey !== lastReviewFocusKey) {
+			lastReviewFocusKey = focusKey;
+			centerReviewPoint(focus);
+		}
+	});
+
 	let panning = false;
 	let movingLayerIndex = -1;
+	let movingReviewMarker: string | null = null;
 	let lastX = 0;
 	let lastY = 0;
 
@@ -133,6 +207,11 @@
 	}
 
 	function onPointerMove(event: PointerEvent) {
+		if (movingReviewMarker !== null) {
+			lastX = event.clientX;
+			lastY = event.clientY;
+			return;
+		}
 		if (movingLayerIndex >= 0) {
 			const deltaX = (event.clientX - lastX) / scale;
 			const deltaY = (event.clientY - lastY) / scale;
@@ -150,6 +229,21 @@
 	}
 
 	function onPointerUp(event: PointerEvent) {
+		if (movingReviewMarker !== null) {
+			const rect = container.getBoundingClientRect();
+			const point = {
+				xPx: (event.clientX - rect.left - offsetX) / scale,
+				yPx: (event.clientY - rect.top - offsetY) / scale
+			};
+			if (Math.hypot(event.clientX - downX, event.clientY - downY) < 5) {
+				onReviewMarkerClick?.(movingReviewMarker);
+			} else {
+				onReviewMarkerMove?.(movingReviewMarker, point);
+			}
+			movingReviewMarker = null;
+			panning = false;
+			return;
+		}
 		const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
 		if (moved < 5 && onCanvasClick) {
 			const rect = container.getBoundingClientRect();
@@ -171,6 +265,43 @@
 		downX = event.clientX;
 		downY = event.clientY;
 	}
+
+	$effect(() => {
+		const step = reviewZoomStep;
+		const delta = step - lastReviewZoomStep;
+		lastReviewZoomStep = step;
+		if (!reviewFocus || delta === 0) return;
+		scale = Math.min(4, Math.max(reviewMinScale, scale * 1.1 ** delta));
+		centerReviewPoint(reviewFocus);
+	});
+
+	function onReviewMarkerPointerDown(event: PointerEvent, id: string) {
+		event.stopPropagation();
+		container.setPointerCapture(event.pointerId);
+		movingReviewMarker = id;
+		lastX = event.clientX;
+		lastY = event.clientY;
+		downX = event.clientX;
+		downY = event.clientY;
+	}
+
+	function markerColor(marker: ReviewMarker): string {
+		return marker.color ?? (marker.kind === 'tee' ? '#166534' : marker.kind === 'basket' ? '#b91c1c' : '#7e22ce');
+	}
+
+	function markerLabel(marker: ReviewMarker): string {
+		return marker.label ?? (marker.kind === 'tee' ? 'T' : marker.kind === 'basket' ? 'B' : '•');
+	}
+
+	function onReviewMarkerKeydown(event: KeyboardEvent, marker: ReviewMarker) {
+		if (event.key === 'Delete' || event.key === 'Backspace') {
+			event.preventDefault();
+			onReviewMarkerDelete?.(marker.id);
+		} else if (event.key.toLowerCase() === 'r') {
+			event.preventDefault();
+			onReviewMarkerReassign?.(marker.id);
+		}
+	}
 </script>
 
 <div
@@ -236,10 +367,24 @@
 			{/if}
 		</div>
 	{/each}
+	{#each reviewMarkers as marker (marker.id)}
+		<button
+			type="button"
+			aria-label={marker.title ?? `${markerLabel(marker)} marker${marker.holeN === undefined ? '' : ` for hole ${marker.holeN}`}`}
+			title={marker.title}
+			style={`position: absolute; left: ${offsetX + marker.xPx * scale}px; top: ${offsetY + marker.yPx * scale}px; transform: translate(-50%, -50%); width: 34px; height: 34px; border-radius: 50%; border: 3px solid white; background: ${markerColor(marker)}; color: white; font: bold 16px sans-serif; z-index: 3; cursor: grab;`}
+			onpointerdown={(event) => onReviewMarkerPointerDown(event, marker.id)}
+			onkeydown={(event) => onReviewMarkerKeydown(event, marker)}
+			ondblclick={() => onReviewMarkerReassign?.(marker.id)}
+		>
+			{markerLabel(marker)}
+		</button>
+	{/each}
 	{#if children}
 		<!-- stop pointerdown here: if it reaches the container, setPointerCapture
 		     retargets the gesture and the buttons' click events never fire -->
 		<div
+			bind:clientWidth={toolbarWidth}
 			role="toolbar"
 			tabindex="-1"
 			aria-label="Viewport controls"
```

### B5. `src/lib/components/GuidedReviewPanel.svelte`

```diff
diff --git a/src/lib/components/GuidedReviewPanel.svelte b/src/lib/components/GuidedReviewPanel.svelte
index 8b4eb41..bf1378d 100644
--- a/src/lib/components/GuidedReviewPanel.svelte
+++ b/src/lib/components/GuidedReviewPanel.svelte
@@ -1,65 +1,129 @@
 <script lang="ts">
-	import { currentHole, type Anchor, type ReviewState } from '$lib/guidedReview';
+	import { currentHole, currentStep, type Anchor, type ReviewState } from '$lib/guidedReview';
 
 	let {
 		review,
 		replaceArming,
-		onAccept,
 		onArmReplace,
 		onCancelReplace,
-		onConfirmAll
+		onConfirmAll,
+		onSelectHole,
+		onAcceptPiece,
+		onSkipPiece,
+		onCancelReview,
+		canConfirm = false
 	}: {
 		review: ReviewState;
 		replaceArming: { holeN: number; anchor: Anchor } | null;
-		onAccept: (holeN: number) => void;
 		onArmReplace: (holeN: number, anchor: Anchor) => void;
 		onCancelReplace: () => void;
 		onConfirmAll: () => void;
+		onSelectHole?: (holeN: number) => void;
+		onAcceptPiece?: (holeN: number, anchor: Anchor) => void;
+		onSkipPiece?: (holeN: number, anchor: Anchor) => void;
+		onCancelReview?: () => void;
+		canConfirm?: boolean;
 	} = $props();
 
 	let hole = $derived(currentHole(review));
 	let total = $derived(review.holes.length);
 	let acceptedCount = $derived(review.holes.filter((h) => h.status === 'accepted').length);
 	let arming = $derived(replaceArming !== null);
+	let step = $derived(currentStep(review));
+	let activeAnchor = $derived<Anchor | null>(step === 'bends' ? 'bend' : step ?? null);
+
+	function hasPiece(anchor: Anchor): boolean {
+		if (!hole) return false;
+		return anchor === 'tee' ? hole.tee !== null : anchor === 'basket' ? hole.basket !== null : true;
+	}
+
+	function acceptPiece(anchor: Anchor) {
+		if (!hole) return;
+		onAcceptPiece?.(hole.n, anchor);
+	}
+
+	function skipPiece(anchor: Anchor) {
+		if (hole) onSkipPiece?.(hole.n, anchor);
+	}
+
+	function onKeydown(event: KeyboardEvent) {
+		if (event.key !== 'Escape') return;
+		if (!replaceArming && !onCancelReview) return;
+		event.preventDefault();
+		if (replaceArming) onCancelReplace();
+		else onCancelReview?.();
+	}
 </script>
 
-<div style="background: white; border: 1px solid black; padding: 0.5rem; font-size: 0.85rem;">
+<svelte:window onkeydown={onKeydown} />
+<div
+	style="background: white; border: 1px solid black; padding: 0.5rem; font-size: 0.85rem;"
+	role="region"
+	aria-label="Guided annotation review"
+>
+	{#if onSelectHole && review.holes.length > 0}
+		<label>
+			Hole
+			<select
+				value={hole?.n ?? ''}
+				onchange={(event) => onSelectHole?.(Number((event.currentTarget as HTMLSelectElement).value))}
+			>
+				{#each review.holes as candidate (candidate.n)}
+					<option value={candidate.n}>Hole {candidate.n}</option>
+				{/each}
+			</select>
+		</label>
+	{/if}
+
 	{#if review.done}
 		<div>All {total} holes reviewed</div>
-		<button style="width: 100%; margin-top: 0.5rem;" onclick={onConfirmAll}
-			><strong>Confirm Annotation</strong></button
-		>
+		{#if canConfirm}
+			<button type="button" style="width: 100%; margin-top: 0.5rem;" onclick={onConfirmAll}>
+				<strong>Confirm Annotation</strong>
+			</button>
+		{/if}
 	{:else if hole}
 		<div><strong>Reviewing hole {hole.n} of {total}</strong></div>
-		<div>tee: {hole.tee ? 'placed' : 'missing'}</div>
-		<div>basket: {hole.basket ? 'placed' : 'missing'}</div>
-		<div>bend: {hole.bends.length > 0 ? 'placed' : 'missing'}</div>
+		{#if (onAcceptPiece || onSkipPiece) && activeAnchor}
+			{@const anchor = activeAnchor}
+				<div style="display: flex; align-items: center; gap: 0.25rem; margin-top: 0.25rem;">
+					<span style="min-width: 7rem;">{anchor}: {anchor === 'bend' ? `${hole.bends.length} placed` : hasPiece(anchor) ? 'placed' : 'missing'}</span>
+					{#if onAcceptPiece}
+						<button type="button" disabled={!hasPiece(anchor)} onclick={() => acceptPiece(anchor)}>Accept</button>
+					{/if}
+					{#if onSkipPiece}
+						<button type="button" onclick={() => skipPiece(anchor)}>Skip</button>
+					{/if}
+				</div>
+		{/if}
+
 		{#if replaceArming}
 			<div style="margin-top: 0.5rem;">
 				Click the map to place the {replaceArming.anchor} for hole {replaceArming.holeN}
 			</div>
-			<button style="width: 100%; margin-top: 0.25rem;" onclick={onCancelReplace}>Cancel</button>
+			<button type="button" style="width: 100%; margin-top: 0.25rem;" onclick={onCancelReplace}>
+				Cancel placement
+			</button>
 		{/if}
-		<button
-			style="width: 100%; margin-top: 0.5rem;"
-			disabled={arming}
-			onclick={() => onAccept(hole.n)}><strong>Accept hole</strong></button
-		>
-		<button
+
+		{#if !activeAnchor || activeAnchor === 'tee'}<button
+			type="button"
 			style="width: 100%; margin-top: 0.25rem;"
 			disabled={arming}
-			onclick={() => onArmReplace(hole.n, 'tee')}>Place tee</button
-		>
-		<button
+			onclick={() => onArmReplace(hole.n, 'tee')}>Place tee</button>{/if}
+		{#if !activeAnchor || activeAnchor === 'basket'}<button
+			type="button"
 			style="width: 100%; margin-top: 0.25rem;"
 			disabled={arming}
-			onclick={() => onArmReplace(hole.n, 'basket')}>Place basket</button
-		>
-		<button
+			onclick={() => onArmReplace(hole.n, 'basket')}>Place basket</button>{/if}
+		{#if !activeAnchor || activeAnchor === 'bend'}<button
+			type="button"
 			style="width: 100%; margin-top: 0.25rem;"
 			disabled={arming}
-			onclick={() => onArmReplace(hole.n, 'bend')}>Place bend</button
-		>
+			onclick={() => onArmReplace(hole.n, 'bend')}>Add bend</button>{/if}
+	{/if}
+	{#if onCancelReview}
+		<button type="button" style="width: 100%; margin-top: 0.5rem;" onclick={onCancelReview}>Cancel review</button>
 	{/if}
 	<div style="margin-top: 0.5rem;"><small>{acceptedCount} of {total} accepted</small></div>
 </div>
```

### B6. `src/routes/+page.svelte` — wiring, association→endpoint transform, auto-accept removal

The single most important hunk in tree B is the removal of
`for (const n of strongNs) r = accept(r, n);`.

```diff
diff --git a/src/routes/+page.svelte b/src/routes/+page.svelte
index 138cf81..58092b8 100644
--- a/src/routes/+page.svelte
+++ b/src/routes/+page.svelte
@@ -18,14 +18,24 @@
 	import type { ViewportMarker } from '$lib/viewport';
 	import { detectCourse, type SeedBadge } from '$lib/courseDetect';
 	import {
-		accept,
+		acceptStep,
+		addBend,
 		createReview,
-		replace,
+		currentHole,
+		currentStep,
+		isReviewValid,
+		moveBend,
+		placeBasket,
+		placeTee,
+		removeAnchor,
+		selectHole,
+		skipStep,
 		type Anchor,
 		type ReviewHoleState,
 		type ReviewState
 	} from '$lib/guidedReview';
 	import GuidedReviewPanel from '$lib/components/GuidedReviewPanel.svelte';
+	import type { ReviewMarker } from '$lib/components/reviewMarker';
 	import PairPanel from '$lib/components/PairPanel.svelte';
 	import { searchPlace, attributionFor, type GeocodeMatch } from '$lib/geocodeSearch';
 	import {
@@ -39,7 +49,8 @@
 	import { walkTraceDetector } from '$lib/detectors/walkTrace';
 	import { landingDropletDetector } from '$lib/detectors/landingDroplet';
 	import { applySimilarity, fitSimilarity, matchByHoleNumber } from '$lib/registration';
-	import { setCourseMap, setMappedRound, getMappedRound } from '$lib/session';
+	import { setCourseMap, setMappedRound, getMappedRound, resetSession } from '$lib/session';
+	import { parseReviewDraft, serializeReviewDraft } from '$lib/reviewDraft';
 	import { goto } from '$app/navigation';
 	import { onMount } from 'svelte';
 	import { loadMockFixture, type MockCourseFixture } from '$lib/mockBoot';
@@ -50,6 +61,7 @@
 	// real-capture evidence can raise it later without changing the detector.
 	const THROWN_ROUND_PURPLE_MASS_MIN = 0;
 	const PAGE_MARGIN_PX = 8; // matches the browser's default body margin (sides)
+	const REC_DEFAULTS = ['TheRec-L.PNG', 'TheRec-R.PNG', 'TheRec-Thrown-full.PNG'] as const;
 
 	type Placement = { x: number; y: number };
 
@@ -67,6 +79,7 @@
 	let selectionSeq = 0;
 	let headerH = $state(0);
 	let fitKey = $state(0);
+	let reviewZoomStep = $state(0);
 	let purpleReady = $state<Record<string, boolean>>({});
 	// Thrown-round pre-read (fair use: must finish BEFORE confirmAnnotation
 	// discards the pixels). Keyed by objectUrl; own store so runDetection's
@@ -89,6 +102,18 @@
 	let review = $state<ReviewState | null>(null);
 	let replaceArming = $state<{ holeN: number; anchor: Anchor } | null>(null);
 	let cleanHoles = $state<readonly ReviewHoleState[]>([]);
+	let reviewMarkers = $derived<ReviewMarker[]>(
+		review
+			? review.holes.flatMap((hole) => [
+					...(hole.tee ? [{ id: `${hole.n}:tee`, kind: 'tee' as const, holeN: hole.n, label: `${hole.n}T`, ...hole.tee }] : []),
+					...(hole.basket ? [{ id: `${hole.n}:basket`, kind: 'basket' as const, holeN: hole.n, label: `${hole.n}B`, ...hole.basket }] : []),
+					...hole.bends.map((bend, index) => ({ id: `${hole.n}:bend:${index}`, kind: 'bend' as const, holeN: hole.n, label: `${hole.n}.${index + 1}`, ...bend }))
+				])
+			: []
+	);
+	let reviewBadgePoints = $derived(review?.holes.map((hole) => hole.badge) ?? []);
+	let reviewFocus = $derived(review ? currentHole(review)?.badge ?? null : null);
+	let reviewFocusKey = $derived(phase === 'annotate' && review ? currentHole(review)?.n ?? null : null);
 
 	// DEV-ONLY mock boot: ?mock=<fixture> skips upload/CV/annotation entirely
 	// and drops the Import page straight into the finished 'clean' phase with
@@ -143,9 +168,13 @@
 			purpleReady = { ...purpleReady, [img.objectUrl]: true };
 			considerAutoThrownRound();
 
-			await labEndpointDetector(raster, (e) => emitted.push(e));
+			await labEndpointDetector(raster, (e) => {
+				emitted.push(e);
+				if (seq === selectionSeq) {
+					detections = { ...detections, [img.objectUrl]: emitted.slice() };
+				}
+			});
 			if (seq !== selectionSeq) return;
-			detections = { ...detections, [img.objectUrl]: emitted };
 			const byType: Record<string, number> = {};
 			for (const e of emitted) {
 				const key = e.kind === 'object' ? e.objType : e.kind;
@@ -314,6 +343,7 @@
 	}
 
 	function trySemanticAlign() {
+		if (phase !== 'import') return;
 		if (!alignEnabled) return;
 		if (placementSource !== 'spread') return;
 		if (mapImages.length < 2 || placements.length !== mapImages.length) return;
@@ -606,7 +636,7 @@
 	}
 
 	function onLayerMove(index: number, deltaX: number, deltaY: number) {
-		if (!placements[index]) return;
+		if (phase !== 'import' || !placements[index]) return;
 		placementSource = 'manual';
 		selectedIdx = index;
 		placements = placements.map((placement, placementIndex) =>
@@ -616,6 +646,28 @@
 	}
 
 	function onKeyDown(event: KeyboardEvent) {
+		const target = event.target as HTMLElement | null;
+		if (target?.matches('input, select, textarea, button')) return;
+		if (phase === 'annotate' && review && !replaceArming) {
+			if (event.key === 'Tab') {
+				const hole = currentHole(review);
+				const step = currentStep(review);
+				const canAccept = hole && step && (step === 'tee' ? hole.tee : step === 'basket' ? hole.basket : true);
+				if (canAccept) review = acceptStep(review);
+				else workflowMessage = 'Place the current point, or press X to explicitly skip it.';
+				event.preventDefault();
+			} else if (event.key.toLowerCase() === 'x') {
+				review = skipStep(review);
+				event.preventDefault();
+			} else if (event.key.toLowerCase() === 'q') {
+				reviewZoomStep--;
+				event.preventDefault();
+			} else if (event.key.toLowerCase() === 'e') {
+				reviewZoomStep++;
+				event.preventDefault();
+			}
+			return;
+		}
 		if (!stitchReady || phase !== 'import') return;
 		const numberKey = Number(event.key);
 		if (Number.isInteger(numberKey) && numberKey >= 1 && numberKey <= mapImages.length) {
@@ -636,6 +688,25 @@
 		const input = event.currentTarget as HTMLInputElement;
 		const files = Array.from(input.files ?? []);
 		input.value = '';
+		await loadFiles(files);
+	}
+
+	async function loadRecDefaults() {
+		try {
+			workflowMessage = 'Loading REC demo set…';
+			const files = await Promise.all(REC_DEFAULTS.map(async (name) => {
+				const response = await fetch(`/resources/${name}`);
+				if (!response.ok) throw new Error(`Could not load ${name}`);
+				return new File([await response.blob()], name, { type: 'image/png' });
+			}));
+			clearAll();
+			await loadFiles(files);
+		} catch (reason) {
+			error = reason instanceof Error ? reason.message : 'Could not load the REC demo set.';
+		}
+	}
+
+	async function loadFiles(files: File[]) {
 		if (files.length == 0) return;
 
 		const seq = ++selectionSeq;
@@ -661,6 +732,7 @@
 			}
 		}
 		if (addedAny) {
+			resetDownstreamState();
 			resetStitchState();
 			skipCrop = false;
 			thrownIdx = -1;
@@ -674,7 +746,19 @@
 		error = rejected.length > 0 ? `Not added: ${rejected.join(', ')}` : null;
 	}
 
+	function resetDownstreamState() {
+		resetSession();
+		pairs = [];
+		pairArming = null;
+		pendingBlankPx = null;
+		satMatches = [];
+		satNote = null;
+		if (satRaster) URL.revokeObjectURL(satRaster.url);
+		satRaster = null;
+	}
+
 	function clearAll() {
+		resetDownstreamState();
 		selectionSeq++;
 		resetStitchState();
 		for (const img of images) releaseImage(img);
@@ -700,12 +784,16 @@
 		const left = appliedInsets?.left ?? 0;
 		const top = appliedInsets?.top ?? 0;
 		const seeds: SeedBadge[] = [];
+		const endpoints = new Map<number, { tees: { xPx: number; yPx: number }[]; baskets: { xPx: number; yPx: number }[]; bends: { xPx: number; yPx: number }[] }>();
 		mapImages.forEach((img, i) => {
 			const emitted = detections[img.objectUrl];
 			if (!emitted || !placements[i]) return;
 			const labelByDet = new Map(
 				emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
 			);
+			const objectByDet = new Map(
+				emitted.filter((e) => e.kind === 'object').map((e) => [e.detId, e])
+			);
 			for (const e of emitted) {
 				if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
 				const n = labelByDet.get(e.detId);
@@ -716,6 +804,20 @@
 					yPx: placements[i].y + (e.yPx - top)
 				});
 			}
+			for (const e of emitted) {
+				if (e.kind !== 'association') continue;
+				const badgeDetId = labelByDet.has(e.toDetId) ? e.toDetId : labelByDet.has(e.fromDetId) ? e.fromDetId : null;
+				if (!badgeDetId) continue;
+				const n = labelByDet.get(badgeDetId);
+				const endpoint = objectByDet.get(e.fromDetId === badgeDetId ? e.toDetId : e.fromDetId);
+				if (n === undefined || !endpoint) continue;
+				const group = endpoints.get(n) ?? { tees: [], baskets: [], bends: [] };
+				const point = { xPx: placements[i].x + (endpoint.xPx - left), yPx: placements[i].y + (endpoint.yPx - top) };
+				if (e.relation === 'tee-of' && endpoint.objType === 'tee') group.tees.push(point);
+				else if (e.relation === 'basket-of' && endpoint.objType === 'basket') group.baskets.push(point);
+				else if (e.relation === 'on-path' && endpoint.objType === 'walk-vertex') group.bends.push(point);
+				endpoints.set(n, group);
+			}
 		});
 		// strong-hole verdicts come FROM the CV service; the app only obeys
 		const strongNs = new Set<number>();
@@ -724,22 +826,30 @@
 				if (e.kind === 'strong-hole') strongNs.add(e.n);
 			}
 		}
-		let r = createReview(detectCourse(seeds));
-		for (const n of strongNs) r = accept(r, n);
-		review = r;
+		const meanPoint = (points: readonly { xPx: number; yPx: number }[]) => points.length === 0 ? null : ({
+			xPx: points.reduce((sum, point) => sum + point.xPx, 0) / points.length,
+			yPx: points.reduce((sum, point) => sum + point.yPx, 0) / points.length
+		});
+		const proposals = detectCourse(seeds).map((proposal) => {
+			const found = endpoints.get(proposal.n);
+			return {
+				...proposal,
+				tee: meanPoint(found?.tees ?? []),
+				basket: meanPoint(found?.baskets ?? []),
+				bends: found?.bends ?? []
+			};
+		});
+		review = createReview(proposals);
 		replaceArming = null;
 		layoutApproved = true;
 		phase = 'annotate';
-		const strongNote = strongNs.size > 0 ? ` (${strongNs.size} strong, auto-accepted)` : '';
+		const strongNote = strongNs.size > 0 ? ` (${strongNs.size} high-confidence labels)` : '';
 		workflowMessage =
 			review.holes.length > 0
 				? `Layout approved — GuidedReview: ${review.holes.length} holes${strongNote}.`
 				: 'Layout approved — no labeled badges detected, nothing to review.';
 	}
 
-	function onAccept(holeN: number) {
-		if (review) review = accept(review, holeN);
-	}
 	function onArmReplace(holeN: number, anchor: Anchor) {
 		replaceArming = { holeN, anchor };
 	}
@@ -747,13 +857,97 @@
 		replaceArming = null;
 	}
 	function onCanvasClick(p: { x: number; y: number }) {
-		if (phase !== 'annotate' || !review || !replaceArming) return;
-		review = replace(review, replaceArming.holeN, replaceArming.anchor, { xPx: p.x, yPx: p.y });
+		if (phase !== 'annotate' || !review) return;
+		const hole = currentHole(review);
+		const step = currentStep(review);
+		const placement = replaceArming ?? (hole && step
+			? { holeN: hole.n, anchor: step === 'bends' ? 'bend' : step }
+			: null);
+		if (!placement) return;
+		const point = { xPx: p.x, yPx: p.y };
+		review = placement.anchor === 'tee'
+			? placeTee(review, placement.holeN, point)
+			: placement.anchor === 'basket'
+				? placeBasket(review, placement.holeN, point)
+				: addBend(review, placement.holeN, point);
 		replaceArming = null;
 	}
 
+	function markerParts(id: string): { holeN: number; anchor: Anchor; bendIndex: number } | null {
+		const [holeText, anchorText, bendText] = id.split(':');
+		const holeN = Number(holeText);
+		if (!Number.isInteger(holeN) || !['tee', 'basket', 'bend'].includes(anchorText)) return null;
+		return { holeN, anchor: anchorText as Anchor, bendIndex: Number(bendText ?? 0) };
+	}
+	function onReviewMarkerMove(id: string, point: { xPx: number; yPx: number }) {
+		if (!review) return;
+		const marker = markerParts(id);
+		if (!marker) return;
+		review = marker.anchor === 'tee' ? placeTee(review, marker.holeN, point)
+			: marker.anchor === 'basket' ? placeBasket(review, marker.holeN, point)
+			: moveBend(review, marker.holeN, marker.bendIndex, point);
+	}
+	function onReviewMarkerDelete(id: string) {
+		if (!review) return;
+		const marker = markerParts(id);
+		if (marker) review = removeAnchor(review, marker.holeN, marker.anchor, marker.bendIndex);
+	}
+	function onAcceptPiece() {
+		if (review) review = acceptStep(review);
+	}
+	function onSkipPiece() {
+		if (review) review = skipStep(review);
+	}
+	function onSelectReviewHole(holeN: number) {
+		if (review) review = selectHole(review, holeN);
+		replaceArming = null;
+	}
+	function onReviewMarkerClick(id: string) {
+		const marker = markerParts(id);
+		if (marker) onSelectReviewHole(marker.holeN);
+	}
+	function onReviewMarkerReassign(id: string) {
+		const marker = markerParts(id);
+		if (!marker) return;
+		if (review) review = selectHole(review, marker.holeN);
+		replaceArming = { holeN: marker.holeN, anchor: marker.anchor };
+	}
+	function cancelReview() {
+		review = null;
+		replaceArming = null;
+		layoutApproved = false;
+		phase = 'import';
+		workflowMessage = 'Review cancelled. The stitched source is still available.';
+	}
+	function saveReviewDraft() {
+		if (!review) return;
+		const url = URL.createObjectURL(new Blob([serializeReviewDraft(review)], { type: 'application/json' }));
+		const link = document.createElement('a');
+		link.href = url;
+		link.download = 'chainspot-annotation-draft.json';
+		link.click();
+		URL.revokeObjectURL(url);
+	}
+	async function openReviewDraft(event: Event) {
+		const input = event.currentTarget as HTMLInputElement;
+		const file = input.files?.[0];
+		input.value = '';
+		if (!file) return;
+		try {
+			review = parseReviewDraft(await file.text());
+			replaceArming = null;
+			error = null;
+			workflowMessage = `Opened annotation draft: ${file.name}`;
+		} catch (reason) {
+			error = reason instanceof Error ? reason.message : 'Could not open annotation draft.';
+		}
+	}
+
 	function confirmAnnotation() {
-		if (!review || !review.done) return;
+		if (!review || !isReviewValid(review)) {
+			workflowMessage = 'Every tee, basket, and bend decision must be accepted or explicitly skipped.';
+			return;
+		}
 
 		// Register the thrown round onto the confirmed course BEFORE the pixel
 		// discard: after this function, only vectors exist anywhere.
@@ -960,14 +1154,22 @@
 >
 	<h1 style="margin: 0.25rem 0; font-size: 1.5rem;">Stitch Map</h1>
 	<input type="file" accept="image/*" multiple onchange={onFileChange} />
+	<button onclick={loadRecDefaults}><strong>LOAD REC DEFAULT</strong></button>
 	<button onclick={clearAll}>Clear all</button>
+	{#if phase === 'annotate' && review}
+		<button onclick={saveReviewDraft}>Save annotation draft</button>
+		<label style="border: 1px solid #777; padding: 0.15rem 0.4rem; cursor: pointer;">
+			Open annotation draft
+			<input type="file" accept=".json,application/json" onchange={openReviewDraft} style="display: none;" />
+		</label>
+	{/if}
 	<!-- TEMP DEBUG (remove before merge prep): full-state export for LAB triage -->
 	<button onclick={exportDebug} title="Downloads detections/pre-read/placements as JSON">
 		Export debug JSON
 	</button>
 	{#if error}<span>{error}</span>{/if}
 	{#if workflowMessage}<span>{workflowMessage}</span>{/if}
-	{#if stitchReady && selectedIdx >= 0}
+	{#if phase === 'import' && stitchReady && selectedIdx >= 0}
 		<span>Selected: image {selectedIdx + 1} (number keys select, arrows nudge, drag moves)</span>
 	{/if}
 	{#if layoutApproved}<strong>Layout approved.</strong>{/if}
@@ -1013,6 +1215,15 @@
 		height={`calc(100vh - ${headerH + PAGE_MARGIN_PX * 2 + 2}px)`}
 		{fitKey}
 		{markers}
+		{reviewMarkers}
+		{reviewBadgePoints}
+		{reviewFocus}
+		{reviewFocusKey}
+		{reviewZoomStep}
+		{onReviewMarkerMove}
+		{onReviewMarkerDelete}
+		{onReviewMarkerClick}
+		{onReviewMarkerReassign}
 		animate={vpAnimate}
 		{clipInsets}
 		{clipAnimate}
@@ -1043,13 +1254,15 @@
 			<GuidedReviewPanel
 				{review}
 				{replaceArming}
-				{onAccept}
 				{onArmReplace}
 				{onCancelReplace}
+				onSelectHole={onSelectReviewHole}
+				{onAcceptPiece}
+				{onSkipPiece}
+				onCancelReview={cancelReview}
+				canConfirm={isReviewValid(review)}
 				onConfirmAll={confirmAnnotation}
 			/>
-			<button class="vp-btn" disabled title="Not implemented">Detect bends (this hole)</button>
-			<button class="vp-btn" disabled title="Not implemented">Snap to best point</button>
 		{/if}
 	</ImageViewport>
 {/if}
@@ -1068,8 +1281,8 @@
 	>
 		{#each cleanHoles as h (h.n)}
 			{#if h.tee && h.basket}
-				<path
-					d={`M ${h.tee.xPx} ${h.tee.yPx} ${h.bends.length ? `Q ${h.bends[0].xPx} ${h.bends[0].yPx}` : 'L'} ${h.basket.xPx} ${h.basket.yPx}`}
+				<polyline
+					points={[h.tee, ...h.bends, h.basket].map((point) => `${point.xPx},${point.yPx}`).join(' ')}
 					stroke="#465446"
 					fill="none"
 					stroke-width="4"
```

### B7. `tests/unit/guidedReview.test.ts` — full rewrite

```diff
diff --git a/tests/unit/guidedReview.test.ts b/tests/unit/guidedReview.test.ts
index 712a819..eff2974 100644
--- a/tests/unit/guidedReview.test.ts
+++ b/tests/unit/guidedReview.test.ts
@@ -1,270 +1,144 @@
 import { describe, expect, test } from 'vitest';
 import {
 	accept,
+	acceptStep,
+	addBend,
 	createReview,
-	replace,
 	currentHole,
+	currentStep,
+	isReviewValid,
+	placeBasket,
+	placeTee,
+	replace,
+	skipStep,
 	type HoleProposal,
 	type Point,
-	type ReviewState
+	type ReviewHoleState
 } from '$lib/guidedReview';
 
-// Test fixtures
-function point(xPx: number, yPx: number): Point {
-	return { xPx, yPx };
-}
-
-function holeProposal(
-	n: number,
-	tee: Point | null = null,
-	basket: Point | null = null,
-	bends: readonly Point[] = []
-): HoleProposal {
-	return { n, badge: point(n * 10, n * 10), tee, basket, bends };
-}
+const p = (xPx: number, yPx: number): Point => ({ xPx, yPx });
+const proposal = (n: number, tee: Point | null = null, basket: Point | null = null, bends: readonly Point[] = []): HoleProposal => ({
+	n,
+	badge: p(n * 10, n * 10),
+	tee,
+	basket,
+	bends
+});
 
 describe('guidedReview', () => {
-	test('createReview with empty proposals returns immediately done', () => {
+	test('empty review is done but never valid for confirmation', () => {
 		const state = createReview([]);
-		expect(state.holes).toEqual([]);
-		expect(state.currentIndex).toBe(0);
 		expect(state.done).toBe(true);
+		expect(state.valid).toBe(false);
+		expect(isReviewValid(state)).toBe(false);
+		expect(currentHole(state)).toBe(null);
+		expect(currentStep(state)).toBe(null);
 	});
 
-	test('createReview sorts proposals by n ascending', () => {
-		const proposals = [
-			holeProposal(3, point(1, 2)),
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40))
-		];
-		const state = createReview(proposals);
-
-		expect(state.holes.length).toBe(3);
-		expect(state.holes[0].n).toBe(1);
-		expect(state.holes[1].n).toBe(2);
-		expect(state.holes[2].n).toBe(3);
+	test('sorts holes and starts at tee', () => {
+		const state = createReview([proposal(3), proposal(1), proposal(2)]);
+		expect(state.holes.map((hole) => hole.n)).toEqual([1, 2, 3]);
 		expect(state.currentIndex).toBe(0);
-		expect(state.done).toBe(false);
-	});
-
-	test('createReview initializes holes with status pending and zero replacements', () => {
-		const proposals = [holeProposal(1, point(10, 20), point(50, 60))];
-		const state = createReview(proposals);
-
-		const hole = state.holes[0];
-		expect(hole.status).toBe('pending');
-		expect(hole.replacements).toEqual({ tee: 0, basket: 0, bend: 0 });
+		expect(currentHole(state)?.n).toBe(1);
+		expect(currentStep(state)).toBe('tee');
+	});
+
+	test('placing one anchor never accepts or advances a hole', () => {
+		const state = createReview([proposal(1)]);
+		const placed = placeTee(state, 1, p(10, 20));
+		expect(placed.holes[0].tee).toEqual(p(10, 20));
+		expect(placed.holes[0].status).toBe('pending');
+		expect(placed.currentIndex).toBe(0);
+		expect(placed.currentStep).toBe('tee');
+		expect(placed.done).toBe(false);
+		expect(placed.valid).toBe(false);
+	});
+
+	test('progresses deterministically tee, basket, bends, then next hole', () => {
+		let state = createReview([proposal(1), proposal(2)]);
+		state = placeTee(state, 1, p(1, 1));
+		state = acceptStep(state);
+		expect(state.currentStep).toBe('basket');
+		state = placeBasket(state, 1, p(2, 2));
+		state = acceptStep(state);
+		expect(state.currentStep).toBe('bends');
+		state = addBend(state, 1, p(3, 3));
+		state = addBend(state, 1, p(4, 4));
+		state = acceptStep(state);
+		expect(state.holes[0].bends).toEqual([p(3, 3), p(4, 4)]);
+		expect(state.holes[0].status).toBe('accepted');
+		expect(state.currentIndex).toBe(1);
+		expect(state.currentStep).toBe('tee');
 	});
 
-	test('createReview copies tee/basket/bends from proposal', () => {
-		const tee = point(10, 20);
-		const basket = point(50, 60);
-		const bends = [point(30, 35), point(40, 45)];
-		const proposals = [holeProposal(1, tee, basket, bends)];
-		const state = createReview(proposals);
+	test('accepts a straight hole with zero bends', () => {
+		let state = createReview([proposal(1)]);
+		state = acceptStep(placeTee(state, 1, p(1, 1)));
+		state = acceptStep(placeBasket(state, 1, p(2, 2)));
+		expect(state.currentStep).toBe('bends');
 
-		const hole = state.holes[0];
-		expect(hole.tee).toBe(tee);
-		expect(hole.basket).toBe(basket);
-		expect(hole.bends).toBe(bends);
+		state = acceptStep(state);
+		expect(state.holes[0].bends).toEqual([]);
+		expect(state.done).toBe(true);
+		expect(isReviewValid(state)).toBe(true);
 	});
 
-	test('accept on unknown holeN returns same state reference', () => {
-		const state = createReview([holeProposal(1, point(10, 20))]);
-		const result = accept(state, 999);
-
-		expect(result).toBe(state);
+	test('skipping is explicit and can complete a deliberately partial review', () => {
+		let state = createReview([proposal(1)]);
+		state = skipStep(state);
+		expect(state.currentStep).toBe('basket');
+		state = skipStep(state);
+		expect(state.currentStep).toBe('bends');
+		state = skipStep(state);
+		expect(state.done).toBe(true);
+		expect(state.valid).toBe(true);
+		expect(isReviewValid(state)).toBe(true);
+		expect(state.holes[0].stepStatus).toEqual({ tee: 'skipped', basket: 'skipped', bends: 'skipped' });
+	});
+
+	test('replace keeps multiple ordered bends and does not accept the hole', () => {
+		let state = createReview([proposal(1, null, null, [p(1, 1), p(2, 2)])]);
+		state = replace(state, 1, 'bend', p(9, 9));
+		expect(state.holes[0].bends).toEqual([p(9, 9), p(2, 2)]);
+		expect(state.holes[0].status).toBe('pending');
+		expect(state.holes[0].replacements.bend).toBe(1);
+	});
+
+	test('placing tee and basket increments replacement counters without accepting', () => {
+		let state = createReview([proposal(1)]);
+		state = placeTee(state, 1, p(1, 1));
+		state = placeBasket(state, 1, p(2, 2));
+		expect(state.holes[0].replacements).toEqual({ tee: 1, basket: 1, bend: 0 });
+		expect(state.holes[0].status).toBe('pending');
+	});
+
+	test('accepted fixture holes load as completed and remain compatible', () => {
+		const fixture: ReviewHoleState = {
+			n: 7,
+			badge: p(5, 5),
+			tee: p(1, 1),
+			basket: p(9, 9),
+			bends: [p(4, 4), p(6, 6)],
+			status: 'accepted',
+			replacements: { tee: 0, basket: 0, bend: 0 }
+		};
+		const state = createReview([fixture]);
+		expect(state.done).toBe(true);
+		expect(state.valid).toBe(true);
+		expect(state.holes[0].bends).toEqual(fixture.bends);
 	});
 
-	test('accept on already accepted hole returns same state reference', () => {
-		const state = createReview([holeProposal(1, point(10, 20))]);
+	test('legacy accept remains an explicit whole-hole compatibility action', () => {
+		const state = createReview([proposal(1)]);
 		const accepted = accept(state, 1);
-		const result = accept(accepted, 1);
-
-		expect(result).toBe(accepted);
-	});
-
-	test('accept changes target hole to accepted and preserves object references for others', () => {
-		const state = createReview([
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40)),
-			holeProposal(3, point(50, 60))
-		]);
-
-		const result = accept(state, 1);
-
-		expect(result.holes[0].status).toBe('accepted');
-		expect(result.holes[1]).toBe(state.holes[1]); // Object reference preserved
-		expect(result.holes[2]).toBe(state.holes[2]); // Object reference preserved
-	});
-
-	test('accept advances currentIndex to next pending hole', () => {
-		const state = createReview([
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40)),
-			holeProposal(3, point(50, 60))
-		]);
-
-		const step1 = accept(state, 1);
-		expect(step1.currentIndex).toBe(1);
-		expect(step1.done).toBe(false);
-
-		const step2 = accept(step1, 2);
-		expect(step2.currentIndex).toBe(2);
-		expect(step2.done).toBe(false);
-
-		const step3 = accept(step2, 3);
-		expect(step3.currentIndex).toBe(3);
-		expect(step3.done).toBe(true);
-	});
-
-	test('accept all holes in order drives done:true', () => {
-		const state = createReview([
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40)),
-			holeProposal(3, point(50, 60))
-		]);
-
-		const step1 = accept(state, 1);
-		const step2 = accept(step1, 2);
-		const step3 = accept(step2, 3);
-
-		expect(step3.currentIndex).toBe(3);
-		expect(step3.holes.length).toBe(3);
-		expect(step3.done).toBe(true);
-	});
-
-	test('replace on unknown holeN returns state unchanged', () => {
-		const state = createReview([holeProposal(1, point(10, 20))]);
-		const result = replace(state, 999, 'tee', point(100, 100));
-
-		expect(result).toBe(state);
-	});
-
-	test('replace on tee updates tee and increments replacements.tee', () => {
-		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);
-		const newPoint = point(100, 100);
-
-		const result = replace(state, 1, 'tee', newPoint);
-
-		expect(result.holes[0].tee).toBe(newPoint);
-		expect(result.holes[0].replacements.tee).toBe(1);
-		expect(result.holes[0].status).toBe('accepted');
-	});
-
-	test('replace on basket updates basket and increments replacements.basket', () => {
-		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);
-		const newPoint = point(100, 100);
-
-		const result = replace(state, 1, 'basket', newPoint);
-
-		expect(result.holes[0].basket).toBe(newPoint);
-		expect(result.holes[0].replacements.basket).toBe(1);
-		expect(result.holes[0].status).toBe('accepted');
-	});
-
-	test('replace on bend updates bends to single-element array and increments replacements.bend', () => {
-		const state = createReview([holeProposal(1, point(10, 20), point(50, 60), [point(30, 35)])]);
-		const newPoint = point(100, 100);
-
-		const result = replace(state, 1, 'bend', newPoint);
-
-		expect(result.holes[0].bends).toEqual([newPoint]);
-		expect(result.holes[0].replacements.bend).toBe(1);
-		expect(result.holes[0].status).toBe('accepted');
+		expect(accepted.done).toBe(true);
+		expect(accepted.valid).toBe(true);
+		expect(accepted.holes[0].status).toBe('accepted');
 	});
 
-	test('replace accumulates replacement counters', () => {
-		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);
-
-		const step1 = replace(state, 1, 'tee', point(100, 100));
-		expect(step1.holes[0].replacements.tee).toBe(1);
-
-		const step2 = replace(step1, 1, 'tee', point(200, 200));
-		expect(step2.holes[0].replacements.tee).toBe(2);
-	});
-
-	test('replace sets status to accepted and advances queue if hole is current', () => {
-		const state = createReview([
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40)),
-			holeProposal(3, point(50, 60))
-		]);
-
-		const result = replace(state, 1, 'tee', point(100, 100));
-
-		expect(result.holes[0].status).toBe('accepted');
-		expect(result.currentIndex).toBe(1);
-		expect(result.done).toBe(false);
-	});
-
-	test('currentHole returns null when state is done', () => {
-		const state = createReview([]);
-		const hole = currentHole(state);
-
-		expect(hole).toBe(null);
-	});
-
-	test('currentHole returns current pending hole', () => {
-		const state = createReview([
-			holeProposal(1, point(10, 20)),
-			holeProposal(2, point(30, 40)),
-			holeProposal(3, point(50, 60))
-		]);
-
-		const hole1 = currentHole(state);
-		expect(hole1?.n).toBe(1);
-
-		const step1 = accept(state, 1);
-		const hole2 = currentHole(step1);
-		expect(hole2?.n).toBe(2);
-	});
-
-	test('end-to-end: full review with mixed accept and replace', () => {
-		// Build a 5-hole fixture
-		const proposals = [
-			holeProposal(1, point(45, 250), point(95, 95), [point(60, 170)]),
-			holeProposal(2, point(115, 85), point(155, 235), [point(135, 160)]),
-			holeProposal(3, point(560, 35), point(330, 95), [point(262, 180)]), // flawed tee
-			holeProposal(4, point(355, 65), point(470, 155), [point(432, 82)]),
-			holeProposal(5, point(430, 250), point(560, 165), [point(350, 265)])  // flawed bend
-		];
-
-		let state = createReview(proposals);
-
-		// accept(1)
-		state = accept(state, 1);
-		expect(state.holes[0].status).toBe('accepted');
-		expect(state.currentIndex).toBe(1);
-
-		// accept(2)
-		state = accept(state, 2);
-		expect(state.holes[1].status).toBe('accepted');
-		expect(state.currentIndex).toBe(2);
-
-		// replace(3, 'tee', p) — hole 3's tee was wrong, replace it
-		state = replace(state, 3, 'tee', point(225, 235));
-		expect(state.holes[2].tee).toEqual(point(225, 235));
-		expect(state.holes[2].status).toBe('accepted');
-		expect(state.holes[2].replacements.tee).toBe(1);
-		expect(state.currentIndex).toBe(3);
-
-		// accept(4)
-		state = accept(state, 4);
-		expect(state.holes[3].status).toBe('accepted');
-		expect(state.currentIndex).toBe(4);
-
-		// replace(5, 'bend', p) — hole 5's bend was wrong, replace it
-		state = replace(state, 5, 'bend', point(492, 232));
-		expect(state.holes[4].bends).toEqual([point(492, 232)]);
-		expect(state.holes[4].status).toBe('accepted');
-		expect(state.holes[4].replacements.bend).toBe(1);
-		expect(state.currentIndex).toBe(5);
-
-		// Verify final state is done with all holes accepted
-		expect(state.done).toBe(true);
-		for (const hole of state.holes) {
-			expect(hole.status).toBe('accepted');
-		}
+	test('unknown holes are no-ops', () => {
+		const state = createReview([proposal(1)]);
+		expect(replace(state, 99, 'tee', p(1, 1))).toBe(state);
+		expect(accept(state, 99)).toBe(state);
 	});
 });
```

### B8. Untracked new source: `src/lib/components/reviewMarker.ts`

```ts
export type ReviewMarkerKind = 'tee' | 'basket' | 'bend';

/** A review point in the stitched/composite original pixel space. */
export interface ReviewMarker {
	readonly id: string;
	readonly kind: ReviewMarkerKind;
	readonly xPx: number;
	readonly yPx: number;
	readonly holeN?: number;
	readonly label?: string;
	readonly title?: string;
	readonly color?: string;
}

export interface ReviewMarkerPoint {
	readonly xPx: number;
	readonly yPx: number;
}
```

### B9. Untracked new source: `src/lib/reviewDraft.ts`

The validator. Worth regenerating in full — it encodes the review state
machine's invariants as checkable assertions, which is the "make behavior
checkable, not just requested" principle applied to a file format.

```ts
import type { Point, ReviewHoleState, ReviewState, ReviewStep, ReviewStepState } from '$lib/guidedReview';

const SCHEMA_VERSION = 1;

export interface ReviewDraft {
	readonly schemaVersion: 1;
	readonly review: ReviewState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function readPoint(value: unknown, path: string): Point {
	if (!isRecord(value) || !isFiniteNumber(value.xPx) || !isFiniteNumber(value.yPx)) {
		throw new Error(`Invalid review draft: ${path} must be a finite point`);
	}
	return { xPx: value.xPx, yPx: value.yPx };
}

function readHole(value: unknown, index: number): ReviewHoleState {
	const path = `review.holes[${index}]`;
	if (!isRecord(value)) throw new Error(`Invalid review draft: ${path} must be an object`);
	if (!Number.isInteger(value.n) || (value.n as number) < 1) {
		throw new Error(`Invalid review draft: ${path}.n must be a positive integer`);
	}
	if (value.status !== 'pending' && value.status !== 'accepted') {
		throw new Error(`Invalid review draft: ${path}.status is invalid`);
	}
	if (!isRecord(value.replacements)) {
		throw new Error(`Invalid review draft: ${path}.replacements must be an object`);
	}
	const replacementKeys = ['tee', 'basket', 'bend'] as const;
	for (const key of replacementKeys) {
		const count = value.replacements[key];
		if (!Number.isInteger(count) || (count as number) < 0) {
			throw new Error(`Invalid review draft: ${path}.replacements.${key} is invalid`);
		}
	}
	if (!Array.isArray(value.bends)) {
		throw new Error(`Invalid review draft: ${path}.bends must be an array`);
	}
	let stepStatus: ReviewStepState | undefined;
	if (value.stepStatus !== undefined) {
		if (!isRecord(value.stepStatus)) throw new Error(`Invalid review draft: ${path}.stepStatus is invalid`);
		for (const key of ['tee', 'basket', 'bends'] as const) {
			if (!['pending', 'accepted', 'skipped'].includes(value.stepStatus[key] as string)) {
				throw new Error(`Invalid review draft: ${path}.stepStatus.${key} is invalid`);
			}
		}
		stepStatus = value.stepStatus as unknown as ReviewStepState;
	}
	return {
		n: value.n as number,
		badge: readPoint(value.badge, `${path}.badge`),
		tee: value.tee === null ? null : readPoint(value.tee, `${path}.tee`),
		basket: value.basket === null ? null : readPoint(value.basket, `${path}.basket`),
		bends: value.bends.map((bend, bendIndex) => readPoint(bend, `${path}.bends[${bendIndex}]`)),
		status: value.status,
		stepStatus,
		replacements: {
			tee: value.replacements.tee as number,
			basket: value.replacements.basket as number,
			bend: value.replacements.bend as number
		}
	};
}

function readReview(value: unknown): ReviewState {
	if (!isRecord(value) || !Array.isArray(value.holes)) {
		throw new Error('Invalid review draft: review.holes must be an array');
	}
	if (!Number.isInteger(value.currentIndex) || (value.currentIndex as number) < 0 || (value.currentIndex as number) > value.holes.length) {
		throw new Error('Invalid review draft: review.currentIndex is out of range');
	}
	if (typeof value.done !== 'boolean') {
		throw new Error('Invalid review draft: review.done must be boolean');
	}
	if (value.currentStep !== undefined && value.currentStep !== null && !['tee', 'basket', 'bends'].includes(value.currentStep as string)) {
		throw new Error('Invalid review draft: review.currentStep is invalid');
	}
	if (value.valid !== undefined && typeof value.valid !== 'boolean') {
		throw new Error('Invalid review draft: review.valid must be boolean');
	}
	const holes = value.holes.map(readHole);
	const numbers = new Set<number>();
	for (const hole of holes) {
		if (numbers.has(hole.n)) throw new Error(`Invalid review draft: duplicate hole ${hole.n}`);
		numbers.add(hole.n);
		if (hole.stepStatus) {
			const hasPending = Object.values(hole.stepStatus).includes('pending');
			if ((hole.status === 'accepted') === hasPending) {
				throw new Error(`Invalid review draft: hole ${hole.n} status conflicts with stepStatus`);
			}
		}
	}
	const currentIndex = value.currentIndex as number;
	const anyPending = holes.some((hole) => hole.status === 'pending');
	if (value.done !== !anyPending || (value.done ? currentIndex !== holes.length : holes[currentIndex]?.status !== 'pending')) {
		throw new Error('Invalid review draft: review queue state is inconsistent');
	}
	const selectedSteps = holes[currentIndex]?.stepStatus;
	const expectedStep = selectedSteps
		? (['tee', 'basket', 'bends'] as const).find((step) => selectedSteps[step] === 'pending') ?? null
		: value.done ? null : undefined;
	if (value.currentStep !== undefined && value.currentStep !== expectedStep) {
		throw new Error('Invalid review draft: review.currentStep is inconsistent');
	}
	return {
		holes,
		currentIndex: value.currentIndex as number,
		currentStep: expectedStep as ReviewStep | null | undefined,
		done: value.done,
		valid: value.valid as boolean | undefined
	};
}

/** Serialize review geometry without retaining references to live state. */
export function serializeReviewDraft(review: ReviewState): string {
	return JSON.stringify({ schemaVersion: SCHEMA_VERSION, review } satisfies ReviewDraft);
}

/** Parse and validate a draft. Throws before returning; never mutates caller state. */
export function parseReviewDraft(input: string): ReviewState {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error('Invalid review draft: malformed JSON');
	}
	if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
		throw new Error('Invalid review draft: unsupported schema version');
	}
	return readReview(value.review);
}
```

### B10. Untracked new test: `tests/unit/reviewDraftPersistence.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { parseReviewDraft, serializeReviewDraft } from '$lib/reviewDraft';
import type { ReviewState } from '$lib/guidedReview';

const review: ReviewState = {
	holes: [
		{
			n: 1,
			badge: { xPx: 10, yPx: 20 },
			tee: { xPx: 1, yPx: 2 },
			basket: null,
			bends: [{ xPx: 4, yPx: 5 }],
			status: 'pending',
			replacements: { tee: 1, basket: 0, bend: 0 }
		},
		{
			n: 2,
			badge: { xPx: 30, yPx: 40 },
			tee: null,
			basket: { xPx: 31, yPx: 42 },
			bends: [],
			status: 'accepted',
			replacements: { tee: 0, basket: 0, bend: 0 }
		}
	],
	currentIndex: 0,
	done: false
};

describe('reviewDraft persistence', () => {
	test('round-trips annotation geometry', () => {
		const parsed = parseReviewDraft(serializeReviewDraft(review));
		expect(parsed).toEqual(review);
		expect(parsed).not.toBe(review);
		expect(parsed.holes[0]).not.toBe(review.holes[0]);
	});

	test.each(['{', '{"schemaVersion":1}', '{"schemaVersion":2,"review":{}}'])('rejects corrupt or invalid draft %s', (input) => {
		expect(() => parseReviewDraft(input)).toThrow(/Invalid review draft/);
	});

	test('rejects inconsistent queue state without mutating an input object', () => {
		const source = JSON.stringify({ schemaVersion: 1, review: { ...review, currentIndex: 1 } });
		const before = source;
		expect(() => parseReviewDraft(source)).toThrow(/queue state/);
		expect(source).toBe(before);
	});

	test('preserves per-step decisions and rejects accepted holes with pending steps', () => {
		const stepped: ReviewState = {
			...review,
			currentStep: 'basket',
			holes: review.holes.map((hole, index) => index === 0
				? { ...hole, stepStatus: { tee: 'skipped', basket: 'pending', bends: 'accepted' } }
				: hole)
		};
		expect(parseReviewDraft(serializeReviewDraft(stepped))).toEqual(stepped);

		const corrupt = JSON.parse(serializeReviewDraft(stepped));
		corrupt.review.holes[0].status = 'accepted';
		expect(() => parseReviewDraft(JSON.stringify(corrupt))).toThrow(/status conflicts/);
	});
});
```

### B11. Untracked new test: `tests/unit/sessionReset.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { getCourseMap, getMappedRound, resetSession, setCourseMap, setMappedRound } from '$lib/session';

describe('session reset', () => {
	test('clears both cross-page artifacts', () => {
		setCourseMap({ holes: [], transform: null });
		setMappedRound({ walk: [{ xPx: 1, yPx: 2 }], droplets: [] });
		resetSession();
		expect(getCourseMap()).toBeNull();
		expect(getMappedRound()).toBeNull();
	});
});
```

### B12. Untracked: `tests/unit/mapRoundConnectedControls.test.ts`

Recorded for completeness. **Do not rebuild this** — it is a regex over source
text, not a behavioral test.

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('Map Round connected controls', () => {
	test('does not advertise unimplemented actions', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/routes/map-round/+page.svelte'), 'utf8');
		expect(source).not.toMatch(/disabled|Not implemented|Create Graphics|Project round|Re-run projection|Per-hole corrections/);
		expect(source).toContain('Back to Import');
	});
});
```

---

## C. `ChainSpot-clickfix-ab` (branch `codex/ab-local-snap-clickfix`, HEAD `ebbc61d`)

```
 src/lib/autoAnnotation/basketDetection.ts        |  9 +++--
 src/lib/autoAnnotation/basketDetection.worker.ts | 11 ++++--
 src/lib/components/AnnotationWorkspace.svelte    | 19 ++++++++--
 src/lib/cv/localSnap.ts                          | 46 +++++++++++++++++-------
 tests/unit/localSnap.test.ts                     | 29 +++++++++++++--
 5 files changed, 94 insertions(+), 20 deletions(-)
```

```diff
diff --git a/src/lib/autoAnnotation/basketDetection.ts b/src/lib/autoAnnotation/basketDetection.ts
index aaf8f7e..96ea2da 100644
--- a/src/lib/autoAnnotation/basketDetection.ts
+++ b/src/lib/autoAnnotation/basketDetection.ts
@@ -17,7 +17,8 @@ import type {
 	TeePadVariant,
 	TeePadVariantResult
 } from './teePadDetection';
-import type { LocalSnapKind, LocalSnapPoint } from '../cv/localSnap';
+import { DEFAULT_LOCAL_SNAP_EXPERIMENT } from '../cv/localSnap';
+import type { LocalSnapExperiment, LocalSnapKind, LocalSnapPoint } from '../cv/localSnap';
 import type { RawObjectMaskResult } from './rawObjectMask';
 import type { HoleNumberDetection } from './holeNumberDetection';
 import type { P3OwnershipResult } from './rawObjectOwnership';
@@ -229,6 +230,7 @@ interface LocalSnapWorkerRequest {
 	readonly snapKind: LocalSnapKind;
 	readonly clickPx: LocalSnapPoint;
 	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
+	readonly experiment: LocalSnapExperiment;
 }
 
 type BasketWorkerRequest =
@@ -708,6 +710,8 @@ export interface LocalSnapRequestOptions {
 	readonly clickPx: LocalSnapPoint;
 	/** The same number-badge anchor `detectCourse`'s result already carries (`courseDetection.numberDetection.anchor`); the worker re-derives `UiScalePx`/`BasketTemplateScale` from it itself. */
 	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
+	/** Default/OFF is the historical crop-wide rank; ClickFix is an explicit request-scoped opt-in. */
+	readonly experiment?: LocalSnapExperiment;
 }
 
 /**
@@ -738,7 +742,8 @@ export async function requestLocalSnap(
 				bitmap,
 				snapKind: options.kind,
 				clickPx: options.clickPx,
-				numberAnchor: options.numberAnchor
+				numberAnchor: options.numberAnchor,
+				experiment: options.experiment ?? DEFAULT_LOCAL_SNAP_EXPERIMENT
 			},
 			[bitmap as unknown as Transferable]
 		);
diff --git a/src/lib/autoAnnotation/basketDetection.worker.ts b/src/lib/autoAnnotation/basketDetection.worker.ts
index 8dc1c03..fb0b43a 100644
--- a/src/lib/autoAnnotation/basketDetection.worker.ts
+++ b/src/lib/autoAnnotation/basketDetection.worker.ts
@@ -44,7 +44,13 @@ import type {
 	UiScalePx
 } from './cvCalibration';
 import { localFeatureSnap } from '../cv/localSnap';
-import type { LocalSnapCalibration, LocalSnapKind, LocalSnapPoint, LocalSnapRaster } from '../cv/localSnap';
+import type {
+	LocalSnapCalibration,
+	LocalSnapExperiment,
+	LocalSnapKind,
+	LocalSnapPoint,
+	LocalSnapRaster
+} from '../cv/localSnap';
 import { detectRawObjectMask } from './rawObjectMask';
 import { deriveP3Ownership } from './rawObjectOwnership';
 import { deriveP4RibbonOwnership } from './p4RibbonOwnership';
@@ -115,6 +121,7 @@ interface LocalSnapRequest {
 	readonly snapKind: LocalSnapKind;
 	readonly clickPx: LocalSnapPoint;
 	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
+	readonly experiment: LocalSnapExperiment;
 }
 
 type BasketRequest =
@@ -475,7 +482,7 @@ async function detectLocalSnap(request: LocalSnapRequest): Promise<LocalSnapPoin
 				}
 			: { uiScalePx: calibration.uiScalePx };
 
-	return localFeatureSnap(request.snapKind, cv, raster, request.clickPx, localSnapCalibration);
+	return localFeatureSnap(request.snapKind, cv, raster, request.clickPx, localSnapCalibration, request.experiment);
 }
 
 function reportCourseProgress(
diff --git a/src/lib/components/AnnotationWorkspace.svelte b/src/lib/components/AnnotationWorkspace.svelte
index bc6ed8b..4cc979c 100644
--- a/src/lib/components/AnnotationWorkspace.svelte
+++ b/src/lib/components/AnnotationWorkspace.svelte
@@ -96,7 +96,11 @@
 		IMG_5641_GROUND_TRUTH,
 		mergeCourseGroundTruth
 	} from '$lib/autoAnnotation/courseGroundTruth';
-	import type { LocalSnapKind } from '$lib/cv/localSnap';
+	import {
+		DEFAULT_LOCAL_SNAP_EXPERIMENT,
+		localSnapExperimentFromSearchParams,
+		type LocalSnapKind
+	} from '$lib/cv/localSnap';
 	import { acceptCandidate } from '$lib/cv/types';
 	import { runRibbonMassShadowPass } from '$lib/autoAnnotation/ribbonMassShadow';
 	import {
@@ -2355,6 +2359,12 @@
 		return anchor ? { scale: anchor.scale, widthPx: anchor.widthPx, heightPx: anchor.heightPx } : null;
 	}
 
+	/** Default/OFF is safe for every normal annotation URL; `?localSnapClickFix=1` opts this one request into ClickFix. */
+	function currentLocalSnapExperiment() {
+		if (typeof window === 'undefined') return DEFAULT_LOCAL_SNAP_EXPERIMENT;
+		return localSnapExperimentFromSearchParams(new URLSearchParams(window.location.search));
+	}
+
 	/** What courseGrammar itself proposed for this hole/endpoint right now, per the correction log's schema (`$lib/correctionLog`). */
 	function derivePriorProposal(endpoint: CorrectionEndpoint, holeNumber: number) {
 		return deriveProposalFromGrammar(courseDetection?.grammar ?? null, holeNumber, endpoint);
@@ -2525,7 +2535,12 @@
 		const key = localSnapKey(kind, holeId);
 		pendingLocalSnaps.set(key, requestId);
 
-		requestLocalSnap(resource.bytes, image.mimeType, { kind, clickPx: rawPoint, numberAnchor: anchor })
+		requestLocalSnap(resource.bytes, image.mimeType, {
+			kind,
+			clickPx: rawPoint,
+			numberAnchor: anchor,
+			experiment: currentLocalSnapExperiment()
+		})
 			.then((snapped) => {
 				if (!snapped) {
 					flushCorrectionForSnap(key, requestId, null);
diff --git a/src/lib/cv/localSnap.ts b/src/lib/cv/localSnap.ts
index 4f66c76..a2133c5 100644
--- a/src/lib/cv/localSnap.ts
+++ b/src/lib/cv/localSnap.ts
@@ -68,6 +68,27 @@ import type { BasketCv, BasketRaster, BasketTemplateRaster } from '../autoAnnota
 
 export type LocalSnapKind = 'tee' | 'basket';
 
+/**
+ * A small, explicit A/B control for local marker snapping.  OFF deliberately
+ * preserves the crop-wide ranking that preceded `4da01f`; ON applies that
+ * commit's radius-first ClickFix.  It is request-scoped rather than persisted
+ * with an annotation, so an experiment cannot change saved course geometry.
+ */
+export interface LocalSnapExperiment {
+	readonly clickFix: boolean;
+}
+
+export const DEFAULT_LOCAL_SNAP_EXPERIMENT: LocalSnapExperiment = { clickFix: false };
+export const CLICKFIX_LOCAL_SNAP_EXPERIMENT: LocalSnapExperiment = { clickFix: true };
+export const LOCAL_SNAP_CLICKFIX_QUERY_PARAMETER = 'localSnapClickFix';
+
+/** `?localSnapClickFix=1` is the opt-in browser arm; every other value is control/OFF. */
+export function localSnapExperimentFromSearchParams(searchParams: URLSearchParams): LocalSnapExperiment {
+	return searchParams.get(LOCAL_SNAP_CLICKFIX_QUERY_PARAMETER) === '1'
+		? CLICKFIX_LOCAL_SNAP_EXPERIMENT
+		: DEFAULT_LOCAL_SNAP_EXPERIMENT;
+}
+
 /** A source-image-pixel point; deliberately structural (matches `SourcePoint`/`Candidate`) so callers never need an import just to build one. */
 export interface LocalSnapPoint {
 	readonly xPx: number;
@@ -291,13 +312,20 @@ function basketCropCandidates(
  * `LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX` of `clickPx` -- a real nearby feature
  * close enough to be an obvious correction of the user's own click, not just
  * the least-bad thing the detector could find inside an arbitrary window.
+ *
+ * Default/OFF ranks the complete crop, then rejects an out-of-radius winner
+ * exactly as the pre-ClickFix behavior did.  `experiment.clickFix` changes
+ * only selection order: it rejects outside-radius candidates before ranking,
+ * exactly as `4da01f` did.  The score floor, crop, calibration, coordinates,
+ * and radius remain identical in both arms.
  */
 export function localFeatureSnap(
 	kind: LocalSnapKind,
 	cv: LocalSnapCv,
 	raster: LocalSnapRaster,
 	clickPx: LocalSnapPoint,
-	calibration: LocalSnapCalibration
+	calibration: LocalSnapCalibration,
+	experiment: LocalSnapExperiment = DEFAULT_LOCAL_SNAP_EXPERIMENT
 ): LocalSnapPoint | null {
 	if (!Number.isFinite(clickPx.xPx) || !Number.isFinite(clickPx.yPx)) return null;
 	if (!(calibration.uiScalePx > 0)) return null;
@@ -322,27 +350,21 @@ export function localFeatureSnap(
 			: basketCropCandidates(cv, raster, bounds, calibration);
 	if (!candidates || candidates.length === 0) return null;
 
-	// Rank only candidates within the snap radius. The crop is deliberately
-	// wider than the accept radius (so nearby false positives are visible and
-	// can be *rejected*), which means a neighboring feature can outscore the
-	// one actually under the click; ranking the whole crop first and
-	// radius-testing the single winner turned those clicks into no-ops even
-	// though an acceptable in-radius candidate existed. Corpus profiling
-	// (samuelpmahan/toph, examples/chainspot-clicksnap-profile) measured that
-	// in every such rejection the in-radius runner-up was the real feature,
-	// and shipping this ranking moved corpus-wide snap rates from 0.778 to
-	// 0.838 (tee) and 0.796 to 0.968 (basket) with median accuracy unchanged.
+	const radiusFirst = experiment.clickFix;
 	let best: { xPx: number; yPx: number; score: number } | null = null;
 	for (const candidate of candidates) {
 		const score = candidate.score ?? -Infinity;
 		const xPx = originXPx + candidate.xPx;
 		const yPx = originYPx + candidate.yPx;
-		if (Math.hypot(xPx - clickPx.xPx, yPx - clickPx.yPx) > snapRadiusPx) continue;
+		if (radiusFirst && Math.hypot(xPx - clickPx.xPx, yPx - clickPx.yPx) > snapRadiusPx) continue;
 		if (!best || score > best.score) {
 			best = { xPx, yPx, score };
 		}
 	}
 	if (!best || best.score < LOCAL_SNAP_MIN_SCORE) return null;
+	if (!radiusFirst && Math.hypot(best.xPx - clickPx.xPx, best.yPx - clickPx.yPx) > snapRadiusPx) {
+		return null;
+	}
 
 	return { xPx: best.xPx, yPx: best.yPx };
 }
diff --git a/tests/unit/localSnap.test.ts b/tests/unit/localSnap.test.ts
index 5668ca6..77eeb82 100644
--- a/tests/unit/localSnap.test.ts
+++ b/tests/unit/localSnap.test.ts
@@ -1,6 +1,9 @@
 import { describe, expect, it } from 'vitest';
 import {
+	CLICKFIX_LOCAL_SNAP_EXPERIMENT,
+	DEFAULT_LOCAL_SNAP_EXPERIMENT,
 	localFeatureSnap,
+	localSnapExperimentFromSearchParams,
 	LOCAL_SNAP_CROP_FEATURE_MULTIPLE,
 	LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE,
 	LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX,
@@ -12,6 +15,18 @@ import { asBasketTemplateScale, asUiScalePx } from '../../src/lib/autoAnnotation
 import type { TeePadCv } from '../../src/lib/autoAnnotation/teePadDetection';
 import type { BasketCv } from '../../src/lib/autoAnnotation/basketTemplateDetection';
 
+describe('local snap ClickFix experiment', () => {
+	it('is OFF by default and enables only with its explicit query value', () => {
+		expect(localSnapExperimentFromSearchParams(new URLSearchParams())).toEqual(DEFAULT_LOCAL_SNAP_EXPERIMENT);
+		expect(localSnapExperimentFromSearchParams(new URLSearchParams('localSnapClickFix=0'))).toEqual(
+			DEFAULT_LOCAL_SNAP_EXPERIMENT
+		);
+		expect(localSnapExperimentFromSearchParams(new URLSearchParams('localSnapClickFix=1'))).toEqual(
+			CLICKFIX_LOCAL_SNAP_EXPERIMENT
+		);
+	});
+});
+
 /**
  * A minimal fake tee-pad `cv`: the first `findContours` call (the
  * gray-center pass, which runs first in `detectTeePadCandidates`) reports one
@@ -371,7 +386,7 @@ describe('localFeatureSnap — basket', () => {
 		expect(result).toBeNull();
 	});
 
-	it('prefers an in-radius candidate over a higher-scoring one outside the radius', () => {
+	it('keeps the crop-wide historical result OFF and uses radius-first ranking only ON', () => {
 		const raster = basketRaster();
 		const clickPx = { xPx: 200, yPx: 200 };
 		// Same near-click peak geometry as the accept test above (lands ~on the
@@ -390,7 +405,17 @@ describe('localFeatureSnap — basket', () => {
 			165
 		);
 
-		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);
+		const control = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);
+		expect(control).toBeNull();
+
+		const result = localFeatureSnap(
+			'basket',
+			cv as unknown as LocalSnapCv,
+			raster,
+			clickPx,
+			BASKET_CALIBRATION,
+			CLICKFIX_LOCAL_SNAP_EXPERIMENT
+		);
 
 		expect(result).not.toBeNull();
 		expect(Math.hypot(result!.xPx - clickPx.xPx, result!.yPx - clickPx.yPx)).toBeLessThanOrEqual(
```
