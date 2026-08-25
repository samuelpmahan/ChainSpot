# g2-clean-basket-family — intact-basket family filter at G2

## Source

Old lineage only: `C:/Users/tenni/workspace/ChainSpot`, branch `codex/ab-g2-clean-basket-family`.
Seven commits, **all committed** — the working tree is clean and checked out on `main`, so nothing about
this work is sitting dirty. Read-only access confirmed the branch never touched anything outside the files
listed below.

| sha | date | subject |
|---|---|---|
| `9536cf8` | 2026-08-23 | task: hand off clean basket family port |
| `3169c93` | 2026-08-23 | threeFactor: add clean basket family experiment config |
| `4ca8684` | 2026-08-23 | threeFactor: register clean basket family feature |
| `8f40958` | 2026-08-23 | threeFactor: register clean basket family unit |
| `c8a4e8b` | 2026-08-23 | threeFactor: port clean basket family feature |
| `f8b5976` | 2026-08-23 | test: validate clean basket family evidence |
| `2e25d28` | 2026-08-23 | fix: enforce exact clean basket evidence |

**Base.** These sit on `9a6e4b8` (`CHSPT-82: phase-3 sign-off sweep`), which is itself unpushed work on top
of `main` at `a81ea40`. So the seven commits above are unpushed, *and* their whole 20-odd-commit CHSPT-82
foundation is unpushed too. Merge-base with `main` is `a81ea40`.

**The pushed branch of the same name is a different, worse thing.** `origin/codex/ab-g2-clean-basket-family`
tips at `578a1e2` and has fully diverged — no commit is shared with the local branch. The local branch is a
deliberate *reconstruction* onto the correct base. The task card records why the remote copy was abandoned:
it was built on merge-base `f05602b` (wrong base, so its diff carried unrelated drift), it carries two no-op
marker commits (`11d8ec3` "test", `578a1e2` "cleanup accidental marker file"), and its code had two
substantive bugs — it set `bboxTolerancePx` to `0` instead of the source `2`, and it anchored template
coverage at the **sprite origin** rather than the selected component bbox. **Do not regenerate from the
remote branch.** If only the pushed history survives a machine reset, treat it as a decoy.

**Upstream source this was ported from.** `origin/codex/lab-smart-basket-finish` = `46384be`,
file `src/lib/nuthing/smartBasket.ts`, blob `8bc3e02d80a6a84d40984a8dbab6770bb09cd0bd`. Clean-family
defaults are around source lines 88–105, shape-local helpers 150–235, the clean pass 420–468. That blob is
reachable by sha even if the branch disappears. The port is a faithful transcription of the *clean tier
only*; everything else in `smartBasket.ts` (black consensus, seed search, occlusion recovery, dedupe,
confidence tiers, semantic tip) was deliberately excluded.

**Files.**

| file | change |
|---|---|
| `src/lib/detectors/threeFactor/features/g2.cleanBasketFamily.ts` | new, 382 lines — the whole feature |
| `src/lib/detectors/threeFactor/features/registry.ts` | +1 line, register the A/B feature |
| `src/lib/detectors/threeFactor/engine.ts` | +1 unit in `ENGINE_UNITS`; `DEFAULT_EXECUTION` untouched |
| `src/lib/detectors/threeFactor/configs/clean-basket-family-on.json` | new opt-in experiment config |
| `src/lib/detectors/threeFactor/configs/threeFactor-config.schema.json` | regenerated (+60 lines) |
| `tests/unit/cleanBasketFamily.test.ts` | new, 290 lines, 10 tests |
| `tests/unit/threeFactorConfig.test.ts` | one line — resolved-config hash re-pin |
| `.task/PORT-G2-CLEAN-BASKET-FAMILY.md` | the handoff card, quoted throughout this spec |

Resolved default-config hash moved `f244eb1a…` → `2422316766af51029e08f222da12becb1a10d4b486d80371fea48831624aa2dd`.
The frozen behavioral projection hash stayed at `a0a1ac828ce98f89831210896e42aeee468a5527bfe5e752ffa5bf431095396c`
— which is the actual proof that default-OFF changes nothing.

A sibling branch `codex/tune-clean-basket-family` exists but contains no clean-family code (grep finds
nothing); it is a CHSPT-82 lane plus a generic tuning harness.

## What it detects

It does not find baskets. It **judges baskets that have already been found** and throws away the ones that
do not look like a clean, unobstructed drawing of the standard basket icon.

UDisc draws every basket with the same fixed 42-pixel-wide by 66-pixel-tall bitmap — no rotation, no
scaling. When nothing overlaps it, the white pixels on screen are an exact copy of that bitmap, and the
map's dark background wraps all the way around it. This feature asks five questions about each candidate:

1. Is there a single blob of connected white pixels sitting essentially exactly where the candidate says
   the basket is? ("Connected" = pixels touching each other, including diagonally.)
2. Is that blob 42×66, give or take 2 pixels?
3. Does the blob have about the right *number* of white pixels — not more (something else bled into it),
   not fewer (something is covering part of it)?
4. Do the white pixels land in the right *places*? Lay the reference bitmap over the blob and count how
   many of the bitmap's white positions are actually owned by this blob.
5. Is the blob surrounded by dark map, and is that surrounding dark all one continuous region rather than
   scattered specks?

Pass all five and the candidate survives as an "intact basket family member." Fail any one and both the
sprite and its matching basket record are deleted, with a reason string carrying the failing number.

"Family" here means renderer family: things drawn by the same UDisc sprite renderer, at the same size, in
the same unmodified way.

## Why it exists

The baseline G2 basket detector (`baskets` unit → `matchBasketSprites`) is a matched filter scoring
`onFrac − offFrac`. That score is explicitly designed, per the comment in `endpoints.ts`, to separate
"half-occluded" from "worse-occluded" — not to separate occluded from clean. So the baseline candidate list
mixes pristine baskets with smeared, partly covered, and partly bled-together ones, and downstream gates
have no way to tell which is which.

The upstream `smartBasket.ts` solved this by sorting baskets into confidence tiers, of which `clean-family`
is the top one. The port deliberately lifted **only** that tier so the tier can be A/B'd and justified on
its own, rather than shipping a 700-line multi-tier rewrite as one un-evaluable blob. The two occlusion
recovery tiers were left as separate future features.

So: it exists to promise "these specific baskets are certainly correct," not to find more baskets. It is
purely subtractive.

## Signal and evidence

Inputs come off the evidence board: `stage` (the G1 `badgeStage` HSV product — `brightMask`, `darkMask`,
`brightLabels`, `brightComponents`), `sprites` (G2 matched-filter hits, in cropped/local coordinates),
`baskets` (the same hits as evidence records, in original-image coordinates), and `viewport` (`topPx`).

The reference template is the committed `assets/basket-sprite.json`: 42 wide, 66 tall, 66 rows of `0`/`1`.
**1746 of its 2772 bbox pixels are `1`.** That is 63% — the bounding box is 37% not-basket. Hold that
number; the next section depends on it.

Per sprite:

**Alignment (port plumbing, not source math).** Filter `brightComponents` to those whose bbox top-left is
within `positionTolerancePx` of the sprite's `(x, y)` in both axes. Sort by Euclidean distance from the
sprite origin, tie-break on lowest `label`. Take the first. None → reject with
`no isolated bright component aligned within Npx of sprite`.

The upstream source did not need this: it iterated bright components directly and never had a sprite to
reconcile against. The port has to bolt a component-first algorithm onto a sprite-first pipeline, so it
invents this alignment step. The task card is explicit that this is plumbing, not ported math.

**Size candidacy.** `|compW − 42| ≤ bboxTolerancePx` and `|compH − 66| ≤ bboxTolerancePx`.

**Area ratio.** `component.area / 1746` (the template's white count, not its bbox area), required in
`[areaRatioMin, areaRatioMax]`. Too low = pixels missing (something covers the basket). Too high = extra
pixels (something bright merged into the blob).

**White coverage — the shape test.** Walk the 1746 template `1` offsets, anchor them at the *component's*
bbox top-left, and count how many land on a pixel whose `brightLabels` value equals this component's own
label. Divide by 1746. **Returns a hard `0` unless `compW === 42 && compH === 66` exactly** — the ±2
tolerance is only a preliminary candidacy screen, never a licence to measure a mis-sized blob.

**Dark shell.** Take the component's *actual labeled pixels* (not its bbox), copy them into a local buffer
padded by `shellRadiusPx`, and dilate with an 8-neighbour kernel for `shellRadiusPx` iterations. The shell
is dilated-minus-body. `darkShell` = fraction of shell pixels that are set in `darkMask`. `darkCoherence` =
the largest single dark connected component's share of those dark shell pixels. Dark components come from
`extractComponents(stage.darkMask)`, recomputed inside this function on every call.

**Emitted evidence.** Every decision — accepted or rejected — produces an overlay box in original-image
coordinates (component bbox with `viewport.topPx` added back, or the sprite origin plus template size when
no component aligned), a verdict, a human reason string with the failing number formatted to three
decimals, the basket's `detId` as `ref`, and measured values for `spriteScore`, `areaRatio`,
`whiteCoverage`, `darkShell`, `darkCoherence`, `componentDx`, `componentDy`. Plus `inputCount`,
`acceptedCount`, `rejectedCount`.

### Occlusion, bounding boxes, and negative evidence — read this before touching anything

This feature sits on top of exactly the failure mode the project has already been burned by, and the
handoff card carries a **user correction** about it in so many words: *"basket evidence is the rendered
template/component shape. Never count the whole 42×66 bounding box as white basket pixels."*

Three concrete traps:

1. **The bbox is 37% lies.** 2772 bbox pixels, 1746 basket pixels. If white coverage were measured over the
   bbox instead of the template shape, you would over-claim by 59% and assert ownership of 1026 pixels of
   surrounding map. A tee pad rendered next to a basket lives in exactly those pixels. That is the
   "square swallows the tee pad, inspector concludes no tee here" scenario, verbatim. Both the coverage
   loop and the dilation shell in this port operate on labeled pixels only; the bbox is used solely to
   choose a scan window and to anchor the template. Any rebuild that "simplifies" this to a bbox rectangle
   reintroduces the catastrophe.
2. **The pushed remote version already made a version of this mistake** — it anchored coverage at the
   sprite origin instead of the component bbox, with `bboxTolerancePx = 0`. Same family of error: measuring
   over a rectangle that is not the object.
3. **Rejection here is a deletion, not an annotation.** The unit calls `board.set('sprites', kept)` and
   filters `baskets` to match. A rejected basket is gone. Its reason string says "not intact," but every
   downstream consumer just sees absence — which reads as "no basket here." Since the two occlusion
   recovery tiers were *not* ported, every occluded basket becomes a permanent miss the moment this feature
   is enabled. Worse, `tees` at G3 excludes tee candidates within `teeSpriteExclusionDistance` (24 px) of a
   sprite center; deleting a sprite punches a 24-pixel hole in that exclusion mask, so a phantom tee can
   spawn on top of a real, merely-occluded basket. An inspector looking at that frame sees a tee where a
   basket is and a basket that vanished — and has every incentive to blame the wrong stage.

## Thresholds and constants

Every one of the eight knobs is a dataset-fit estimate. **The upstream `smartBasket.ts` contains no comment,
no test, and no note explaining where any of these numbers came from** — I read the whole defaults block and
the surrounding file. They were transcribed, not derived. Treat all eight as first suspects.

| name | value | how derived | confidence |
|---|---|---|---|
| `bboxTolerancePx` | 2 | **UNKNOWN.** Copied verbatim from `smartBasket.ts` `DEFAULTS`. No derivation anywhere. | low |
| `positionTolerancePx` | 2 | **UNKNOWN, and not from the source at all.** Invented by this port for the sprite→component alignment step; the value appears to have been chosen by analogy with `bboxTolerancePx`. Nothing measured it. | very low |
| `areaRatioMin` | 0.96 | **UNKNOWN.** Verbatim from source. | low |
| `areaRatioMax` | 1.03 | **UNKNOWN.** Verbatim from source. Note the asymmetry (−4% / +3%) — nothing explains it. | low |
| `whiteCoverageMin` | 0.96 | **UNKNOWN.** Verbatim from source (`cleanWhiteCoverageMin`). Coincidentally equal to `areaRatioMin`; there is no evidence they are coupled and a rebuilder must not merge them. | low |
| `shellRadiusPx` | 2 | **UNKNOWN.** Verbatim from source. Doubles as dilation iteration count and window padding. | low |
| `darkShellMin` | 0.5 | **UNKNOWN.** Verbatim from source (`cleanDarkShellMin`). | low |
| `darkCoherenceMin` | 0.8 | **UNKNOWN.** Verbatim from source (`cleanDarkCoherenceMin`). | low |
| template width | 42 | Structural, from `assets/basket-sprite.json`. Not a knob. Coupled to `g2.sprite`'s `spriteWidth`, which has a validator asserting the match. | high |
| template height | 66 | Structural, same asset. | high |
| template white count | 1746 | Computed from the asset (1746 of 2772 = 63%). Denominator of `areaRatio` and `whiteCoverage`. | high |
| `teeSpriteExclusionDistance` | 24 | Owned by `g3.endpoints`, **not** by this feature — but this feature changes the sprite list that feeds it. Listed here because the coupling is invisible from either file alone. | low (inherited) |
| `defaultEnabled` | `false` | Deliberate. Every A/B feature ships off. | high |

Unnamed constants baked into the code: 8-neighbour connectivity for both dilation and component extraction;
`'1'` as the template's white marker; `Math.max(1, whiteOffsets.length)` as a divide-by-zero guard;
`` `${x}:${y}` `` as the sprite↔basket join key; three-decimal formatting in reason strings (which tests
assert on, so it is load-bearing).

**Boundary semantics are inclusive.** Rejection is strict (`ratio < min`, `ratio > max`), so a value exactly
equal to a threshold is accepted. A test pins this by feeding measured values back in as thresholds.

**One threshold is inert under defaults.** With `whiteCoverageMin = 0.96` and white coverage hard-zeroing
unless dimensions are exactly 42×66, `bboxTolerancePx` cannot change the accept set at all — a 41×66 blob
gets past the size gate and is then rejected at coverage `0.000`. `bboxTolerancePx` only changes *which
rejection reason you read*. That is a genuine trap: tuning it will look like it does nothing, and someone
will conclude the knob is broken.

## Gate placement

Gate **G2**, as a distinct engine unit (`cleanBasketFamilyUnit`) appended to `ENGINE_UNITS`.

`consumes: ['stage', 'sprites', 'baskets', 'viewport']` → `produces: ['sprites', 'baskets']`. It overwrites
its own inputs; it is a filter in place.

Execution order in `clean-basket-family-on.json`:

```
badgeStage → badges → supportField → badgeOcclusionPatch → baskets → cleanBasketFamily → tees →
rawPairs → measurement → assignment
```

It must run **after** `baskets` (G2, which produces both arrays) and **before** `tees` (G3, which consumes
`sprites`). `rawPairs` (G5) consumes `baskets`. So one rejection propagates two ways: fewer baskets into
G5 pairing, and a smaller tee-exclusion set into G3.

**It is not in `DEFAULT_EXECUTION`.** The default pipeline is unchanged; the feature only runs when the
opt-in config names it in `execution` *and* sets `gates.G2.cleanBasketFamily.enabled = true`. When
`enabled` is false the unit is a strict passthrough — it does not even re-set the board keys, so array
identity is preserved (a test asserts `toBe`, not `toEqual`).

**Coordinate seam.** `sprites` are in cropped/local coordinates. `baskets` are in original-image
coordinates with `y` shifted by `viewport.topPx`. The join key is `sprite.(x,y)` versus
`(basket.bbox[0], basket.bbox[1] − topPx)`. Overlay boxes are emitted back in original-image coordinates.
Getting this seam wrong produces a silent total mismatch, which is why the final commit added a hard
invariant.

**The 1:1 invariant.** Before doing any work, `assertSynchronizedBasketEvidence` requires: no duplicate
sprite keys, no duplicate basket keys, and exact set equality between sprite keys and basket keys. Any
violation **throws** with a key-specific message. This encodes a promise that the `baskets` unit currently
keeps, and converts a would-be silent drop into a loud crash. It is also a hard coupling: if `makeBaskets`
ever dedupes, reorders, or emits a basket without a sprite, this feature detonates the whole run.

## Known failure cases

1. **Every occluded basket is deleted, with no recovery path.** By design for the tier, but the two
   recovery tiers were not ported. Enabling this alone trades precision for total recall loss on any basket
   a badge, path, or map label touches. See the occlusion callout above for the phantom-tee knock-on.
2. **Two adjacent baskets whose bright pixels touch** merge into one connected component. Area ratio lands
   near 2.0, both are rejected. The upstream file had dedupe/consensus machinery partly for this; none of
   it came across.
3. **Bright map furniture bleeding into the basket blob** (a light path, a white label) pushes area ratio
   over `1.03` → rejected. This is not occlusion, it is adjacency, and the reason string will say "area
   ratio too high," which does not obviously point at the neighbour.
4. **Alignment mismatch rejects good baskets.** The matched filter's reported `(x, y)` and the connected
   component's bbox top-left are computed by different means and are not guaranteed to agree within 2 px.
   When they disagree, a perfect basket is rejected as "no isolated bright component aligned." This failure
   mode does not exist in the upstream source and is purely an artifact of the port's plumbing.
5. **`bboxTolerancePx` is inert under default knobs** (see thresholds). Tuning it appears to do nothing.
6. **Duplicate or unpaired sprite/basket keys crash the run.** Loud by choice, but it means this feature can
   take down a pipeline for a reason that has nothing to do with baskets.
7. **`extractComponents(stage.darkMask)` runs on the full image on every invocation**, even with zero
   sprites to judge. Wasted whole-image work inside a per-frame gate.
8. **Never run on real data.** The task card states it plainly: *"Real Dev72 OFF/ON: UNKNOWN / NOT RUN."*
   Every behavioral claim rests on synthetic masks.

## What proves it works

**Tests:** `tests/unit/cleanBasketFamily.test.ts`, 10 tests, all synthetic. Most use a 3×3 plus-sign
template (`['010','111','010']`) on a 12×12 hand-built mask as a stand-in for the real basket; one engine
fixture paints the real 42×66 template onto a 110×90 mask with two sprites (one real, one unaligned). They
cover: exact default values and validator behavior; inclusive boundary acceptance; deterministic nearest-
component selection with a label tie-break; bbox tolerance being a candidacy gate only; template-shape
coverage rather than bbox pixels; each of the six rejection reasons in source order; disabled passthrough
preserving array identity; enabled execution filtering sprites and baskets together and emitting overlay
boxes at `[10,17,42,66]` / `[60,17,42,66]` (i.e. `topPx = 7` added back); and all four 1:1 invariant
failures.

**Gates the card reports as green:** `npm run check` 0 errors / 0 warnings; `npm run test:unit` 20 files /
137 tests; `npm run build` completed with the static adapter; focused run of 4 files / 26 tests covering
the feature, generated schema, resolved config, and frozen parity.

**Config identity:** resolved default-config hash re-pinned to `2422316766af5102…`. The frozen behavioral
projection `a0a1ac828ce98f89…` is unchanged, which is the real proof that adding this feature does not move
default behavior.

**Evidence images: nothing.** No rendered overlay, no contact sheet, no annotated raster, no Dev72 fixture,
no real screenshot anywhere in the branch. Grep for the feature name returns only the seven source/test/
config files. **No accuracy number is claimed and none is backed.** Under this project's own rule — every
claimed CV number ships with a rendered evidence image — this feature has produced zero claimable numbers.
That is honest of it, but it also means enabling it on a real course is an unvalidated action.

## Regeneration notes

**Must get right:**

- Measure on the rendered shape, never the bounding box. Coverage counts template `1` positions; the shell
  dilates only pixels carrying the selected component's label. 1746 of 2772, not 2772 of 2772.
- Anchor the template at the **selected component's** bbox, not at the sprite origin, not at the image
  origin.
- Hard-zero white coverage unless the component's dimensions equal the template's exactly. The size
  tolerance is a candidacy screen, not a measurement licence.
- Inclusive thresholds: reject on strict `<` / `>`, so a value equal to the threshold survives.
- Deterministic selection: nearest by Euclidean distance, tie-break on lowest component label. Without a
  tie-break the output is component-ordering-dependent and the whole thing stops being reproducible.
- Filter sprites and baskets together in one step, or the two arrays desync and G3/G5 disagree about
  reality.
- Default OFF, and the frozen behavioral projection must not move when the feature is registered.
- Rejection reasons must carry the failing number. A reason string of "not clean" is useless when a gate
  misbehaves; "area ratio 1.084 > 1.03" points straight at the threshold.
- Record all eight numbers as UNKNOWN-derivation in whatever the new contract's knob metadata is. Do not
  let them pass as facts.

**Free to change, and probably should:**

- **The entire alignment step.** `positionTolerancePx` and the nearest-component search exist only because
  this port refines a sprite list it did not produce. A rebuild that owns G2 end-to-end should iterate
  bright components directly, exactly as `smartBasket.ts` did. That deletes an invented threshold, removes
  failure case 4, and makes the 1:1 invariant unnecessary.
- **The `` `${x}:${y}` `` string join and the crash invariant that guards it.** With a real detection id on
  both sides this is a lookup, not a fragile positional reconstruction, and there is nothing left to assert.
- **The shell implementation.** It allocates a fresh `Uint8Array` per dilation iteration and rescans the
  whole local window. Fine at 42×66, wasteful as a pattern.
- **Where dark components are computed.** Hoisting `extractComponents(darkMask)` into `badgeStage` removes
  a per-call whole-image pass.
- **Whether rejection deletes or demotes.** Deleting is the trap described above. Tagging each basket with
  a tier (`clean-family` / `unverified`) and letting downstream gates decide preserves the information and
  keeps the tee-exclusion mask intact. The upstream source used tiers for exactly this reason; the port
  flattened them into a boolean because the engine's board had nowhere to put a tier. Give it somewhere.
- **All eight numbers.** None is derived; none deserves protection.

**Do not port the occlusion tiers by copying this file's shape.** They are a different algorithm (black
consensus, seed search, visibility scoring) and need their own spec.

## Verdict

**Partially worth regenerating.** The shape-local measurement discipline, the hard-zero-unless-exact
coverage rule, the numbered rejection vocabulary, and the frozen-projection proof are all worth rebuilding
almost verbatim — they are the accumulated scar tissue from the bbox-swallows-the-neighbour failure and they
are cheap to keep. The sprite-alignment plumbing, its invented `positionTolerancePx`, its string join key,
and its crash invariant are artifacts of bolting a component-first algorithm onto a sprite-first pipeline
and should all be discarded in favor of iterating bright components directly. And since the feature has
never run on a real course, the rebuild should treat it as an untested hypothesis with eight undocumented
constants, not as working code being moved.
