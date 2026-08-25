# engine/dev72 lineage (integration/claude-t1-t6 + lab/dev72-algorithm)

## Source

Read-only extraction from `C:/Users/tenni/workspace/ChainSpot` (OLD layout) on
2026-08-25. Working tree was **clean** — every commit below is committed, none
is dirty-only. `HEAD` was on `main`; none of the three branches was checked out.

**All three branches are entirely unpushed.** `git branch -r --contains` returns
nothing for all three tips. The shared pushed ancestor is:

| | |
|---|---|
| `1141835` | `CHSPT-82: lab sweep CLI working core (salvaged) + T6 Codex handoff`, Sun 2026-08-23 20:20:36 -0500, Samuel Mahan |

`1141835` **is** pushed — it lives on `origin/codex/c-sweep-completion`,
`origin/codex/lab-scope-v0`, `origin/codex/lab-ui-hardening`,
`origin/lab/abf-hardening`, and
`origin/samuelpmahan/chspt-82-frontend-rebuild-rederive-the-mvp-from-a-clean-room-app`.
Everything after it in this lineage exists on one disk only.

Counts confirmed against `1141835`:

| branch | tip | commits after 1141835 |
|---|---|---|
| `engine/dev72` | `6c1ce4e` | 13 |
| `integration/claude-t1-t6` | `0615c93` | 12 |
| `lab/dev72-algorithm` | `eb5be4d` | 6 |

Topic branches (all six forked directly off `1141835`, none off each other
except T1's second commit):

| lane | commits | subject |
|---|---|---|
| T1 | `32bec03`, `f91939d` | deterministic artifact renderers; scan scalar extrema without spread |
| T2 | `bf03e64` | isolate clean basket tuning evidence |
| T3 | `6e85ea9` | audit Heritage G3 tee misses |
| T4 | `aab4383` | add threeFactor experiment layer |
| T5 | `c974690` | add browser receipt viewer |
| T6 | `34c2cfc` | complete canonical lab sweep |

`integration/claude-t1-t6` = `1141835` + T1 (fast-forward) + merges of T2
(`4a5930b`), T3 (`3c125f1`), T4 (`bab95ce`), T5 (`1a6767a`), T6 (`0615c93`).

`engine/dev72` = `integration/claude-t1-t6` + one commit, `6c1ce4e`, the mask
renderer bugfix. `integration/claude-t1-t6` is a strict ancestor of
`engine/dev72` (verified).

`lab/dev72-algorithm` = `1141835` + T2 (`c50b867`) + T3 (`d472e6e`) + T4
(`eb5be4d`). Its three unique commits are **alternate merge commits of the same
three topic branches**, with identical resolutions. See "What
lab/dev72-algorithm holds" below — the honest answer is: nothing.

There is a fourth, sibling branch `lab/render-evidence` where commit `b2d9e33`
applies the same mask fix. Not examined here; named in `6c1ce4e`'s own message.

## What it detects

Nothing new. This whole lineage is **instrumentation and evidence plumbing**
around an unchanged detector, with two exceptions (T3's rejection diagnostics
and T6's `badgeOcclusionPatch` slot republish), both of which claim to be
behavior-neutral.

In plain language, what the 13 commits added:

- **Renderers (T1, T6, `6c1ce4e`)** — turn the raw bytes the algorithm already
  wrote to disk into things a person can open: PNGs for pixel-shaped data,
  aligned text tables and CSV for list-shaped data, and PNG overlays that draw
  boxes/points/lines on top of a base image.
- **Receipts and work accounting (T6)** — every operation in the compiled plan
  now leaves a record of how many board slots it read and wrote, and a rolled-up
  min/max/sum/count of every number the algorithm reported through its own
  measurement channel. "Board" = the shared key/value scratchpad operations read
  inputs from and write outputs to.
- **Tee rejection testimony (T3)** — every tee candidate that was examined and
  killed now leaves a marked point on the raster with the reason it died and the
  numbers that killed it. Previously a candidate just vanished.
- **Experiment layer (T4)** — a description format for "run this config, but
  sweep knob X across these values", expanded into concrete compiled plans and
  ranked by how much better or worse each one scores.
- **Isolated G2 tuning evidence (T2)** — split a combined two-feature test
  config into a single-feature one so basket evidence stops being contaminated
  by tee evidence.
- **Browser receipt viewer (T5)** — a Svelte page that loads a sweep's plan +
  receipts + rendered files and lets you click through them.
- **The `./lab sweep` command working end to end (T6)** — real image decode,
  crop, stitch, composite, one execution gateway, rendered artifacts, truth
  scoreboard.

## Why it exists

The stated problem, readable straight off the code comments and the branch
shape:

1. **"Why 0 tees?" was unanswerable.** Before T3, `detectTeeRingsPass` and
   `collectTeePoints` used bare `continue` statements. A tee candidate that
   failed a geometry window left no trace at all. The T3 comment in `measure.ts`
   states the goal exactly: *"no silent drops: every examined-and-killed
   candidate leaves a rejected drawable with its reason — this is the 'why 0
   tees?' answer on the raster."* **This is the direct antidote to the
   catastrophic failure this project already knows about** (see Known failure
   cases).
2. **Evidence images were unopenable or lying.** The sweep wrote `.bin` files
   nobody could look at. T1 added renderers; `6c1ce4e` fixed the mask renderer
   that was producing solid black.
3. **Coverage was overstated.** `artifactIo.ts` counted a renderer that
   *declined* to render as `rendered: true`, so sweep summaries reported more
   evidence than existed.
4. **Rasters carried no shape.** `.bin` payloads had no width/height, so no
   renderer could safely rasterize. T1 documented this as a GAP and refused to
   guess; T6 closed it.
5. **Receipts couldn't prove dataflow.** `badgeOcclusionPatch` declared slots it
   didn't touch when its feature flag was off, so the conformance check
   (declared vs actual) drifted.
6. **Tuning was manual and untracked.** T4 turned "try these knob values" into a
   described, deduplicated, deterministically ranked artifact.

## Signal and evidence

### What the renderers consume and produce (the owner's next build depends on this)

The pipeline is: **`ARTIFACT_EXTRACTORS` (in `@chainspot/alg/exec/operations.ts`)
→ `ExecSink.putArtifact` → `<outDir>/artifacts/<kind>/<id>.bin` →
`artifactIo.renderArtifact` → `RENDERERS[kind]` → `<outDir>/renders/<kind>/…`**.

The hard rule stated at the top of `rendererContract.ts`: *"LAB never recomputes
anything a detector produced (owner hard rule) — a renderer takes the EXACT bytes
@chainspot/alg's sink already wrote… It reads and presents; it never derives."*

**Eight artifact kinds. Four are raster (binary, needs dims), four are JSON.**

| kind | on-disk payload | what writes it | renderer output |
|---|---|---|---|
| `rgba` | raw RGBA bytes, `w*h*4` | `badgeStage.masks` → `localImage` | `<id>.png` |
| `mask` | `Mask.data` only, **one byte per pixel, values 0 or 1** | `badgeStage.masks` → `bright`, `dark` | `<id>.png` (scaled 0→0, nonzero→255) |
| `scalarField` | raw `Float32Array` bytes, no header | `supportField.support` | `<id>.png`, blue→green→red ramp over [min,max] of finite values; non-finite → alpha 0 |
| `orientationField` | raw `Float32Array` bytes, no header | `supportField.bestTheta` | `<id>.png`, HSV hue = `value / π` |
| `componentSet` | UTF-8 `JSON.stringify` | `badgeStage.components.bright` | `<id>.txt` aligned table + optional `<id>-overlay.png` with **orange `[255,165,0]` bounding boxes** |
| `candidateSet` | UTF-8 JSON | `tees.exclusion.kept` | `<id>.txt` + optional overlay, **cyan `[0,220,255]` boxes** |
| `polyline` | UTF-8 JSON | `rawPairs.sampleTeeLeg` (first pair only) | `<id>.txt` + optional overlay, **magenta `[255,0,255]` connected line** |
| `measurementTable` | UTF-8 JSON | `assignment.selection.table` | `<id>.txt` aligned table **and** `<id>.csv` |

`RendererInput` fields: `artifactRef` (`{id, kind, sha256, uri, rasterDims?}`),
`bytes`, `parsed` (pre-parsed JSON for the four JSON kinds, `undefined` for
rasters), `dims`, `baseRasterPngPath`, `outDir`, `opId`, `gate`.
`RendererOutput`: `{ filesWritten: string[], summary: string }`.

**The dims gap and how T6 closed it.** T1's contract documented that none of the
four raster payloads carries its own width/height, and mandated: a renderer
receiving `dims === undefined` **must decline and write a text stub, never
guess**. It offered the owner two candidate fixes. T6 took option (a): added
`rasterDims?: {width, height}` to `ArtifactRef`, threaded it through
`ExecSink.putArtifact` (node-sink, memory-sink, null-sink) and filled it in the
extractors from the *in-memory* board value — `image.width/height` for
`badgeStage.masks`, `field.width/height` for `supportField`. The contract note
is explicit: *"Present only when the producer supplied the raster's true shape
from in-memory evidence. It is never inferred from raw artifact bytes."*

Table renderers do their own column discovery: union of every row's keys,
sorted, padded to the widest cell. CSV escaping quotes on `"`/`,`/newline.
Non-object rows become `{index, value}`.

Overlay geometry helpers (`pointOf`, `boxOf`) accept several field spellings —
points from `[x,y]` or `xPx/x/cxPx/cx` + `yPx/y/cyPx/cy`; boxes from
`bbox:[x,y,w,h]` or `bboxX/bboxY/bboxW/bboxH`, and for componentSet also from a
nested `.component`. Lines are Bresenham. Points are a 5×5 cross (±2 px arms).

### T3's rejection testimony

`TeeCandidateDiagnostic = { xPx, yPx, reason, values: Record<string, number> }`,
delivered through an optional `TeeCandidateDiagnosticSink` threaded into
`detectTeeRings`, `detectTeeRingsPass`, `collectTeePoints`,
`excludeAndAssembleTees`, and both `tees.*` operations. Each call site emits
`ctx.overlay('tees', { type:'point', xPx, yPx: y + topPx, verdict:'rejected',
reason, values })`. Coordinates are local-frame plus the viewport top offset.
Note this made `tees.rawRings` newly consume the `viewport` slot.

Rejection reasons emitted (this list is the vocabulary a rebuilder must keep):
hole area overflowed the diagnostic bound; hole area below/above the active
min/max window; hole bbox exceeds the active maximum dimension window; enclosing
ring fill below the active minimum window; ring merged with an earlier dilation
detection; ring elongation below the tee-rect classification window; component
minimum/maximum dimension below/above the active window; component area
below/above the active window; component fill below/above the active window;
component candidate is inside an accepted ring dedup window; **component
candidate is inside a matched-sprite exclusion window**; ring/component inside
badge bbox (+Npx pad); ring/component inside screen-chrome cluster.

Each carries its numbers *and* the threshold it lost to (`holeAreaMin`,
`holeDimMax`, `ringFracMin`, `componentMinArea`, `spriteDistance` +
`teeSpriteExclusionDistance`, etc.). That pairing is the whole point: the
diagnostic tells you *which* threshold ate the candidate and by how much.

### T6's receipt work accounting

`OperationWork = { boardReadSlots: number, boardWrittenSlots: number,
measurements: OperationMeasurement[] }`, where `OperationMeasurement =
{ name, count, min, max, sum }` keyed `${unitId}.${name}`. Collected by wrapping
`FeatureContext` for the duration of one operation, delegating every call
through and accumulating alongside. The comment is careful: *"This observes the
algorithm; it never supplies a value back into it."*
`shapeProbes` was widened to report `.length` for arrays, typed arrays, `Map`,
`Set`, **and** for direct collection-valued fields one level down
(`slot.key.length`), so support-field cell counts and assignment candidate
counts become visible without recursing or recomputing.

## Thresholds and constants

`DEFAULT_ENDPOINTS_KNOBS` (G3 tees) — these are the knobs T3's diagnostics
report against. **They are pre-existing, not introduced by this lineage**; T3
only made them observable. Derivations are largely absent from the source.

| name | value | how derived | confidence |
|---|---|---|---|
| `holeAreaMin` | 10 | **UNKNOWN** — no derivation in source | low |
| `holeAreaMax` | 480 | **UNKNOWN** | low |
| `holeDimMax` | 44 | **UNKNOWN** | low |
| `ringBand` | 3 | **UNKNOWN** (pixel band width for ring-fill check) | low |
| `ringFracMin` | 0.6 | **UNKNOWN** | low |
| `dilationRadii` | `[0,1,2,3]` | Comment: occlusion/antialiasing cuts 1–4 px gaps into tee outlines, letting the hole leak to background — *"5 of 9 dev tee misses"*. Radii chosen to close those gaps. | medium (motivation documented, exact set not justified) |
| `largeRadiiThreshold` | 2 | Comment: larger radii erode the hole by ~radius per side, so coarser passes must require bigger holes. Which radius counts as "coarse" is asserted, not measured. | low |
| `largeRadiiAreaMin` | 40 | **UNKNOWN** — paired with the above; no measurement shown | low |
| `ringMergeProximity` | 10 | **UNKNOWN** | low |
| `elongationThreshold` | 1.18 | **UNKNOWN** — separates `tee-rect` from `diamond` | low |
| `componentMinDim` | 8 | **UNKNOWN** | low |
| `componentMaxDim` | 42 | **UNKNOWN**. Reused by T3 as its locality radius (below), which is a *justification borrowed from an unjustified number*. | low |
| `componentMinArea` | 80 | **UNKNOWN**. T3's whole experiment is aimed at this one. | low |
| `componentMaxArea` | 350 | **UNKNOWN** | low |
| `componentMinFill` | 0.2 | **UNKNOWN** | low |
| `componentMaxFill` | 0.85 | **UNKNOWN** | low |
| `teeRingDedupDistance` | 12 | Source comment explicitly warns: *"NOT the g4.scoring ringTolerance knob (coincidentally also 12) — a distinct dedup check here, tee-vs-tee, before assignment even runs."* Value itself **UNKNOWN**. | low, but the collision is documented |
| `teeSpriteExclusionDistance` | 24 | **UNKNOWN**. This is the "a matched basket sprite suppresses a tee candidate within 24 px" rule. See Known failure cases. | low — and this one is dangerous |

Constants introduced by this lineage:

| name | value | how derived | confidence |
|---|---|---|---|
| `componentMinArea` in `t3-heritage-g3-window-audit.json` | 50 | Config's own note: *"Lowers only componentMinArea to the measured Heritage H5 component area (50 px) so the scoreboard can test that single window hypothesis."* Measured from one component on one course. | high as a measurement, **not** a proposed default |
| `ASSOCIATION_TOLERANCE_PX` | 26 | **UNKNOWN**. Pre-existing in the sweep tests; T2 and T3 both reuse it. Governs "did this detection match truth". | low — and it silently sets every reported accuracy number |
| `CANDIDATE_LOCALITY_RADIUS_PX` (T3) | 42 | Test header: *"42 px is the active g3.endpoints maximum component dimension, so this locality rule is tied to the detector window, not chosen to make a miss look recoverable."* Deliberate, self-aware choice — but it inherits `componentMaxDim`'s own UNKNOWN provenance. | medium |
| `tipOffset` fallback in `familyTuning.test.ts` | 4 | `resolved.features['sprite']?.knobs.tipOffset ?? 4` — a hardcoded fallback if the config lacks the knob. **UNKNOWN** origin. | low |
| axis expansion cap (T4) | 10000 | Guard against a runaway grid. Arbitrary but harmless. | high (it's a safety rail, not a tuning value) |
| axis range epsilon (T4) | `1e-10`, `toPrecision(15)` | Float step accumulation guard. Standard practice. | high |
| point-marker arm (renderers) | 2 px | Cosmetic. Free to change. | high |
| overlay colors | `[255,165,0]` / `[0,220,255]` / `[255,0,255]` | Cosmetic, chosen for contrast. Free to change. | high |
| `badgeInsidePadding` | from `BadgeStageKnobs` | Reported in diagnostics as `badgePadding`; value lives in G1 knobs, not read here | n/a |

Pinned expectations that function as thresholds:

| name | value | source |
|---|---|---|
| DashsTrack canonical frame | `1290 × 2091` | `labSweep.test.ts` |
| DashsTrack compiled plan size | 17 operations, 17 receipts | `labSweep.test.ts` |
| DashsTrack scoreboard | G1 18/18, G2 18/18, G3 18/18, G4 18/18 | `labSweep.test.ts` |
| G0 stage list | `decode, gray, crop, stitch, materialize, truthMatch` | `labSweep.test.ts` |
| Heritage G3 tee misses | holes 5, 6, 10, 15 | `heritageG3Audit.test.ts` |
| Heritage miss verdicts | 5/6/10 = `WINDOW_CLIPPED`, 15 = `NON_WINDOW_REJECTED` | `heritageG3Audit.test.ts` |
| renderer golden hashes | rgba `664c367f…`, **mask `a0161cc0…`** (was `ac9e6595…` pre-fix), scalarField `862232be…`, orientationField `8e9a42e0…`, componentSet `397dd9fb…`, candidateSet `acfc4739…`, polyline `d6fa4acb…`, measurementTable `3ad3087a…` | `artifactRenderers.test.ts` |

## Gate placement

Gate vocabulary is `G1 | G2 | G3 | G4 | ST | G5 | shared` — labelled *G1 Badges,
G2 Baskets, G3 Tees, G4 Tee→Badge, ST Straight Test, G5 Path, Shared
(cross-gate)*. Note: **there is no `G0` gate id in the engine.** G0 is the
pre-engine intake (decode/gray/crop/stitch/materialize/truthMatch), which lives
in `inputShim.ts` and produces the canonical frame before any gate runs.

| work | gate | depends on |
|---|---|---|
| G0 canonical intake (T6 `inputShim.ts`) | pre-gate | `@chainspot/alg/adapters/node` decoder, `g0/{composite,crop,inputAsset,ledger,stitchSolve,truth}`. Requires all inputs the same pixel size. Truth is loaded but **only consumed after the frame is materialized**. |
| Renderers (T1, `6c1ce4e`) | post-gate, all gates | Reads `<outDir>/artifacts/`, which the node sink wrote during `executeCompiledPlan`. Purely downstream — cannot affect detection. |
| Receipt `work` + `rasterDims` (T6) | inside the gateway, every gate | `executeCompiledPlan` wraps `FeatureContext` per operation; `ARTIFACT_EXTRACTORS` fills dims from board values. |
| Tee rejection diagnostics (T3) | **G3** | `tees.rawRings` (now consumes `stage` + `viewport`) and `tees.exclusion`. Sprite-exclusion diagnostics depend on **G2**'s matched sprite centers already being on the board. |
| `badgeOcclusionPatch` slot republish (T6) | **G1→G5 boundary op** | Reads `supportField`, `localImage`, `viewport`, `badges` unconditionally; re-`set`s `supportField` unconditionally. |
| T2 clean-basket tuning config swap | **G2** evidence only | Test-side; changes which config the observational sweeps run, not the default. |
| T4 experiment layer | none — pre-execution | Sits above `compileExecutionPlan`. Stops at plan compilation + objective plumbing; the caller supplies course data and the evaluator. |
| T5 receipt viewer | none | Static Svelte route `/lab/receipts`, reads a manifest + `receipts.jsonl` + rendered files. |

## Known failure cases

**1. The trophy-basket square-bbox failure has a live mechanism here, and T3 is
the only thing standing between it and a wrong conclusion.**

`collectTeePoints` contains:

```
const spriteDistance = Math.min(...spriteCenters.map((s) => Math.hypot(s.cx - c.cx, s.cy - c.cy)), Infinity);
if (spriteDistance < knobs.teeSpriteExclusionDistance) { … continue; }
```

A matched basket sprite **suppresses any tee component whose centroid is within
24 px of the sprite centre**. That is exactly the "basket swallows a nearby tee"
shape. Before T3, this suppression was a bare `continue` — the tee simply did not
exist, and an inspector staring at the raster would correctly conclude "no tee
here" and would be wrong. T3 makes it emit `'component candidate is inside a
matched-sprite exclusion window'` with both `spriteDistance` and
`teeSpriteExclusionDistance`. **A rebuilder must keep this diagnostic. Removing
it re-arms the exact failure this project has already been burned by.**

Related, same family: `insideBadge` rejects rings and components whose centre
falls inside a badge bounding box plus padding, and `pointInScreenChrome` rejects
by chrome cluster. Both are bbox/region-based negative evidence over a
non-rectangular subject. Both now emit reasons. Keep them.

**2. Bounding-box overlays are drawn as rectangles, and rectangles lie about
shape.** `renderComponentSet` and `renderCandidateSet` draw axis-aligned
rectangles from `bbox`/`bboxX..H`. For a trophy-shaped basket sprite, that
rectangle visibly covers ground the sprite does not occupy. Anyone reading these
overlays as "what the detector claims is basket" will over-read them. The
overlays are a *box list*, not a mask. Consider drawing the mask, or drawing the
box dashed/low-alpha, in the rebuild.

**3. T2 fixed a negative-evidence undercount.** `familyTuning.test.ts` previously
computed `wronglyRejected` from `metricDecisions` only — decisions that *reached*
metric evaluation. TRUE baskets killed earlier at the `no-component` or
**`bad-bbox`** stage were invisible in the "wrongly rejected" report. T2 changed
it to `all.filter(d => d.isTrue && !d.accepted)` and relabelled the line
"(all stages)". Any pre-T2 claim about clean-basket rejection counts is an
undercount. `bad-bbox` is, again, the trophy shape.

**4. The mask renderer shipped solid black.** See "What proves it works". Every
mask evidence image produced before `6c1ce4e` is worthless — set pixels were
written as `RGB(1,1,1)`.

**5. The renderer contract's own documentation was wrong.** It asserted masks
were 0/255 and told readers to *"confirm against raster.ts's mask writers before
assuming bit-packing"* — the doc got the encoding wrong while telling you to go
check. The doc caused the bug rather than preventing it. Treat every remaining
payload-format claim in that file as unverified until re-checked against
`operations.ts`.

**6. Overlays are dead code in the real sweep.** `artifactIo.renderArtifact`
hardcodes `baseRasterPngPath: undefined`. The overlay branch of
`renderComponentSet`/`renderCandidateSet`/`renderPolyline` **can never fire
during `./lab sweep`** — it only runs in the unit test that passes the path
explicitly. In production the three JSON kinds produce text tables and nothing
visual. This is a confirmed, currently-live gap on `engine/dev72`'s tip.

**7. T5's receipt viewer disagrees with T6's receipt shape, and nothing catches
it.** T5 (written in parallel off the same base) types work as
`boardReadSlots?: readonly string[]` / `boardWrittenSlots?: readonly string[]`
with `measurements` as an object map, and its fixture `receipts.jsonl` encodes
them that way. T6 shipped `boardReadSlots: number`, `boardWrittenSlots: number`,
`measurements: OperationMeasurement[]`. The merge never reconciled them. The
viewer survives only because it renders `work` as `<pre>{json(...)}</pre>` —
but the declared types are wrong and **the fixture is not representative of what
the sink actually writes**. `receiptViewerFixture.test.ts` only asserts
`work !== undefined`, so it cannot catch this.

**8. T6 changed production code for instrumentation reasons.**
`badgeOcclusionPatch` now reads `supportField`/`localImage`/`viewport`/`badges`
and re-`set`s `supportField` **even when `patchBadges` is disabled**, purely so
the receipt's actual dataflow matches its declared dataflow. The comment claims
this is *"without changing the frozen default pixels."* That claim rests on
`patchBadgeOcclusion` mutating in place and `board.set` of the same object being
a no-op. It is plausible and the sweep pins still pass — but this is a
conformance metric reaching into the algorithm, which is a smell worth naming.

**9. Windows/POSIX entrypoint collision.** `./lab` (bash) and `lab.cmd` (a
completely different machine-bound provenance auditor,
`scripts/lab-orient-3fd72.mjs`) share a name. On Windows `lab` resolves to the
wrong tool. The README documents the workaround (`npx tsx sweep/sweepCli.ts`
from `scripts/chainspot-lab`) rather than fixing it.

**10. `orient`, `gate2`, `gate3` were never ported.** They import
`src/lib/nuthing/*`, which does not exist in this tree. README records that
after a shared prettier pass, `components.ts`, `raster.ts`, `families.ts`,
`digits/normalize.ts`, `digits/segment.ts` are byte-identical between the two
layouts, and the real divergence is `ribbon.ts` (substantial), `badgeStage.ts`,
`endpoints.ts`, two `digits/` files, plus LAB-only modules with no product
counterpart (`teeCandidates.ts`, `smartBasket.ts`, `candidatePool.ts`,
`chamfer.ts`, `twoPass.ts`, `viewport.ts`).

## What proves it works

**The renderer bugfix (`6c1ce4e`) — the diff, quoted.**

Commit message (verbatim, and it checks out against the diff):

> Masks are 0/1 per byte (alg raster.ts: dark[i]=1, bright[i]=1); the
> renderer copied the raw byte into RGB directly, so every set pixel
> became RGB(1,1,1) -- indistinguishable from black. Scale to 0/255.
> The renderer contract's own doc comment claimed 0/255 and was wrong;
> corrected alongside the fix.

The fix in `scripts/chainspot-lab/sweep/artifactRenderers.ts`, `renderMask`:

```diff
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
```

The corrected doc in `rendererContract.ts`:

```diff
-//                    element; this codebase's Mask is 0/255 per pixel, not
-//                    bit-packed (confirm against raster.ts's mask writers
-//                    before assuming bit-packing).
+//                    element; this codebase's Mask is 0/1 per pixel (see
+//                    alg raster.ts mask writers: dark[i]=1, bright[i]=1),
+//                    NOT 0/255 and not bit-packed. Renderers must scale to
+//                    0/255 for display or set pixels render as black.
+//                    (Doc previously claimed 0/255 — that error shipped a
+//                    solid-black mask renderer; caught in review 2026-08-23.)
```

The coverage-honesty fix in `artifactIo.ts`:

```diff
+		// A renderer that declined (dims unknown etc.) writes a stub and says
+		// so in its summary — counting that as rendered overstates coverage.
+		const stubbed = output.summary.endsWith('stub only');
 		return {
 			artifactRef,
-			rendered: true,
+			rendered: !stubbed,
```

And the golden re-pin in `tests/unit/artifactRenderers.test.ts`:
`mask: 'ac9e6595…'` → `mask: 'a0161cc0…'`.

The commit claims 248 tests green on the full `engine/dev72` battery, parity and
dev72 sweep pins untouched, and byte-identical mask hash against
`lab/render-evidence` `b2d9e33` in a third environment. **Not independently
re-run here.**

**Tests and fixtures that exist:**

| test | what it pins |
|---|---|
| `tests/unit/artifactRenderers.test.ts` | 8 golden SHA-256 hashes over renderer output; overlay determinism + PNG magic bytes; decline-without-dims behavior; a 500×400 scalar field renders without spreading extrema |
| `tests/unit/labSweep.test.ts` | real DashsTrack sweep: 1290×2091, byte-level truth match, 6 G0 steps, 17 ops/17 receipts, `badgeOcclusionPatch` declared==actual, `rawPairs.supportMin` measured, G1–G4 all 18/18. `describe.skipIf` — **silently skipped when `../chainspot-corpus` is absent** |
| `tests/unit/heritageG3Audit.test.ts` | Heritage misses = holes [5,6,10,15]; verdicts 5/6/10 WINDOW_CLIPPED, 15 NON_WINDOW_REJECTED; every rejected candidate carries finite numbers; writes `artifacts/sweep/t3-heritage-g3-audit/Heritage-g3-default.{json,png}` plus per-course default/experiment PNGs |
| `tests/unit/exec.experiment.test.ts` | 269 lines over the T4 axis expansion / dedup / ranking |
| `tests/unit/exec.evidenceChains.test.ts` | extended by T6 |
| `tests/unit/familyTuning.test.ts`, `familyDeviationSweep.test.ts` | observational only — **no `expect()` on gate counts by design**; write per-course PNGs to `artifacts/sweep/chspt-82-clean-basket-family-deviation/` |
| `tests/unit/receiptViewerFixture.test.ts` | fixture has 3 ops, 3 receipts, some `work`, all artifacts non-empty, table text contains `label`, CSV contains `badgeId,teeId,score` |

**Evidence images:** T2 and T3 both render `renderSweepEvidencePng` course
images. T3 additionally writes a full JSON dump including
`activeEndpointsKnobs`, every rejected candidate, and per-hole verdicts — that
is the strongest evidence artifact in this lineage.

**What is NOT backed by evidence images:**

- `labSweep.test.ts`'s 18/18 × 4 gates claim renders **no image at all**. The
  headline accuracy number in this lineage has no picture behind it.
- The 8 renderer goldens are hashes of 2×2 synthetic inputs. **Nobody looked at
  them.** That is precisely why the solid-black mask survived T1 — the golden
  hash was stable and wrong.
- **The mask regression fixture is still not representative.** It is
  `new Uint8Array([0, 255, 128, 64])`. Real masks are 0/1. The fixture would not
  reproduce the reported defect; it only detects that the mapping changed. A
  rebuilder should use 0/1 bytes there.
- T4's experiment layer is unit-tested against synthetic evaluators; no real
  corpus grid search result is recorded.
- T5's viewer has no browser/render test, only a fixture-shape test that does
  not check the shape that matters.

## What lab/dev72-algorithm holds that the others do not

**Nothing.** This is worth stating plainly because it contradicts the
expectation.

`lab/dev72-algorithm` has three commits absent from `integration/claude-t1-t6`
(`c50b867`, `d472e6e`, `eb5be4d`) — but all three are merge commits of T2, T3,
T4, the *same* topic commits `integration` also merged, with the *same*
resolutions.

Proof: `git diff --name-status engine/dev72 lab/dev72-algorithm` returns **zero
`A` entries** — no file exists on `lab` that is absent from `engine/dev72`. And
stepwise, the delta between each `lab` merge and its `integration` counterpart is
*exactly and only* the T1 renderer files:

```
c50b867 vs 4a5930b  →  artifactRenderers.ts, rendererContract.ts, artifactRenderers.test.ts
d472e6e vs 3c125f1  →  (identical 3 files)
eb5be4d vs bab95ce  →  (identical 3 files)
```

So `lab/dev72-algorithm` is best read as `1141835 + T2 + T3 + T4` — an
**algorithm-and-experiment line deliberately kept free of renderer, receipt-
viewer, and sweep-completion work**. Its only remaining value is as evidence of
that intent: someone wanted a branch where the alg package's changes could be
reviewed without T1/T5/T6 noise. As a source of code to recover, it is empty.
Deleting it loses no content.

## Regeneration notes

**Must get right:**

1. **Masks are 0/1, not 0/255, and not bit-packed.** Any renderer must scale.
   Verify against `raster.ts`'s writers (`dark[i]=1`, `bright[i]=1`) in the new
   tree, not against any doc comment. Put a real 0/1 fixture in the test.
2. **Never infer raster dimensions from payload length.** Carry them from the
   producing operation's in-memory value. If they are absent, **decline and stub
   — do not guess.** The alternative T1 offered and T6 declined (an 8-byte LE
   `u32 width, u32 height` header on the four raster payloads) is still on the
   table and is arguably cleaner than a field on `ArtifactRef`; either is fine,
   guessing is not.
3. **A declined render is not a render.** Any coverage/inventory count must
   reflect the renderer's actual outcome. Do not use string-suffix matching on
   `summary` for this the way `artifactIo.ts` does (`endsWith('stub only')`) —
   that is fragile. Return a structured `declined: boolean`.
4. **Keep every rejection reason on the tee path, especially the sprite
   exclusion.** Silent `continue` on a detector candidate is how the
   trophy-basket disaster happens. The reason string *and* the losing threshold
   value must both travel.
5. **Renderers read; they never derive.** This is the owner's stated hard rule
   and every file in this lineage restates it. Keep it.
6. **Truth is evaluation-only.** G0 intake loads truth but does not consume it
   until after the canonical frame is materialized; T4's expansion and
   compilation never see it. Preserve that ordering.
7. **The gate vocabulary is `G1 G2 G3 G4 ST G5 shared`.** There is no engine
   `G0`; G0 is pre-engine intake. Do not invent a `G0` gate id.
8. **Wire `baseRasterPngPath`.** The overlay code exists and is tested but is
   unreachable in the real sweep. Rendering the `rgba` artifact from a receipt
   first, then passing its path to that receipt's JSON-kind renderers, is a small
   change with large payoff — it is the difference between a text table and a
   picture of where the detector thinks things are.
9. **Reconcile the receipt `work` shape before writing a viewer.** One
   definition, one fixture, generated from a real sink run rather than hand-
   authored.

**Free to change:**

- Overlay colours, the 2 px cross arms, the scalar/HSV colour ramps, table
  column ordering and CSV escaping details. All cosmetic; all currently pinned
  only by golden hashes that will need re-pinning anyway.
- File naming (`fileBase` sanitises `[^A-Za-z0-9._-]` to `_`) and the
  `renders/<kind>/` layout.
- The `RENDERERS` registry mechanism — a `Partial<Record<ArtifactKind,
  RendererFn>>` with a CLI fallback stub is fine but not sacred. The genuinely
  good property to keep is that **a sweep runs end to end with zero renderers
  implemented**.
- T4's ranking rule (Pareto front → total matched delta desc → aggregate
  deviation asc → plan fingerprint asc). It is deterministic, which is the part
  that matters; the specific ordering is a policy choice.
- The `./lab` bash entrypoint. Given the `lab.cmd` collision on Windows, rename
  it in the rebuild.
- All the `stub.txt` text.

**Do not port as-is:**

- T5's receipt viewer (677 lines of Svelte) — its data model is wrong against
  the shipped receipt. Rebuild from the real `Receipt` type.
- T5's `static/fixtures/chainspot-sweep/` — hand-authored and unrepresentative.
  Generate it from an actual sweep run.

## Verdict

**Partially worth it.** The renderer layer, the dims contract with its
decline-don't-guess rule, and T3's rejection testimony are the real assets and
should be rebuilt deliberately — T3 in particular is the project's own antidote
to its known catastrophic failure. T4's experiment layer is clean, self-contained
and worth keeping. T6's `rasterDims` plumbing and `work` accounting are worth
keeping but need the `badgeOcclusionPatch` republish re-justified. T5's receipt
viewer and its fixture should be discarded and rebuilt against the real receipt
shape, and `lab/dev72-algorithm` should simply be deleted — it contains no file
and no hunk that `engine/dev72` does not already have.
