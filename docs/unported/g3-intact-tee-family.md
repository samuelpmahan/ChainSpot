# G3 intact tee-family

## Source

**Branch:** `codex/ab-g3-intact-tee-family` on `C:/Users/tenni/workspace/ChainSpot` (OLD layout).
**Tip:** `936a6be074de00d447247db54cf8d9370016c8cd` — "CHSPT-82: complete G3 rejected-frame trace", Sun Aug 23 02:30 2026.
**State:** everything is **committed**. Working tree is clean; the worktree is checked out on `main`, so this branch is parked, not active. Nothing sits dirty.

Commit chain (oldest → newest), from the shared base with its sibling branch:

| sha | subject | tee-family? |
|---|---|---|
| `f05602b` | extract g1.digits knob cluster | no — shared base with `codex/ab-g3-tee-family` |
| `2ecfaf3` | extract shared.hsv knob cluster (3 knobs) | no — unrelated knob work this branch sits on |
| `9a6e4b8` | phase-3 sign-off sweep — 4 stragglers into g4.scoring | no — unrelated; named "target base" in the MEP |
| `1255ed4` | task: hand off G3 intact tee family port | yes (task card only) |
| `45e9b80` | port G3 intact tee-family as deviation ABFeature | yes — the algorithm |
| `46ecd75` | finish G3 tee-family evidence contract | yes — trace rewrite |
| `936a6be` | complete G3 rejected-frame trace | yes — trace completion |

The task brief said "4 unpushed commits". That is accurate **for the tee-family work specifically** — `1255ed4`, `45e9b80`, `46ecd75`, `936a6be`. The branch as a whole is 6 commits ahead of its remote (`origin/codex/ab-g3-intact-tee-family` = `9fe2f87`, which sits on `868431f` and predates `f05602b`); the remote and local have diverged and the remote carries only an earlier copy of the task card.

### Continuation or competitor? — CONTINUATION. Verified.

The brief asked me to check this against the commits and the `.task/` file. It checks out, three independent ways:

1. **Merge-base.** `git merge-base codex/ab-g3-intact-tee-family codex/ab-g3-tee-family` → `f05602b`. Both branches grow from the same knob-extraction base.
2. **Byte-identical algorithm.** `git diff 8c07e13:…/g3.teeFamily.ts 45e9b80:…/g3.teeFamily.ts` is **empty**, and so is the diff of `tests/unit/teeFamilyFeature.test.ts`. Commit `45e9b80` on this branch is the sibling branch's single commit `8c07e13` transplanted verbatim onto a newer base.
3. **The task card says so, explicitly.** `.task/PORT-G3-INTACT-TEE-FAMILY.md` MEP block:
   - *"Outcome: transplant the bounded G3 tee-family deviation onto target base `9a6e4b84…` without losing its `g1`, `shared.hsv`, or `g4.scoring` features."*
   - *"implementation donor `8c07e137e84670feded81634da489167b62343bd`"*
   - It even records the cherry-pick conflicts (duplicate task card, `features/registry.ts`, the resolved-config hash pin) and how each was resolved.

So `codex/ab-g3-tee-family` is **strictly subsumed**: everything in it is present here, plus two follow-up commits. There is no competing design, no forked math, no decision to arbitrate. `codex/ab-g3-tee-family` can be discarded once this is captured.

### The rebuild already has most of this — read this before doing any work

`D:/LAB/ChainSpot` **already carries this feature**, at exactly the `45e9b80` state:

- `packages/alg/src/detectors/threeFactor/features/g3.teeFamily.ts` — **byte-identical** to `45e9b80`'s version (verified with `diff -q`, exit 0).
- `packages/alg/src/detectors/threeFactor/configs/tee-family-on.json` — present.
- Wired in both `packages/alg/src/detectors/threeFactor/engine.ts` (line 22 import, line 82 in `ENGINE_UNITS`) and `features/registry.ts` (line 20 import, line 36 in `ALL_FEATURES`).
- `D:/LAB/ChainSpot/tests/unit/teeFamilyFeature.test.ts` — the `45e9b80` test file with import paths swapped (`$lib/…` → `@chainspot/alg/…`) and nothing else changed. **17 tests.**

**What is genuinely unported is the delta `45e9b80..936a6be`** — commits `46ecd75` and `936a6be` — plus 3 tests. The rebuild is missing:

- the complete rejection trace (see *Signal and evidence* below);
- the `minorRatioToleranceFactor` boundary test;
- **the entire `teeFamilyUnit OFF/ON evidence` describe block** — the only test anywhere that runs the engine unit at all, and the only assertion that the viewport coordinate alignment is correct.

That last item is the reason this document exists rather than being closed as "already done".

Upstream sources referenced throughout:
- LAB math: `codex/three-factor-dev72-lab` @ `ef2a4fc2dc4720d3647f705464342f119d5a39a5`, file `scripts/chainspot-lab/courseSweep.ts`, blob `4a4ac2e153cc0369b49b49054da42461e59718bf`.
- Recon brief: `.task/teefamily-recon-brief.md` (on this branch) — coordinator-verified, contains the verbatim LAB source.

## What it detects

UDisc draws every tee pad on a course map with the **same sprite**: a small bright outlined rectangle with a hollow middle. Read at the pixel level that gives you two things per tee — an inner hole (the "**ring**") and the bright outline blob that surrounds it (the "**frame**").

Because one renderer drew all of them, every real tee's frame on a given screenshot is close to the same **size and shape** as every other real tee's frame. A false tee — a ring-shaped hole picked up from a label box, a legend, a parking icon, a piece of app chrome — will not match that size family.

This feature exploits that. For each tee candidate it finds the smallest bright blob whose bounding box encloses the candidate's center, measures that blob, then keeps only the **largest group of candidates whose frames all agree in size with one another**. Everything else is dropped.

Plain-word glosses for the jargon it uses:
- **major / minor** — the long and short axis lengths of a blob, from PCA (principal component analysis: fit an ellipse to the blob's pixels and report its two axis lengths). These already exist on `ComponentStats`; no new math was needed.
- **log-ratio** — comparing two sizes by their *ratio* rather than their difference, then taking a logarithm so the comparison is symmetric. `|log(a/b)| <= log(1.25)` means "a and b are within 25% of each other, in whichever direction".
- **anchor / seed** — one candidate chosen as the reference; every other candidate is tested against it.
- **spread** — the total disagreement of a family, summed over its members: for each member, the three absolute log-ratios (major, minor, area) against the anchor, all added together. Lower is tighter.

## Why it exists

The LAB sweep (`courseSweep.ts`) runs five gates: `badges → baskets → tees → tee-badge → path`. Gate 3 is a hard count check:

```
const teePass = gateResult(teeFamily.length, numBadges, 'tees');
if (!teePass) hardStop('tees', `intact tee family=${teeFamily.length}, numBadges=${numBadges}; recover …`);
```

The sweep's own funnel log names the four stages it needed to get there:

```
ring candidates -> tee-rect/badge-clean -> frame-measured -> intact family:
  ringsRaw.length -> teeRings.length -> teeMeasures.length -> teeFamily.length
```

Raw `detectTeeRings` **over-produces** on a real course map. The tee-rect/badge-clean and frame-measured stages knock some of that down; the family selection is what closed the remainder to exactly `numBadges`. Without it, Gate 3 hard-stopped and no path attribution ran at all.

Two things follow from this, and both matter for a rebuild:

- The family selector was **never validated on its own**. Its acceptance criterion was always "does the resulting count equal the badge count", measured one level up. It has no independent notion of correctness.
- That count check was **deliberately not ported**. See *Thresholds* and *Known failure cases*.

## Signal and evidence

Input is entirely **shape statistics of bright-mask connected components**. No color reads, no re-sampling of pixels, no template matching.

Per tee candidate:
1. Take the candidate's center `(cx, cy)`.
2. Scan `stage.brightComponents` for blobs whose bounding box **contains that center, inclusive of the edges**, and whose size falls in a fixed window (area, bbox width, bbox height).
3. Among survivors pick the **smallest bbox by area** (`bboxW * bboxH`); tie broken by **larger blob area**. That is the candidate's frame. No survivor → the candidate is dropped as "no valid enclosing frame".

Then across all measured candidates:
4. For every measure taken as anchor, its family is every measure whose frame's `major`, `minor`, and `area` all sit inside the log-ratio tolerances of the anchor's frame.
5. Keep the family with the **most members**; tie broken by **minimum spread**.
6. Output sorted by ring `cy`, then ring `cx`.

**The pixel signal that was deliberately discarded.** The LAB's `measureTee` also computed `grayStats`: over the ring's bbox, count pixels whose `max(R,G,B)` lies in `[145, 175]`, report count and fraction. This was **printed in the sweep log and nothing else** — `console.log(\`family grayCount: ${summarize(...)}\`)`. It never selected or rejected anything. The task card is emphatic: *"LAB gray payload (145 <= max(R,G,B) <= 175) was DIAGNOSTIC ONLY. It never selected/rejected this family. Do not add a gray kill rule."* The port honors this; there is no gray gate anywhere in `g3.teeFamily.ts`. **Do not reintroduce it as a filter.** If you want its telemetry back, emit it on a drawable.

**The trace (this is the unported part).** The two follow-up commits rewrote what the unit says when it drops something, because the first version lied by omission. Concretely:

- `45e9b80` (the version currently in the rebuild) computed a single `sizeEligibleCount` over *all* frames and reported either "zero components satisfy the size window" or "0 of N size-eligible components contain the ring center". Both statements can be true while telling you nothing about *this* ring — the count is global, not local to the ring.
- `46ecd75` replaced it with a per-ring analysis: filter to the components that actually **contain this ring's center**, then count how many of those failed each individual predicate (`areaBelowMin`, `areaAboveMax`, `widthAboveMax`, `heightAboveMax`). The reason string names the specific failing filters with counts. Also added full frame geometry (`frameBboxX/Y/W/H`, `frameMajor/Minor/Area`) to *every* drawable, accepted and rejected alike, via a shared `frameValues()` helper.
- `936a6be` added, for each containing-but-rejected candidate, its **own `box` drawable** with `candidateIndex` and per-predicate `fails*` flags. Before this, you could read "2 containing components rejected by area>500: 1, bboxW>50: 1" but could not see *where those two boxes were*. Now they are drawn.

That trace is not decoration. It is the exact per-decision testimony a threshold-tuning harvest needs as input — see *Regeneration notes*.

Coordinate handling (the port's flagged trap, resolved in `45e9b80`): `measure.ts`'s `makeTees` stamps `TeeEvidence.xPx/yPx` in **original-image px**, but only **Y** is shifted (`yPx = tee.cy + yOffsetPx`, `xPx = tee.cx`) because the viewport crop is vertical-only. `stage.brightComponents` are **stage-local** (pre-offset), because the badge stage runs on the cropped image. So the unit shifts each frame candidate's `bboxY` by `+ viewport.topPx` before the containment test. That is why `viewport` is a third consumed slot beyond the spec's "stage, tees" shorthand. Getting this backwards produces **zero frames for every ring** and an all-rejected G3 with a completely plausible-looking reason string.

## Thresholds and constants

All seven knobs are `frameForRing`/`selectTeeFamily` literals lifted verbatim out of `courseSweep.ts`. **None of them has a recorded derivation anywhere in either repo.** I looked: the LAB file has no comment explaining them, the recon brief calls them "spec-fixed", the task card calls them "validated" but the validation described is *schema/type* validation (`validate()` returns an error string), not empirical fitting. There is a threshold-tuning harness on `codex/heritage-g3-threshold-audit` (`tests/unit/familyTuning.test.ts` + `helpers/familyTuningHarvest.ts` + `helpers/histogramRender.ts`) but it targets **`cleanBasketFamily` (G2)**, not this feature.

| name | value | how derived | confidence |
|---|---|---|---|
| `frameAreaMin` | `10` | **UNKNOWN.** Hardcoded `c.area >= 10` in `frameForRing`. No comment, no tuning record, no fixture. | very low |
| `frameAreaMax` | `500` | **UNKNOWN.** Hardcoded `c.area <= 500`. Plausibly "a tee outline is small"; nothing states it. | very low |
| `frameMaxWidth` | `50` | **UNKNOWN.** Hardcoded `c.bboxW <= 50`. Note the LAB never had a `bboxMin`, so 1×1 blobs are eligible if area passes. | very low |
| `frameMaxHeight` | `50` | **UNKNOWN.** Hardcoded `c.bboxH <= 50`. | very low |
| `majorRatioToleranceFactor` | `1.25` | **UNKNOWN.** `Math.log(1.25)` inline. "Within 25%." Round number, no fit. | very low |
| `minorRatioToleranceFactor` | `1.25` | **UNKNOWN.** Same literal, separate use site; the port correctly split it into its own knob rather than sharing one. | very low |
| `areaRatioToleranceFactor` | `1.5` | **UNKNOWN.** `Math.log(1.5)`. Looser than the axes, presumably because area is roughly the product of two axes each allowed 25% — but 1.25² = 1.5625, not 1.5, so it is not that identity either. | very low |
| gray band lo/hi | `145` / `175` | **NOT PORTED, and must stay unported.** LAB `grayStats` diagnostic only; never gated. | n/a — do not use |
| `Math.max(x, 1)` floor | `1` | Structural guard, not a threshold: prevents `log(0)` / division by zero when a degenerate blob reports a zero axis. Preserve exactly. | high |
| `badgeInsidePadding` (upstream, `g1.badges`) | `3` | **UNKNOWN**, and it is the wrong sign vs the LAB. See failure case 1. | very low, high blast radius |
| LAB badge-interior inset (upstream, LAB only) | `7` | **UNKNOWN.** `\|x-b.cx\| <= b.bboxW/2 - 7` in `insideBadgeInterior`. Never ported. | very low |
| `elongationThreshold` (upstream, `g3.endpoints`) | `1.18` | **UNKNOWN.** Decides `tee-rect` vs `diamond`, which decides which rings become `tier: 'ring'` — i.e. which candidates this feature even sees. | very low |

Every one of these is a dataset-fit estimate at best. Per project doctrine they are the **first suspect** whenever this gate misbehaves, not the last.

## Gate placement

- **Gate:** `G3`. Feature id `teeFamily`, unit id `teeFamily`.
- **Kind:** `deviation`, `defaultEnabled: false`. Not in `DEFAULT_EXECUTION`. It only runs when an experiment config names it.
- **Consumes:** `stage` (for `brightComponents`), `tees`, `viewport` (for `topPx`). The `viewport` dependency is beyond what the original spec wrote and exists solely for the coordinate alignment.
- **Produces:** `tees` — it rewrites the slot in place with a filtered list.
- **Position:** immediately after `tees`, before `rawPairs`, so downstream pairing sees the refined list. `configs/tee-family-on.json` pins that exact order and the config's own note says *"the order IS part of the experiment"*. Execution list:

  ```
  badgeStage, badges, supportField, badgeOcclusionPatch, baskets, tees,
  teeFamily, rawPairs, measurement, assignment
  ```

- **Registration side effects:** joining `ALL_FEATURES` changed the resolved-default-config hash from `f244eb1a8e4ad26218effdadf573b24af2f6a3a4df8975dd3c48fa0f92f1de9e` to `3cf743803a06140c1ad3d5026c9852ec58ecdefbad85bec8b229bede623e7ecf` (re-pinned in `tests/unit/threeFactorConfig.test.ts`) and required regenerating `configs/threeFactor-config.schema.json`. The frozen-behavior parity fingerprint `a0a1ac828ce98f89831210896e42aeee468a5527bfe5e752ffa5bf431095396c` **did not move**, which is the correct outcome for a default-OFF feature.

**Scope rule.** Only `tier: 'ring'` tees are refined. This is not arbitrary: the LAB call site measured exclusively `kind === 'tee-rect'` rings, and `collectTeePoints` in `endpoints.ts` assigns `tier: 'ring'` to exactly `rings.filter(r => r.kind === 'tee-rect')`. So `'ring'` tier *is* the tee-rect set. `'component'` and `'recovered'` tier tees pass through **untouched**, each with an `info` drawable reading `not in family scope (tier X)`. Refining them would exceed the ported behavior.

**detId stability.** Surviving tees keep their original `detId` — no renumbering. Every drawable's `ref` is a `detId`, so renumbering would silently decorrelate the overlay. Nothing downstream (`scoring.ts`, `assignment.ts`, `makeRawPairs`) needs tee ids contiguous; they are opaque Map keys and string-joined pair ids. The refined slot is produced by **filtering** the incoming list rather than rebuilding it, which is why the surviving ring tees stay in `cy`-then-`cx` order for free: `makeTees` already sorts by `yPx, xPx, tier`, and a filter preserves the order of a sorted sequence.

## Known failure cases

**1. Candidate-set divergence at the badge exclusion — this is the trophy-basket pattern, one gate upstream. Read this first.**

The LAB and the engine disagree, *in sign*, about which rings near a badge are allowed to be tees.

- LAB (`courseSweep.ts` line 329): `insideBadgeInterior(x,y)` = `|x - b.cx| <= b.bboxW/2 - 7 && |y - b.cy| <= b.bboxH/2 - 7`. The badge box is **shrunk by 7px per side**. Only rings well *inside* a badge get killed.
- Engine (`measure.ts` `makeTees`): `insideBadge(x,y)` = `x >= b.bboxX - pad && x <= b.bboxX + b.bboxW + pad && …` with `pad = badgeInsidePadding = 3`. The badge box is **grown by 3px per side**.

Net swing: the engine's kill zone extends **10px further on every side** than the LAB's. On top of that the engine adds a `pointInScreenChrome` filter the LAB did not have.

This is precisely the catastrophic pattern this project has already been burned by: *a bounding box that is not the object's real footprint swallows a nearby true detection, and the resulting negative evidence reads as confident.* The rejected drawable even says `ring inside badge bbox (+3px pad)` — a specific, numeric, entirely trustworthy-looking string, for a tee that the reference implementation kept. An inspector reading that trace would reasonably conclude "no tee there" and go looking for the bug somewhere else.

**Consequence for anyone debugging this feature:** if enabling `teeFamily` produces too few tees, do not start with the seven family knobs. Start by counting how many `tier: 'ring'` tees exist *before* the unit runs, and compare it to the LAB's `teeRings.length` for the same course. If the input set is already short, the family selector is innocent.

**2. The frame is a bounding box, and bounding boxes lie about non-rectangular sprites.**

The "frame" is the smallest-bbox bright component whose **bbox** contains the ring center. Containment is a box test, not a shape test. So any bright blob near a tee whose *box* happens to cover the tee's center is a legal frame candidate, whatever its actual shape.

The known-catastrophic instance of this in the project — a trophy-shaped basket sprite getting a square bbox that swallows a nearby tee pad — reproduces here directly. If such a component's `area` lands in `[10, 500]` and its bbox is `<= 50×50`, it becomes the tee's frame. The tee's measured `major`/`minor`/`area` then describe **the basket, not the tee**, and the tee falls out of the size family. The smallest-bbox tie-break mitigates this (a tee's own tight outline usually has a smaller bbox than an intruding sprite's) but does not eliminate it, and provides no warning when it fires.

Symptom to watch for: a tee rejected with `excluded from winning family` whose `frameBboxW`/`frameBboxH` in the drawable `values` look nothing like a tee outline. **The `frameValues()` payload added in `46ecd75` is what makes this diagnosable at all** — the `45e9b80` version currently in the rebuild does not emit frame geometry on family-exclusion drawables, so this failure is invisible there.

**3. No minimum family size — the selector cannot fail.**

Any single measure is trivially its own family of one. If every ring on a course is junk, `selectTeeFamily` still returns a non-empty "family". The safety net was the LAB's Gate-3 count check (`teeFamily.length === numBadges`, else `hardStop`), which lives **outside** the selector and was **deliberately not ported** — the task card forbids inventing a cardinality knob here, correctly, because that check belongs to the gate, not the selector. But nothing in the rebuild currently performs it either. The feature will happily reduce a course's tees to one, silently, and the only evidence is a `dropped` measure count.

**4. Family membership is not an equivalence relation.**

Membership is an anchor-centered ball, not a clustering. Two members of the winning family can be up to **2× the tolerance** apart from each other (each within 25% of the anchor, in opposite directions → up to 56% apart). "Largest mutually-consistent family" in the commit message overstates it; it is largest *anchor-consistent* family.

**5. Exclusion reasons are anchor-relative only.**

A measure rejected from the winning family is reported with its log-ratios against **the winning anchor**. It may be perfectly consistent with some *other* anchor's family and simply have lost the size contest; the reason string will not say so. Do not read "failing major log-ratio" as "this frame is anomalous".

**6. Ties resolve by input order.**

`if (family.length > best.length || (family.length === best.length && spread < bestSpread))` — strict comparisons, so on an exact tie the **first seed encountered wins**. Deterministic for a given `tees` list, but any upstream reordering silently changes the answer. The Map iteration order of `measureByTeeId` (insertion order = `ringTees` order = `makeTees` sort order) is load-bearing.

**7. Frames include the badge components themselves.**

`stage.brightComponents` is passed unfiltered, badges and all. The LAB did the same (`badgeStage.brightComponents`), so this is faithful — but it means a badge plate can serve as a tee's frame if the size window admits it.

**8. `dMajor`/`dMinor`/`dArea` can be `NaN`.**

When `anchor` is null the deltas are `NaN` and the reason string renders `NaN` with `.toFixed(4)`. Unreachable in practice (anchor is null only when `measures` is empty, in which case the reporting loop is also empty), but it is defensive code with no test.

**9. Coordinate alignment has exactly one guard, and the rebuild doesn't have it.**

The `+topPx` shift on frame candidates is asserted only by the `teeFamilyUnit OFF/ON evidence` test added in `936a6be`. The rebuild's test file predates it. A rebuilder who flips the sign, shifts X instead of Y, or shifts the ring instead of the frame will get a green test suite and a G3 that rejects every tee with a confident, specific, wrong explanation.

## What proves it works

**Nothing on a real image. Nothing image-backed. State this plainly to anyone who asks.**

What exists:

- **20 unit tests** in `tests/unit/teeFamilyFeature.test.ts` at `936a6be`, all **synthetic** — hand-built frames and tees, no raster, no fixture, no course:
  - `findEnclosingFrame` (7): smallest-bbox tie-break, equal-bbox→larger-area tie-break, inclusive edge containment at all four bbox edges, non-containing candidate, area-over-max, width-over-max, empty candidate list.
  - `selectTeeFamily` (8): exact `<=` boundary IN for major / minor / area, just-past-boundary OUT, largest-family beats smaller regardless of spread, spread tie-break between two disjoint equal-size families, deterministic `cy`-then-`cx` output order from shuffled input, empty input.
  - Registration (3): kind/default/knob-set/defaults, `validate()` rejects non-positive and `<= 1` tolerances, `tee-family-on.json` parses and inserts `teeFamily` at exactly `indexOf('tees') + 1` and before `rawPairs` with `validateExecution` passing.
  - **Unit OFF/ON evidence (2)** — the ones the rebuild lacks: OFF preserves all four tees and emits **zero** drawables; ON keeps `['keep', 'component']`, drops one ring on the major log-ratio and one for having no valid frame, passes the component tier through with an `info` drawable, and asserts the exact numeric `values` payloads including `frameBboxY: 100` — which is the **only** assertion in the codebase that the `+topPx` shift is applied and applied to Y.
- **Green gates** as recorded in the task card: focused 4 files / 36 tests; full unit suite 20 files / 147 tests; `npm run check` 0 errors 0 warnings; `npm run build` succeeded.
- **Parity fingerprint unchanged** at `a0a1ac82…`, confirming the default path is untouched.

What does **not** exist:

- No evidence image. The LAB drew one at sweep time — `writeOverlay(outDir, 'g3-tees.png', …)`, cyan circle for family members, orange for measured-but-excluded — but it is written to a run output directory, never committed. There is no `g3-tees.png` in the repo at any commit on this branch.
- No course fixture, no truth comparison, no accuracy number of any kind.
- The task card says it outright: *"Real-image OFF/ON inclusion quality remains unknown: no deterministic local course-image runner/input was identified in this bounded implementation pass."* And of the synthetic A/B: *"This proves inclusion/exclusion mechanics, not real-course quality."*

**So: the mechanics are proven. The behavior is not.** Nobody has ever seen this feature run on a disc golf course map inside the engine.

## Regeneration notes

### What a rebuilder must get right

1. **Do not re-derive the math. Port the delta.** The pure core (`findEnclosingFrame`, `selectTeeFamily`) is already byte-identical in `D:/LAB/ChainSpot/packages/alg/src/detectors/threeFactor/features/g3.teeFamily.ts`. The work is applying `46ecd75` + `936a6be`, which touch only the `EngineUnit` body plus helpers, and porting 3 tests.
2. **Port the OFF/ON unit test first, before anything else.** It is the only guard on the coordinate alignment, the only guard on tier scoping, and the only guard that the unit is a no-op when disabled. Without it every other assertion is about functions nobody calls.
3. **Comparison operators are `<=`, everywhere.** Frame containment is inclusive of the bbox edge. Tolerance tests are `<=` against `Math.log(factor)`. A frame at exactly `1.25×` the anchor's major is **IN**. Three tests pin this; keep them.
4. **`Math.max(value, 1)` before every ratio.** Not cosmetic — it is what stops `log(0)` and division by zero on degenerate blobs.
5. **Apply `Math.log` at the use site, on the knob.** Store the knob as a plain factor (`1.25`), not as a pre-logged value. Both the trace strings and the schema depend on the factor form.
6. **The Y-only shift, on the frames, by `+viewport.topPx`.** Frames are stage-local; tees are original-image with Y already offset. Shift the frames up to meet the tees, not the other way. X is never shifted.
7. **Filter the tees list; do not rebuild it.** Preserves `detId`s (which every drawable `ref` points at), preserves the `makeTees` sort, and gives the `cy`/`cx` family order for free.
8. **Never add a gray-payload gate.** `145 <= max(R,G,B) <= 175` was telemetry. Twice-stated in the source docs, restated here.
9. **Never add a minimum family size to the selector.** The count check belongs to the gate. If you want it, put it at the gate and give it its own name and its own trace.
10. **No silent drops.** Every ring tee that leaves is reported with numeric geometry and a specific reason. A generic "not family" is explicitly insufficient per the spec — that rule is the entire point of the two unported commits.
11. **Keep it `defaultEnabled: false` and out of `DEFAULT_EXECUTION`** until real-image evidence exists. Turning it on moves the parity fingerprint, which is the intended alarm.

### What a rebuilder may freely change

- Formatting, helper decomposition, naming. Prettier reflowed most of `46ecd75`'s diff; the semantic content is a small fraction of those line changes.
- The exact wording of reason strings — as long as they stay specific and carry the numbers. The tests match on substrings (`/failing major log-ratio/`, `'area>500: 1'`) and on `values` objects; adjust both together.
- The shape of the `values` payloads, so long as frame geometry survives on **both** accepted and rejected drawables. That is what makes failure case 2 diagnosable.
- Whether `viewport` stays a consumed slot or the alignment moves upstream into `makeTees`. Making `stage.brightComponents` original-image-aligned at the source would remove the trap entirely — a legitimate and arguably better design, but it changes a shared slot's contract and needs its own parity pass.
- Splitting the four size-window knobs into a single `frameSizeWindow` object. They are four independent knobs today only because the LAB had four literals.

### The obvious next piece of work, which nobody has done

There is a ready-made template for validating these thresholds: `codex/heritage-g3-threshold-audit` carries `tests/unit/familyTuning.test.ts` + `helpers/familyTuningHarvest.ts` + `helpers/histogramRender.ts`, a **measure-first** harness that runs a feature across all four in-scope courses, harvests every decision's testimony out of the trace, cross-tags each against ground truth within a pixel tolerance, reports per-metric quartiles pooled and per course, and renders TRUE-vs-FALSE strip charts to `artifacts/sweep/family-tuning/`. It contains no assertions about thresholds — it produces the numbers and images the tuning decision is made *from*.

It targets `cleanBasketFamily` (G2). The same harness pointed at `teeFamily` would turn every "UNKNOWN" in the threshold table into a measured distribution, and produce the rendered evidence images this feature has never had.

**That harness consumes exactly the trace that commits `46ecd75` and `936a6be` add.** The `45e9b80` version in the rebuild emits a global `sizeEligibleCount` and no frame geometry on family rejections — not enough to harvest from. Porting the delta is therefore the prerequisite for ever validating the seven knobs, not a cosmetic polish pass. That is the strongest argument for doing it.

## Verdict

**Partially worth regenerating** — the math is already in the rebuild byte-for-byte, so only the trace delta (`46ecd75` + `936a6be`) and its 3 tests are actually unported; port them, because they carry the sole coordinate-alignment guard and are the prerequisite for ever measuring the seven undated, underived thresholds this feature entirely rests on.
