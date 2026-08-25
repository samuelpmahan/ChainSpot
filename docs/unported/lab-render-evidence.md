# lab/render-evidence

## Source

Repository inspected read-only: `C:/Users/tenni/workspace/ChainSpot` (OLD layout, but note: by
this point in CHSPT-82 the algorithm had already been moved into a workspace package, so paths on
these branches read `packages/alg/src/detectors/threeFactor/`, **not** `src/lib/detectors/`. Commit
`e2ac538` "Wave 0: @chainspot/alg workspace package — ownership inversion (behavior-free)" is the
move. A rebuilder reading old notes that say `src/lib/...` should not be confused.)

**Branch:** `lab/render-evidence`, tip `b2d9e33`, dated 2026-08-24 01:08:05 -0500.
**Working tree:** clean. No stash entries. Everything described here is **committed**, nothing is
sitting dirty. Nothing on this branch is pushed to `origin`.

**"6 unpushed commits" — confirmed, but misleading.** `git log lab/render-evidence --not --remotes`
does return 6. Only **3** of those are unique to this branch; the other 3 (`c974690`, `f91939d`,
`32bec03`) are *also* unpushed on `engine/dev72`. The shared-but-unpushed commits were double
counted.

The 3 commits genuinely not in `engine/dev72`:

| sha | subject | substance |
|---|---|---|
| `d3430cb` | Merge branch `claude/t1-artifact-renderers` | merge commit, no unique content |
| `07cdbff` | Merge branch `claude/t5-receipt-viewers` | merge commit, no unique content |
| `b2d9e33` | fix mask renderer producing solid-black evidence images | real fix — **but duplicated on dev72 as `6c1ce4e`** |

**The reported premise is wrong.** The task brief says this branch "forked before engine/dev72 and
holds unique G0 work." Neither half holds:

- **It did not fork before dev72.** Reflog: `lab/render-evidence@{3}: branch: Created from 1141835`.
  `1141835` is an ancestor of `engine/dev72` as well. The two branches are **sibling integration
  branches** off the same trunk, not a parent and a child. `git merge-base` is `c974690`, which sits
  on both.
- **It holds no unique G0 work — it holds *older* G0 work.** `lab/render-evidence` integrated 2 of
  the 6 parallel Codex/Claude lanes (T1 artifact-renderers, T5 receipt-viewers).
  `engine/dev72` integrated all 6 (T1–T6). Every G0 file on this branch is byte-identical to its
  state at the merge-base while dev72's moved forward.

**Verified subsumption, three independent ways:**

1. **File set.** `comm -23 <(git ls-tree -r --name-only lab/render-evidence | sort) <(git ls-tree -r
   --name-only engine/dev72 | sort)` returns **empty**. There is not one file on this branch that
   does not exist on dev72. The reverse direction returns 7 files (the T2/T3/T4/T6 lane output:
   `packages/alg/src/exec/experiment.ts`, `threeFactor-experiment.schema.json`,
   `docs/threeFactor-experiment.md`, `configs/t3-heritage-g3-window-audit.json`, and three test
   files).
2. **Per-file ancestry.** 26 files differ between the tips. For **19 of them**, this branch's blob
   hash is *identical to the merge-base blob* — pure "dev72 moved, lab stood still." The 7 remaining
   are files that exist only on dev72.
3. **Line level.** Every added line under `git diff -w --ignore-blank-lines engine/dev72
   lab/render-evidence` is superseded prose or superseded code — the shim header, the stale
   "RENDERERS starts empty" comment, prettier-unformatted call signatures. No new logic.

## What it detects

Nothing. This branch contains no detector.

It is **evidence tooling**: a set of small functions that take the exact bytes the algorithm's
receipt sink already wrote to disk and turn them into files a human can open — PNGs, PNG overlays,
plain-text tables, CSVs. Plain-word gloss of the terms that recur below:

- **artifact** — a blob of intermediate output a pipeline step chose to save (a mask, a field of
  numbers, a list of candidate shapes), stored as `<outDir>/artifacts/<kind>/<id>.bin`.
- **renderer** — a function that reads one artifact's bytes and draws or prints it. It is forbidden
  from recomputing anything; it reads and presents only.
- **stub** — the text note a renderer writes instead of a picture when it does not have enough
  information to draw one honestly (almost always: it does not know the image's width and height).
- **receipt** — the per-operation record of what ran, how long it took, and which artifacts it
  emitted.

The one behavioral thing this branch actually contributes is a **bug fix**: masks in this codebase
store `1` for a set pixel, not `255`. The renderer was copying that raw byte straight into the red,
green, and blue channels, so every set pixel came out as RGB(1,1,1) — visually indistinguishable
from black. Every mask evidence image was a solid black rectangle. The fix scales to 0/255.

## Why it exists

The branch exists because the CHSPT-82 sprint ran six work lanes in parallel and someone integrated
two of them here to unblock looking at renderer output early. It was a staging area, not a line of
development.

The **fix** on it exists for a reason that does matter and that outlives the branch: the renderer
contract's own documentation was **wrong about the format it was documenting**. `rendererContract.ts`
told implementers that `mask` payloads were 0/255. The actual producer (`alg raster.ts`, writing
`dark[i]=1` and `bright[i]=1`) emits 0/1. An implementer who trusted the doc wrote a renderer that
shipped solid-black evidence images. That is a wrong-doc-becomes-wrong-code failure, and the fix
corrected both the code and the comment in the same commit.

The commit message records who caught it: "Found by an independent review pass (Opus 5
orchestrator, 2026-08-23) auditing the ticket branches before implementation began." It was caught
by review, not by a test — no test was failing, because the golden hash pinned the *wrong* output.

## Signal and evidence

What the renderers on this branch actually look at, per artifact kind. All of this is present
identically on `engine/dev72`; it is recorded here so the spec stands alone.

| kind | bytes on disk | what the renderer does |
|---|---|---|
| `rgba` | raw RGBA, `w*h*4` | writes a PNG directly |
| `mask` | one byte per pixel, values 0/1 | scales `byte ? 255 : 0` into R,G,B; alpha 255; writes PNG |
| `scalarField` | bare little-endian `Float32Array`, no header | min/max over finite values, maps each through a diverging colour ramp |
| `orientationField` | bare little-endian `Float32Array`, no header | maps `value / π` through an HSV hue wheel |
| `componentSet` | UTF-8 JSON | text table + CSV, plus an **axis-aligned box overlay** on the base image |
| `candidateSet` | UTF-8 JSON | same, different overlay colour |
| `polyline` | UTF-8 JSON | text table + a connected-line overlay |
| `measurementTable` | UTF-8 JSON | text table + CSV only |

**The structural gap the contract file names out loud, and that a rebuilder must not re-open:**
none of the four raster payloads carry their own width and height. `rgba` is bare pixel data (`w`
and `h` are *not* individually recoverable from the byte count). `mask` is `Mask.data` with
`Mask.width`/`Mask.height` dropped by the serializer. `scalarField`/`orientationField` are a bare
float array with no shape at all. The rule adopted was: **when dimensions are unknown, decline to
rasterize and write a text stub — never guess.** That rule is correct and should survive the
rebuild.

On `lab/render-evidence` that gap is still open (`dims: undefined`, with a "no dims source is
wired up yet" note). On `engine/dev72` it is **closed** — `dims: artifactRef.rasterDims`, i.e. the
reference carries the shape. This is one of the concrete ways dev72 is ahead.

### Occlusion, bounding boxes, and negative evidence — read this

The brief asks for an explicit callout wherever bounding boxes or negative evidence appear. They
appear here, in the overlay path, and the risk is real:

- `boxOf()` accepts either a `bbox: [x, y, w, h]` array or `bboxX/bboxY/bboxW/bboxH` scalars, and
  **falls back to `entry.component`'s box** if the entry itself has none. It produces an
  **axis-aligned rectangle** and nothing else. There is no rotated box, no mask-shaped outline, no
  concave hull.
- `drawBox()` draws four `drawLine()` strokes — an **outline, not a fill**. That is a small mercy:
  an unfilled rectangle at least lets a human see the pixels inside it.
- There is **no occlusion reasoning anywhere in this code, and no notion of negative evidence.** A
  renderer will cheerfully draw a box that overlaps a neighbouring feature, and the resulting image
  carries no signal at all about whether that overlap means anything.

This is precisely the surface where the known catastrophic failure becomes visible: a
trophy-shaped basket sprite gets an axis-aligned square, the square visually swallows a nearby tee
pad, and a human (or an agent) reading the overlay concludes "there is no tee here" and deletes
correct code. **The overlay is drawing a box, not asserting containment.** Any rebuilt renderer
must not let a viewer read the second thing off the first.

The branch carries a committed image named after exactly this hazard:
`old-stuff/scripts/cv-probes/corridor-evidence-grid-results-ts/hole-11-basket-near-neighbor-tee-leakage-risk-.png`.
It is not unique to this branch (it is on dev72 too), and I did **not** open it to confirm what it
shows — the filename is being reported, not the contents.

**Concrete mitigations for the rebuild, none of which this code has:** label each box with the
record's own id so an overlapping box is attributable; draw basket boxes and tee boxes in
distinguishable colours *and* stroke styles, not colour alone; where a mask exists, prefer the mask
outline over its bounding rectangle; and never emit an "absence" conclusion from an overlay image —
absence needs its own evidence, not the negative space in someone else's box.

## Thresholds and constants

Every magic number in the code this branch uniquely touched. **These are display constants, not
gate thresholds** — none of them changes what the algorithm decides, only what a human sees. That
lowers the stakes, but a wrong display constant is exactly what caused the bug this branch fixes,
so they are all recorded.

| name | value | how derived | confidence |
|---|---|---|---|
| mask display scale | `byte ? 255 : 0` | **Derived from the producer's source.** `alg raster.ts` writes `dark[i]=1`, `bright[i]=1`. Verified by reading that file, not assumed. | high |
| `bytesPerPixel` — rgba | 4 | RGBA definition | high |
| `bytesPerPixel` — mask | 1 | one byte per element, `Mask.data` | high |
| `bytesPerPixel` — scalar/orientation | 4 | `Float32` width | high |
| float decode endianness | little-endian, stride 4 | `DataView.getFloat32(offset, true)`; matches `floatBytes()` writing a raw `Float32Array` view | high |
| orientation hue divisor | `Math.PI` | orientation angles live in `[0, π)`, so `value / π` lands in `[0,1)` for the hue wheel. Semantic, not fitted. | med-high |
| scalar ramp | `R=255t`, `G=255(1-|2t-1|)`, `B=255(1-t)` | **UNKNOWN.** An arbitrary diverging ramp with no recorded rationale. Not colour-blind safe. Freely replaceable. | UNKNOWN |
| empty-field fallback range | `min=0, max=1` when zero finite values | **UNKNOWN.** Arbitrary; only prevents a divide-by-zero on an all-NaN field. | UNKNOWN |
| non-finite alpha | 0 (transparent), else 255 | deliberate: NaN cells should read as holes, not as a colour | med |
| `drawPoint` cross half-length | 2 px | **UNKNOWN.** Arbitrary visual choice. At high zoom this is invisible; at low zoom it is a dot. Freely changeable. | UNKNOWN |
| componentSet overlay colour | RGB(255,165,0) orange | **UNKNOWN.** Arbitrary. | UNKNOWN |
| candidateSet overlay colour | RGB(0,220,255) cyan | **UNKNOWN.** Arbitrary. | UNKNOWN |
| polyline overlay colour | RGB(255,0,255) magenta | **UNKNOWN.** Arbitrary. | UNKNOWN |
| golden render hashes | 8 sha256 pins in `tests/unit/artifactRenderers.test.ts` (mask pin `a0161cc0…`) | re-pinned after the fix; the pre-fix pin encoded the *wrong* image | see failure cases |

**Landmine, and it is not a number.** `artifactIo.ts` decides whether a render succeeded by
**string-matching the renderer's human-readable summary**:

```ts
const stubbed = output.summary.endsWith('stub only');
return { artifactRef, rendered: !stubbed, ... };
```

Coverage accounting — "N rendered, M stubbed" — hangs off an English phrase. Rewording any stub
message silently inflates the reported coverage. This is worse than an unexplained threshold,
because no one will think to look at it. **A rebuild must replace this with an explicit outcome
field on `RendererOutput`** (`{ ok: true } | { ok: false, reason }`), and the summary string should
be presentation only.

## Gate placement

**None. This does not run in G0–G5.**

The renderers sit *downstream of the whole pipeline*, in the LAB sweep CLI
(`scripts/chainspot-lab/`). Order of operations: the pipeline runs → the exec sink writes artifact
bytes → the sweep CLI reads those bytes back off disk → renderers turn them into pictures. Nothing
in G0–G5 depends on a renderer, and removing every renderer leaves the sweep runnable (it just
prints raw bytes plus a one-line note per artifact).

The one file on this branch that *is* G0 is `scripts/chainspot-lab/sweep/inputShim.ts`, and it is
the **superseded** version:

- **This branch:** `shimmed: true`. Calls `decodeNodeFile` and stops. No crop, no stitch, no
  composite, no ledger. Its own header calls it "real decode wearing a fake front door." Because it
  hands `matchTruth` an always-empty ledger (`{ entries: [] }`), it can only ever report `byte` or
  `dims-only` — **never `reconciled-verified`**, which requires a real transform record.
- **`engine/dev72` (commit `34c2cfc` "complete canonical lab sweep"):** `shimmed: false`. Real
  intake — `decode → gray → crop → stitch → materialize → truthMatch`, with a populated
  `CoordinateTransformLedger` and per-stage timing (`G0Step`).

Dependencies of the renderer layer: `@chainspot/alg/exec`'s `ArtifactRef` and `ArtifactKind`, the
Node sink's on-disk layout, and `pngjs`. That is all.

## Known failure cases

1. **Solid-black mask images (fixed here, and also on dev72).** Mask bytes are 0/1; writing them
   straight into RGB yields RGB(1,1,1). Root cause was a doc comment asserting the wrong format.
2. **Overstated render coverage (fixed here, and also on dev72).** A renderer that declined and
   wrote a stub was still counted `rendered: true`.
3. **Stack overflow on large fields (fixed upstream in `f91939d`, present on both branches).**
   `Math.min(...values)` on a support field of hundreds of thousands of cells exceeds Node's
   argument limit before a picture can be drawn. The fix is a plain scanning loop. **This branch
   has the fix but is missing the three-line comment explaining why the loop must stay a loop** —
   dev72 has it. That comment is the only thing standing between a future "simplify this" refactor
   and a re-crash.
4. **Coverage accounting is a string match** — see above. Not fixed anywhere.
5. **Everything stubs out when dims are unknown.** On this branch that is *most* raster artifacts,
   because `dims` is hardcoded `undefined`. dev72 fixed it. Correct behaviour (stub, don't guess),
   wrong-looking output (almost nothing renders).
6. **Bounding boxes invite the tee-deletion failure.** See the occlusion section.
7. **Golden hashes can pin a bug.** The pre-fix mask hash was green while the image was solid
   black. A hash pin proves *stability*, not *correctness*. This is the branch's most transferable
   lesson.

## What proves it works

- **Tests:** `tests/unit/artifactRenderers.test.ts` — **byte-identical on both branches**. It
  round-trips all 8 kinds through their renderer and pins a sha256 of the written files. 8 golden
  hashes, mask being `a0161cc0713130f44debf697316a3f53a4e8370d7fa6639da50cb229f05c4078`.
- **Suite counts (claimed in commit messages, not re-run by me):** 242 tests green on this branch,
  248 on `engine/dev72`. The 6-test delta is the T2/T3/T4/T6 lanes this branch never merged.
- **Cross-environment check (claimed in `6c1ce4e`'s message, not re-run by me):** "mask hash
  verified byte-identical across both trees and a third independent environment."
- **Rendered evidence images backing the fix: nothing.** No before/after PNG was committed. The
  branch is *named* `render-evidence` and it fixed an evidence-image bug, and there is **no
  committed image showing the black-before and the visible-after.** Per this project's own rule
  that every claimed number ships with a rendered evidence image, this fix is under-evidenced. The
  golden hash changed, which proves the bytes changed; it does not prove they changed into
  something a human can read.
- **Course fixtures:** 105 images are committed on this branch, all under `old-stuff/`, all also on
  dev72. None were produced by this branch's work.

## Regeneration notes

**Do not regenerate this branch.** Regenerate `engine/dev72`, which contains everything here plus
four more lanes. If a rebuilder is holding both specs, this one exists to say "you can close that
tab."

Carry these five things forward regardless of which branch they come from — they are the durable
knowledge, and none of them is code:

1. **Masks are 0/1, not 0/255.** Any renderer, debugger, or overlay that touches a mask must scale.
   Check the producer (`raster.ts`), not the doc.
2. **A doc comment that describes a format is code.** The one here was wrong and shipped a bug. If
   the rebuild keeps format documentation next to a renderer, it needs a test that reads a real
   artifact and asserts the documented invariant — not a hash pin.
3. **Never guess raster dimensions.** Decline and stub. Better: fix it at the source so the
   question never arises — either put `dims` on the artifact reference (what dev72 did) or prefix
   raster payloads with an 8-byte little-endian `(u32 width, u32 height)` header. Either closes the
   gap without the presentation layer recomputing anything.
4. **Render outcome must be a typed field, not a parsed sentence.** Replace
   `summary.endsWith('stub only')`.
5. **An overlay box is a drawing, not a claim.** No absence conclusion may be drawn from one. See
   the occlusion section for the specific mitigations.

Freely changeable, no rationale to preserve: every colour, the scalar ramp, the 2px point cross,
the text/CSV table formatting, `pngjs` as the encoder, and the file naming scheme.

Must be got right: the 0/1→0/255 scale, little-endian float decode, the byte-length-versus-`w*h*bpp`
guard before rasterizing, the decline-don't-guess rule, and the scanning loop for extrema (with its
comment intact).

## Verdict

**Discard.** `lab/render-evidence` is fully subsumed by `engine/dev72` — its file set is a strict
subset, 19 of its 26 differing files are frozen at the merge base, and its one real contribution
(the mask 0/1→0/255 fix) already exists on dev72 as `6c1ce4e` with a verified-identical result; the
lessons in this document are worth keeping, the branch is not.
