# tbs-badge-transit

## Source

- Branch: `codex/ab-tbs-badge-transit` (old lineage, `C:/Users/tenni/workspace/ChainSpot`).
- Local tip: `764edef875dd803e272302f460ef719d807dc601` — "fix: make badge transit lock self-contained" (2026-08-23 02:29:58 -0500).
- Unpushed commits, oldest first (3):
  - `13f63deafcdf4e481945eaaa2fce08880623a159` — "task: hand off deterministic TBS badge transit" (the brief; a rewrite of the pushed `3f33b89`, retargeted onto a newer base)
  - `a8a56731f8064b58718334d15f04c78e69d37911` — "feat: port deterministic badge transit primitive"
  - `764edef8...` — "fix: make badge transit lock self-contained"
- Base: `9a6e4b84ad089099c911b8b1b84923990aace7eb` (CHSPT-82 phase-3 sign-off sweep). Remote tip `origin/codex/ab-tbs-badge-transit` = `3f33b89`.
- **Everything is committed.** The old repo's working tree is clean and `HEAD` is on `main`. Nothing is sitting dirty; nothing is lost if the disk stays readable.
- Files unique to this branch (7 files, +311/-2 against base):
  - `src/lib/detectors/threeFactor/features/st.badgeTransit.ts` (136 lines, the whole behavior)
  - `src/lib/detectors/threeFactor/configs/tbs-badge-transit-on.json`
  - `tests/unit/badgeTransit.test.ts` (80 lines)
  - two registration lines in `features/registry.ts`, a generated block in `configs/threeFactor-config.schema.json`, one hash pin in `tests/unit/threeFactorConfig.test.ts`
- Upstream provenance of the algorithm itself: `ef2a4fc2dc4720d3647f705464342f119d5a39a5:src/lib/nuthing/fourLaneRibbon.ts` — functions `deterministicOccluderExitDistancePx` and the starting-occluder block at the top of `trackFourLaneRibbon`'s loop. **That commit is the thing worth keeping alive**; the branch is a faithful copy of two small pieces of it.

## What it detects

It does not detect anything. It is a *control rule*, not a detector, and that distinction is the whole point of the branch.

Plain version: when the path tracker starts walking a fairway from a hole-number badge, the tracker's own starting point is buried underneath that badge. The badge is opaque paint over the map — there is nothing to see there, and there never will be. So instead of letting the tracker's steering logic flail around in a region it cannot observe, this rule says: *coast*. Hold the heading you arrived with, take fixed-size steps, and do not start steering again until you have provably walked out the far side of the badge's box, plus one extra step for margin.

Glossary, since these words get used loosely elsewhere:
- **occluder** — a rectangle on the image known to be covered by something opaque (here, the hole-number badge). "Known-hidden", not "empty".
- **heading** — the direction the tracker is currently walking, in radians. `0` is +x (right); +y is down, in image coordinates.
- **lock** — the span of pixels during which the deterministic rule owns control instead of the optimizer.
- **optimizer** — the ordinary steering search that tries several candidate heading offsets and picks the best-scoring one. Suppressed during the lock.

## Why it exists

Without it, the tracker's first few steps are steered by evidence that does not exist. The badge is a solid opaque box; every cross-section sample inside it comes back hidden or garbage. Three bad things follow:

1. The heading search picks a direction from noise, and the fairway trace starts off crooked at the exact moment when the *correct* heading is already known for free (the frozen Tee→Badge pose supplies it).
2. The "evidence lost" stop condition (`failureSteps` consecutive low-score steps) can fire while still inside the badge, killing a perfectly good trace before it ever sees fairway.
3. The "occluded too long" stop condition (`maxUnknownSteps`) burns budget on a span whose hidden-ness is geometrically certain and therefore not informative.

The frozen source's own comment states the design claim directly: the badge box "is not evidence to optimize against: its hidden span is determined by the frozen Tee→Badge pose plus bbox geometry." Because both the entry pose and the rectangle are already known, the traversal is a closed-form ray-box exit — an optimizer is not merely unhelpful there, it is unnecessary.

## Signal and evidence

**Zero pixels are read.** This is pure geometry over two inputs that other stages already produced:

- tracker state: center `(xPx, yPx)`, `headingRad`, `corridorWidthPx` (carried through untouched; it plays no part in the exit calculation)
- occluder: axis-aligned bounding box `(bboxX, bboxY, bboxW, bboxH)` of the hole-number badge, from the G1 badge stage

The computation is a ray-versus-axis-aligned-box exit test:

```
if the state center is not inside the box            -> exit distance 0
dx = cos(heading), dy = sin(heading), eps = 1e-9
if dx >  eps : candidate (bboxX + bboxW - x) / dx
if dx < -eps : candidate (bboxX          - x) / dx
if dy >  eps : candidate (bboxY + bboxH - y) / dy
if dy < -eps : candidate (bboxY          - y) / dy
keep finite candidates >= 0
exit distance = max(0, min(kept))   -- or 0 if none kept
```

Containment is **inclusive on all four edges** (`>=` and `<=`). A center sitting exactly on the boundary counts as inside and yields exit distance 0, which still produces a non-zero lock of `extraLockSteps * stepPx`.

Lock length = `exitDistance + extraLockSteps * stepPx`, computed once at lock creation.

Per-step behavior while the lock is live (`remainingPx > 1e-9`):
- advance the center by exactly `stepPx` along the frozen heading
- `headingDeltaRad` is exactly `0` — typed as the literal `0`, not merely valued 0
- `countVisibleEvidenceLoss: false` and `countConsecutiveUnknown: false` — the two failure counters are explicitly told not to tick
- decrement `remainingPx` by `stepPx`, floored at 0
- when `remainingPx <= 1e-9`, ownership flips to `'optimizer'` and the primitive stops acting

The `stepPx` is captured into the lock object at creation and reused for every transition, so a caller cannot half-change the step mid-lock. That is what the third commit, "make badge transit lock self-contained," bought.

## Thresholds and constants

| name | value | how derived | confidence |
|---|---|---|---|
| `EPSILON` | `1e-9` | Floating-point guard, not a tuned quantity. Copied verbatim from the frozen source (`const epsilon = 1e-9`), hoisted to a module constant. Used for two different jobs: rejecting near-zero heading components, and testing lock exhaustion. | High — it is a numerics guard, not a dataset fit. |
| `stepPx` | `6` | Copied from the frozen four-lane tracker's `DEFAULT_FOUR_LANE_OPTIONS.stepPx: 6`. **How that 6 was originally chosen is UNKNOWN.** No derivation, sweep, or justification survives in the branch, the brief, or the frozen file. It is a dataset-fit estimate of unknown provenance. | LOW — value is faithfully copied, origin is a landmine. |
| `extraLockSteps` | `1` | **Invented by this port.** The frozen source hard-codes `+ options.stepPx` (exactly one step). The port generalizes that literal into a knob whose default reproduces frozen behavior. The frozen comment gives a rationale ("plus one complete tracker step beyond the centerline exit, before enabling search") but no measurement. **Why one and not two is UNKNOWN.** | LOW on the value, HIGH on parity — default 1 is provably byte-equal to frozen. |
| test fixture box | `(40, 40, 20, 20)`, start `(50, 50)` | Synthetic geometry chosen so the answers are exact: horizontal exit = 10, 45-degree exit = `10 * sqrt(2)`. Not a threshold; do not read it as a real badge size. | n/a |

Constants deliberately **not** ported (they live in the frozen four-lane tracker and belong to sibling branches such as `codex/ab-tbs-ribbon-primitives` / `codex/ab-tbs-orient-rails`): `headingOffsetsDeg [-18,-12,-6,0,6,12,18]`, `lookaheadSteps 3`, `maxDistancePx 600`, `failureSteps 6`, `minVisibleScore 0.07`, `maxUnknownSteps 16`, `edgeDeltaPx 2.5`, `liftReference 45`, `tangentHalfPx 4`, `tangentSamples 5`. Every one of those is an unexplained magic number too; none of them were audited by this branch.

One frozen behavior was dropped: the original clamps each locked step with `Math.min(options.stepPx, maxDistancePx - distance)` so the lock cannot overrun the tracker's total distance budget. The port has no distance-budget concept and therefore no clamp. A rebuilder composing this into a real tracker must reinstate that clamp or the lock can walk past the budget.

## Gate placement

- Gate `ST` ("Straight Test"), which the type comment records as an owner ruling sitting **between G4 and G5**. It maps to LAB registry gate 5.
- `kind: 'deviation'`, `defaultEnabled: false`. The registry throws at import time if a deviation ever defaults on, so registration cannot change frozen behavior.
- **It has no `EngineUnit` and is not in any `execution` list.** This is stated deliberately and repeatedly in the branch: the evidence board has no straight-test tracker/pose slot, so there is nothing for a unit to consume or produce. Turning the feature ON changes engine output not at all. The brief calls this "IMPLEMENTED PRIMITIVE — runtime composition intentionally deferred", explicitly not a failed port.
- Depends on: a badge bounding box from the G1 badge stage, and an incoming heading from the frozen Tee→Badge pose (G4). Depended on by: nothing, today.
- Registration cost: two lines in `features/registry.ts`, a regenerated schema block, and a bump of the resolved-config hash pin in `threeFactorConfig.test.ts` from `f244eb1a…de5e` to `a3f9689fcf79926d4bd0cfbcb60dee61f2f6858b01c2bb792c6946bd7f02e07b`. **Those hashes are dead on arrival in the rebuild** — the feature universe differs, so the rebuild will produce its own hash. Do not copy the pin.
- Note that on this branch `ST` had **no other members**; this feature creates the `ST` object in the generated schema. So does the min-required-run branch, independently. See the collision warning in Regeneration notes.

## Known failure cases

**Occlusion / bounding-box / negative-evidence callout — this behavior sits directly on top of the known catastrophic failure family, and must be read with that in mind.**

The whole primitive is driven by an *axis-aligned bounding box asserting that a region is hidden*. That is structurally the same move as the trophy-shaped basket sprite whose square bbox swallowed a nearby tee pad. The difference — and it is the thing that makes this version safe rather than dangerous — is **what the box is allowed to conclude**:

- It suppresses *steering and failure counting* inside the box. It never converts hidden pixels into a miss. `countVisibleEvidenceLoss: false` and `countConsecutiveUnknown: false` are the explicit statement that hidden is not negative. The frozen comment says the same thing: "Known-hidden/partial pixels are neutral."
- It never deletes, patches, or rewrites pixels. `badgeOcclusionPatch` (an existing, separate unit in `measure.ts`) does pixel work; this one constrains control only. Do not merge them.

The failure modes that remain are all "the box is wrong, and being wrong is now expensive":

1. **Over-large badge box → blind march through real evidence.** If the badge bbox is inflated (padding, merged digit components, a badge whose box happens to overlap a tee pad or the start of the fairway), the tracker coasts blind through pixels it could have used, on a heading it never re-checks. The failure is silent: no rejection, no reason, no drawable — the trace simply comes out committed to a stale heading.
2. **Bad incoming heading is amplified, not corrected.** The lock's entire premise is that the entry pose is trustworthy. If the Tee→Badge pose is wrong by a few degrees, the primitive faithfully protects that error for `exitDistance + stepPx` pixels and hands the optimizer a starting point further from truth than where it began.
3. **Boundary-inclusive containment.** A center exactly on the box edge counts as inside, giving exit distance 0 and a lock of one bare step. Harmless in the frozen usage, but a rebuilder who changes containment to exclusive will silently drop that step and move behavior.
4. **Heading freeze is a caller obligation, not an enforced invariant.** `advanceKnownBadgeTransit(state, lock)` takes state and lock as separate arguments and copies whatever heading the caller hands in. A caller who mutates the heading between transitions gets a "deterministic" transit that is not. Nothing in the primitive catches this.
5. **No distance-budget clamp** (see Thresholds). The lock can overrun a tracker's `maxDistancePx`.
6. **Concave or rotated occluders are not representable.** Real badges are round-ish; the box over-claims at the corners. Only the axis-aligned rectangle case is modelled.
7. **Degenerate boxes are unguarded.** Zero or negative `bboxW`/`bboxH` are not validated. Nothing crashes, but containment becomes nonsense.

## What proves it works

- `tests/unit/badgeTransit.test.ts`, four tests, all on synthetic geometry:
  - horizontal exit = 10, 45-degree exit = `10*sqrt(2)`, already-outside = 0
  - the regression the brief demanded: start `x=50` inside `x=40..60`, heading right, step 6, `extraLockSteps=1` → the deterministic transitions are exactly `56, 62, 68`, each with `controlOwner: 'badge-transit'`, `headingDeltaRad === 0`, and both failure counters false; the *fourth* call returns `controlOwner: 'optimizer'`
  - lock self-containment: `stepPx: 7` gives `{remainingPx: 17, stepPx: 7}` at creation, `57` after one advance, `{remainingPx: 10, stepPx: 7}` after
  - config validation: the ON config parses to `{enabled: true, knobs: {stepPx: 6, extraLockSteps: 1}}`; `stepPx: 0` and `extraLockSteps: 0.5` both throw
- Transcription fidelity: I diffed `deterministicOccluderExitDistancePx` against `ef2a4fc:fourLaneRibbon.ts` line by line. It is **byte-identical** apart from type renames and hoisting `epsilon` to a module constant. The lock block is faithful apart from the dropped `maxDistancePx` clamp and the `extraLockSteps` generalization.
- Repository gates the brief claims passed: focused unit tests, full unit suite, `npm run check`, `npm run build`, with the behavioral parity pin unchanged.
- **Evidence images: NOTHING.** No rendered evidence image, no course fixture, no real screenshot ever exercised this code. Every test input is a hand-written rectangle. There is no accuracy claim attached to this branch, which is the honest reason there is no image — but it also means nobody has ever seen this rule run on an actual UDisc map.

## Regeneration notes

Must get right:

- The exit formula exactly as written, including: inclusive containment on all four edges, the `else if` structure (a heading component within ±1e-9 of zero contributes **no** candidate rather than an infinite one), the `>= 0` finite filter, and `max(0, min(...))` with a `0` fallback when nothing survives.
- Lock length = `exitDistance + extraLockSteps * stepPx`, computed **once**, and `stepPx` captured into the lock so a mid-lock config change cannot desync the transitions.
- The three negative-evidence guarantees, which are the actual product of this branch: heading delta exactly zero, visible-evidence-loss counter not incremented, consecutive-unknown counter not incremented. If a rebuild keeps only one thing from this file, keep these.
- Exhaustion test is `remainingPx <= EPSILON`, not `<= 0` and not `< stepPx`.
- Keep the `50 → 56 → 62 → 68 → optimizer` regression verbatim. It pins the off-by-one at the handoff boundary, which is the only interesting decision in the whole file.
- Default `extraLockSteps = 1` must reproduce frozen exactly. Changing that default is changing frozen behavior.

Free to change:

- Naming, module layout, and the return-type shape. The discriminated union on `controlOwner` is a reasonable design but not load-bearing.
- Whether `extraLockSteps` stays a knob at all — inlining `+ stepPx` is equally faithful.
- **`stepPx` ownership.** The feature note says outright that it is a *temporary* owner of `stepPx` and should hand it to the registered straight-test tracker when one exists. I checked: neither the old-lineage `st.fourLaneSensor` nor the rebuild's `packages/alg/src/detectors/threeFactor/features/st.fourLaneSensor.ts` declares a `stepPx` knob, so ownership is still uncontested — but in the rebuild the right answer is probably a shared ST tracker knob, not a per-feature one.
- Whether to register it as a feature at all before a tracker exists. Registering a behavior that provably cannot run costs a config-hash bump and buys an entry in the schema. Deferring registration until the tracker seam lands is defensible.

Collision warning for the rebuild: this branch and `codex/ab-tbs-min-required-run` both (a) add the first-ever `ST` object to the generated schema, (b) append one import + one array entry at the same spot in `registry.ts`, and (c) rewrite the same resolved-config hash pin line to different values. In the old lineage these two branches conflict textually with each other and with every sibling `codex/ab-tbs-*` branch. In the rebuild, generate the schema and re-pin the hash **once**, after all ST features are registered.

When it is composed into a real tracker, the ABFeature contract's "no silent drops" rule applies: if the lock ever causes a candidate to be abandoned, that has to surface as a rejected drawable with a reason, not as an empty result.

## Verdict

**Worth regenerating.** It is ~40 lines of exact, verified-faithful ray-box geometry plus three explicit "hidden is not negative" guarantees; the guarantees are the kind of thing that gets silently lost in a rewrite and then costs a week, and the frozen source it came from is the real asset — but do not carry the `stepPx = 6` magic number across without re-deriving it.

---

# tbs-min-required-run

## Source

- Branch: `codex/ab-tbs-min-required-run` (old lineage, `C:/Users/tenni/workspace/ChainSpot`).
- Local tip: `833db40d5bae0b8ad606876f18812779db2b9708` — "CHSPT-82: add minimum required run primitive" (2026-08-23 02:35:57 -0500).
- Unpushed commits, oldest first (2):
  - `580d8f93abd58fa92736a9e3b3523eee2205db7a` — "task: hand off contiguous rail-run primitive" (the brief; a rewrite of pushed `41bb541`)
  - `833db40d…` — the implementation
- Base: `9a6e4b84ad089099c911b8b1b84923990aace7eb`, same as the transit branch. Remote tip `origin/codex/ab-tbs-min-required-run` = `41bb541`.
- **Everything is committed.** Nothing dirty.
- Files unique to this branch (7 files, +338/-2 against base):
  - `src/lib/detectors/threeFactor/features/st.minRequiredRun.ts` (111 lines)
  - `src/lib/detectors/threeFactor/configs/tbs-min-required-run-on.json`
  - `tests/unit/minRequiredRun.test.ts` (122 lines — longer than the implementation)
  - the same three registration/generated touch points as the transit branch
- **Provenance is different in kind from the transit branch, and this matters.** The brief states it outright: this is a **SPECIFICATION-DERIVED new primitive**, not a port. There is no frozen source commit. Repository study notes motivated it; the producer that generated the motivating numbers **could not be found**, and the numbers were never reproduced.

## What it detects

Whether a proposed line across the map is backed by *one continuous stretch* of supporting samples, rather than by a scattering of lucky hits that happen to average well.

Plain version: to decide "is there a fairway edge along this line", you walk the line taking samples at fixed spacing and ask each one "does this look like an edge?". The naive test is "enough of them said yes". That test passes on `yes / no / yes / no / yes`, which is not an edge — it is noise. This primitive measures instead the **longest unbroken run** of yes-samples, converts it to physical pixels, and compares it to a required minimum.

Glossary:
- **rail** — one of the long edges of the fairway corridor.
- **sample** — one probe at one position along the proposed line.
- **tri-state qualification** — each sample is `true` (qualifies), `false` (visibly does not), or `'unknown'` (hidden behind something; we genuinely cannot tell).
- **definite run** — an unbroken stretch of `true` samples. Both `false` and `'unknown'` end it.
- **span** — physical length of a run: `(sampleCount - 1) * sampleSpacingPx`. A single sample spans **zero** pixels.

Deliberately, emphatically, it does **not** decide what makes a sample qualify. The caller supplies already-judged samples. The brief says so twice: "This feature MUST NOT define edge/material qualification; other TBS sensors own that."

## Why it exists

Two motivations, of very different evidential quality.

The concrete one, and the honest one: the old four-lane sensor averages `tangentSamples = 5` probes over a window of only `±4px`. That is a ~8px window; averaging over it lets `good / junk / good / junk / good` score positively. An average cannot distinguish "a real edge" from "noise that averaged out nicely" at that scale. A run test can.

The quantitative one, which must be treated as unverified: the brief carries a table of held-out median AUC figures said to show separation improving with longer contiguous spans. It also states, in the same document, that the raw producer was not found and the numbers were not reproduced. They are historical claims. The brief's own instruction is "these numbers motivate the primitive; do NOT hard-code 24px as truth."

## Signal and evidence

**Zero pixels are read.** The input is an ordered array of `{ qualifies: true | false | 'unknown' }`. Everything pixel-facing is the caller's job.

Single forward pass, no allocation beyond the result:

- `true` → extend the current run; if it started a new run, record its start index and increment `definiteRunCount`; if the run is now **strictly longer** than the best seen, it becomes the best
- `'unknown'` → increment `unknownCount`, end the current run
- `false` → increment `visibleFalseCount`, end the current run

Returns: `longestRunPx`, `longestRunSampleCount`, `passes`, `startIndex`, `endIndex`, `sampleCount`, `qualifyingCount`, `visibleFalseCount`, `unknownCount`, `definiteRunCount`. Indices are `null` when no run exists.

Three semantics carry the actual design content:

1. **`longestRunPx = (bestCount - 1) * sampleSpacingPx`.** Span between sample *centers*, not swept width. One sample spans 0px. This is why a zero threshold still requires at least one qualifying sample: `passes = bestCount > 0 && longestRunPx >= minRequiredRunPx`, and the `bestCount > 0` clause is what makes empty input fail even at threshold 0.
2. **Earliest tie wins.** Replacement happens only on `currentCount > bestCount` (strict). Equal-length runs keep the earlier start. This is a determinism guarantee, not an accident.
3. **`'unknown'` breaks a run but is counted separately from `false`.** No bridging. The brief is explicit that bridging, if ever wanted, must be its own knob and its own decision — the default transcription refuses to guess.

## Thresholds and constants

| name | value | how derived | confidence |
|---|---|---|---|
| `sampleSpacingPx` | `3` | "the experiment used 3px for the run study". A study setting, not a measured optimum. **No derivation is recorded and the study's raw output could not be located.** Dataset-fit estimate of unknown provenance. | LOW |
| `minRequiredRunPx` | `0` | **Deliberately inert.** Zero means "any single qualifying sample passes", i.e. the primitive is a no-op gate at its default. Chosen so registration cannot change behavior, not because 0 is a good threshold. The study swept effective spans `0, 6, 12, 18, 24`. | HIGH that 0 is the right *default*; the *useful* value is UNKNOWN and must be swept on real data. |
| study span sweep | `0, 6, 12, 18, 24` px | The set of effective spans the historical quick-pass evaluated. With `sampleSpacingPx = 3`, these correspond to runs of 1, 3, 5, 7, 9 samples. | Medium as a search range; carries no claim about which value is right. |
| held-out median AUC, composite residual | `.655 / .717 / .742 / .756 / .767` at spans `0/6/12/18/24` | **UNREPRODUCED HISTORICAL CLAIM.** The brief states the raw producer is unavailable. Nothing in the repository regenerates these. | **Treat as folklore.** Do not cite as a result. |
| held-out median AUC, edge | `.577 / .670 / .748 / .771 / .794` at spans `0/6/12/18/24` | Same. Unreproduced. Note the shape: the edge feature gains far more from longer spans than the composite residual does, and overtakes it at 12px. That *shape* is the interesting part and is also unverified. | **Treat as folklore.** |
| `tangentSamples` / `tangentHalfPx` | `5` / `4` | The four-lane sensor's existing averaging window that this primitive argues against. Not owned here; listed because the motivation depends on them. | Values confirmed in `st.fourLaneSensor.ts`; their own derivation is UNKNOWN. |
| test knobs | `sampleSpacingPx: 3, minRequiredRunPx: 6` | Chosen so a 3-sample run lands exactly on the boundary. Fixture, not threshold. | n/a |

Knob validation: `sampleSpacingPx` must be positive and finite (rejects `0` and `Infinity`); `minRequiredRunPx` must be non-negative and finite (rejects `-1` and `NaN`).

## Gate placement

- Gate `ST` ("Straight Test", between G4 and G5, LAB gate 5). `kind: 'deviation'`, `defaultEnabled: false`.
- **No `EngineUnit`, not in any `execution` list, no runtime consumer.** Same posture as the transit branch and for the same reason: no straight-test candidate seam exists. The tests assert this positively — resolving the ON config leaves `execution` byte-equal to `DEFAULT_EXECUTION`.
- Depends on: nothing. It is a pure function over an array the caller builds.
- Would be depended on by: whichever ST sensor eventually decides rail qualification — that sensor calls this to convert its own tri-state judgements into an accept/reject.
- Registration bumps the resolved-config hash from `f244eb1a…de5e` to `df729adf77896fa00159d2c74347b5b719b77b9d2912e74e5930885b81c1e37d`. **Dead pin in the rebuild** — the feature universe differs. Do not copy it.
- The shipped `tbs-min-required-run-on.json` sets `minRequiredRunPx: 0`, so the "on" experiment config turns the feature on **at an inert threshold**. It proves config plumbing, not behavior. Anyone treating it as a live experiment config will measure nothing.

## Known failure cases

**Occlusion / negative-evidence callout.** This primitive gets the hidden-versus-absent distinction *right at the reporting layer and conservative at the decision layer*, and a rebuilder needs to understand both halves:

- Right: `'unknown'` is never folded into `visibleFalseCount`. A caller can always see how much of a rail was hidden versus how much was actually looked at and rejected. Hidden evidence is never reported as a miss.
- Conservative: `'unknown'` nevertheless **ends** the run. A rail that is real but crosses an occluder gets chopped into two sub-threshold halves and fails. This is a deliberate no-guess default, and it is the correct default — but it is a real false-negative source, and it is exactly the shape of the known catastrophic failure.

**The compound failure to watch for, spelled out:** combine an over-large badge or basket bounding box (which marks more samples `'unknown'` than are truly hidden) with a run threshold tuned on clean data, and you get "no rail here" produced *entirely by a fat rectangle*. Nothing about the pixels changed; a bbox got greedy and a real edge fell under the minimum. That is the trophy-basket-square-swallows-the-tee-pad failure transplanted onto rails. If a rebuild ever wires this to a real rejector, the bbox-inflation sensitivity must be measured before the threshold is trusted.

Other failures:

1. **A zero threshold is a no-op gate.** At the shipped default the primitive rejects nothing except empty input. Easy to register, forget, and later believe is protecting you.
2. **No absolute-position input.** Samples are assumed uniformly spaced; span is derived from index arithmetic alone. Non-uniform sampling silently produces a wrong physical span. The brief's input sketch mentioned `(positionPx, qualifies)`; the implementation kept only `qualifies`.
3. **Longest-run-only.** Two 5-sample runs separated by one miss report as a 5-sample run, discarding the fact that 10 of 11 samples qualified. Genuinely stronger evidence than one 5-run scores identically. Whether that is right is untested.
4. **Threshold transfer is unvalidated.** `sampleSpacingPx` and `minRequiredRunPx` interact multiplicatively; changing spacing silently rescales what a given `minRequiredRunPx` means in samples. Nothing warns about this.
5. **No rejection instrumentation exists yet.** The brief requires that any integrated rejector show measured longest run and required minimum in the drawable reason — the ABFeature contract's "no silent drops" rule. The primitive returns everything needed for that, but nothing renders it, because nothing calls it.

## What proves it works

- `tests/unit/minRequiredRun.test.ts`, eight tests. They are good tests and they are the most valuable artifact on this branch:
  - scattered `T F T F T` fails while contiguous `T T T F F` passes, with **identical qualifying counts** — the exact motivating case, pinned
  - exact boundary: 3 samples at 3px spacing = 6px, passes a 6px minimum
  - one visible miss splits a run: `visibleFalseCount: 1, unknownCount: 0, definiteRunCount: 2`
  - `'unknown'` behaves identically for run-breaking but reports `visibleFalseCount: 0, unknownCount: 1` — the hidden-is-not-a-miss guarantee, pinned
  - one qualifying sample spans 0px and passes a 0 threshold
  - empty input fails even at threshold 0, with a full exact-equality assertion on every returned field
  - equal longest runs keep the earliest start, and repeat runs are equal (determinism)
  - knob validators reject `0`, `Infinity`, `-1`, `NaN` at the right places
- Claimed gate results from the brief: focused 25/25, full unit suite 136/136, `npm run check` clean, `npm run build` succeeded, parity pin untouched.
- **Evidence images: NOTHING.** No fixture, no course, no rendered evidence, no real sample stream. Every test input is a hand-typed array of booleans.
- **The AUC numbers are backed by NOTHING** that survives on this disk. The brief says so itself: "no raw quick-pass producer was found"; "No AUC value was reproduced". If those figures ever get quoted in the rebuild as a result rather than as folklore, that is a fabrication.

## Regeneration notes

Must get right — all four are semantics, none are code:

1. `longestRunPx = (N - 1) * sampleSpacingPx`. Centers, not swept width. One sample = 0px.
2. `passes = bestCount > 0 && longestRunPx >= minRequiredRunPx`. The `bestCount > 0` clause is load-bearing: without it, empty input passes a zero threshold.
3. Tri-state, not boolean. `'unknown'` breaks a run and is counted separately from `false`. No bridging by default; if bridging is ever added it is a separate, explicit knob.
4. Strict `>` for best-run replacement, so the earliest of tied runs wins. Determinism.

Also carry: return start/end indices and the four counts, so a rejection can name its own reason. And carry the whole test file — it is the specification, and it is longer than the implementation for good reason.

Free to change — essentially all of it:

- The implementation is a textbook longest-run scan. Re-derive it rather than porting it; it is faster to write than to review.
- The result shape, naming, whether it is a registered ABFeature at all before a consumer exists.
- **`minRequiredRunPx`, absolutely.** Sweep it on real data in the rebuild. `0` is inert, `24` is folklore, and the whole point of the branch is that this number should be measured. Per this project's own standing rule, treat it as the first suspect when an ST gate misbehaves.
- Whether span should be measured center-to-center or swept (`N * spacing`). The `(N-1)` choice is defensible and consistently tested, but it is a choice, and changing it shifts every threshold by one spacing unit.
- Consider adding absolute sample positions so non-uniform sampling stops being silently wrong.

Rebuild collision warning: identical to the transit branch — both add the first `ST` schema object, both append to `registry.ts` at the same line, both rewrite the same hash pin to different values. Register all ST features first, then generate the schema and re-pin the hash once.

Do **not** carry the AUC table forward as a result. If it is carried forward at all, carry it labelled as an unreproduced historical claim, exactly as the brief labelled it.

## Verdict

**Partially worth regenerating** — the ~40 lines of run-length code are faster to rewrite than to port, but the four semantics (span is `(N-1)*spacing`, hidden is not a miss, no bridging, earliest tie) and the test file that pins them are genuinely worth keeping; the AUC numbers that motivated the whole thing are unreproduced and must not be carried forward as evidence.
