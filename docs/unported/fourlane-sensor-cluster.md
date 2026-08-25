# fourlane-sensor-cluster

Three ST-gate observation primitives extracted from the Dev72 LAB: a four-lane
ribbon cross-section sensor, a course-local corridor-width calibrator, and an
orientation-preserving rail evidence sampler.

---

## Headline finding — read this before anything else

**The task premise was wrong, and the correction matters.** The three branches did
*not* independently rewrite `st.fourLaneSensor.ts`. There is exactly **one** version
of that file in existence. Authority is fully determinable and there is nothing to
adjudicate.

Evidence, in order of strength:

1. **Identical blob hash on every ref.** `st.fourLaneSensor.ts` is blob
   `7c9cf96978dbbc65d7a679b2e436e23f7ab230de`, 9650 bytes, on all three local branch
   tips *and* on `origin/codex/ab-tbs-ribbon-primitives`. Byte-for-byte identical.
   The other two origin branches do not contain the file at all.
2. **The octopus merge base of all three branches is the ribbon tip.**
   `git merge-base --octopus` of the three returns `b958dcd`, which *is*
   `codex/ab-tbs-ribbon-primitives`. Confirmed by `merge-base --is-ancestor`: ribbon
   is a strict ancestor of both siblings.
3. **The file was written once.** `git log --follow` over the file returns exactly two
   commits — `09a5509` (creation) and `8c8eed1` (knob-resolution refactor). Both sit
   on the ribbon branch, upstream of everything else.
4. **The siblings never touch it.** `git diff b958dcd <sibling>` shows each sibling
   adds its own new feature file and never modifies `st.fourLaneSensor.ts`.

### So: competing drafts or sequential refinements?

**Neither, exactly. It is a stack with one base and two parallel siblings.**

```
main a81ea40
 └─ (191 commits of CHSPT-82 knob extraction) ─ 9a6e4b8   ← "exact target base"
     └─ 56ee9e0  handoff
        └─ 09a5509 … b958dcd   codex/ab-tbs-ribbon-primitives  (200 from main)
            ├─ c99368e → 82a0aaa   codex/ab-tbs-orient-rails    (202 from main)
            └─ 723338b → … 65c9888 codex/ab-tbs-course-width    (204 from main)
```

- ribbon → each sibling is **sequential** (hard dependency; ribbon is an ancestor).
- orient-rails ↔ course-width are **parallel and non-competing**. They add different
  files, solve different problems, and do not overlap in algorithm code.
- The "13 / 11 / 9 commits" in the brief are cumulative over the same shared stack:
  9 shared + 2 orient-rails-only = 11, and 9 shared + 4 course-width-only = 13.

### Where the "three rewrote the same file" impression probably came from

Each branch has an **abandoned older push on origin** built on the *wrong* base.
All three origin tips share merge-base `868431f` with their local counterparts, not
the intended base `9a6e4b8`. The MEP notes on both siblings say so explicitly and
record that the branches were **reconstructed, not merged**:

- `origin/codex/ab-tbs-ribbon-primitives` = `8bd24c8` (doc: registry failed a
  TypeScript parse, `'}' expected. 1938`)
- `origin/codex/ab-tbs-course-width` = `63c3b07` (doc: "reconstructed rather than merged")
- `origin/codex/ab-tbs-orient-rails` = `75aab82`

A rebuilder who fetches origin will find three stale variants on a bad base. **Ignore
all three origin tips.** The local commits are authoritative.

---

## Source

All work is **committed and clean** — `git status --porcelain` is empty in all three
worktrees. Nothing is sitting dirty. All three are **unpushed relative to their
correct base**: local is ahead of origin by 16 / 14 / 12 commits, and the origin tips
are on an abandoned lineage.

| Branch | Tip | Unique commits | Worktree |
|---|---|---|---|
| `codex/ab-tbs-ribbon-primitives` | `b958dcd67b1d3d3485860dd006e420baf48de09e` | 9 (`56ee9e0`…`b958dcd`) | `…/new-chat-2/work/worktrees/ribbon` |
| `codex/ab-tbs-orient-rails` | `82a0aaafdd4424714ab03b462e57a213906d30da` | +2 (`c99368e`, `82a0aaa`) | `…/new-chat-2/work/worktrees/orient-rails` |
| `codex/ab-tbs-course-width` | `65c988894431f5b61ee65f796615952e84a5ce43` | +4 (`723338b`…`65c9888`) | `…/new-chat-2/work/worktrees/course-width` |

- Shared base of the cluster: `9a6e4b84ad089099c911b8b1b84923990aace7eb` (end of the
  CHSPT-82 knob-extraction chain). Merge base with `main` is `a81ea40`.
- Upstream algorithm source: `origin/codex/three-factor-dev72-lab` at
  `ef2a4fc2dc4720d3647f705464342f119d5a39a5`, file `src/lib/nuthing/fourLaneRibbon.ts`,
  blob `91cfc2b620e11817410d4ce98525d2e4971cc06d`.
- orient-rails additionally cites `ef2a4fc2:scripts/chainspot-lab/badge-disk-ribbon-study.md`.
- Author/date: Samuel Mahan, all commits 2026-08-23 between 01:06 and 02:46 CDT.
- Old-layout paths (do not exist in the rebuild):
  `src/lib/detectors/threeFactor/features/st.{fourLaneSensor,orientedRails,courseWidth}.ts`

---

## What it detects

Plain language first. A disc-golf hole on a UDisc map is drawn as a **ribbon** — a
long pale corridor running from the tee to the basket, with slightly brighter
**rails** (edges) on either side. These three primitives are ways of asking the
pixels "is there a ribbon here, and how wide is it, and which way does it run?"

### 1. Four-lane cross-section sensor (ribbon branch) — the base

Stand at a point, face a direction, and slice **across** the ribbon. Divide the
corridor width `W` into four equal **lanes** (a lane is just a stripe of the slice),
each `W/3` wide, with centers at exactly `[-W/2, -W/6, +W/6, +W/2]` measured
sideways from the middle. The two outer centers sit **on** the rails; the two inner
centers sit in the ribbon's interior.

For each of those four positions it asks a different question:

- **Rails (outer two):** is the pixel just *inside* the rail brighter than the pixel
  just *outside* it? That brightness difference is the "lift". A real rail lifts.
- **Inner lanes (middle two):** is the corridor interior brighter than the **ground**?
  Ground is measured by two **guard** samples placed further out, at `±2W/3`, beyond
  the ribbon entirely.

Each question returns a number in 0–1, or **UNKNOWN**. The overall cross-section
score is the **minimum** of whatever came back known — the weakest surviving piece of
evidence wins, so one strong rail cannot carry a bad reading.

### 2. Course-local width calibration (course-width branch)

Every course renders its ribbons at a slightly different width. This primitive figures
out that width **once per course**, rather than guessing per hole. Given the already-
frozen tee→basket segments, it tries eight candidate widths, walks five points along
each segment, runs the cross-section sensor at every combination, and picks the width
whose average score is highest. It is a **calibration sweep wrapped around primitive 1**
— it contains no new pixel math of its own.

### 3. Oriented rail evidence (orient-rails branch)

Same rail-lift idea, but instead of trusting a known heading it **sweeps 24
directions** and remembers *which direction* scored best, not just how well. The point
is that a scalar "best rail strength" throws away the angle, and the angle is the
useful part. It reports the winning angle as a **doubled-angle vector**
(`cos 2δ`, `sin 2δ` relative to the incoming heading) because a rail has no
front-vs-back — a line at 10° and a line at 190° are the same line, and doubling the
angle makes those two collapse to the same value, which is what you want.

It also reports whether evidence was **paired** (both rails visible), **one-sided**
(exactly one rail hidden by a badge), and which side was the visible one.

---

## Why it exists

- **The ribbon is the only continuous evidence between a tee and a basket.** Badges,
  baskets and tees are discrete sprites; the corridor is what actually connects them.
  Without a corridor sensor there is nothing to verify that a proposed tee→basket
  pairing follows a real drawn path rather than crossing blank ground.
- **Fixed corridor width was wrong per-course.** The Dev72 note records four courses
  needing 40 / 30 / 36 / 36 px. A single hardcoded width misses by up to 33%, which is
  wider than the rail lift band itself. Hence the width calibrator.
- **Scalar rail strength was a measured dead end.** The orient-rails handoff records
  an ablation: image-only macro IoU ≈ 0.695, adding scalar rail strengths ≈ 0.694 —
  flat, no gain. Preserving orientation moved it to ≈ 0.732. That null result is the
  single most useful thing in this cluster and is why the doubled-angle encoding
  exists at all. **See the evidence caveat below — this number is not reproduced here.**
- **Badges sit on top of ribbons and hide rails.** A hole-number badge is drawn over
  the corridor. Naive sampling reads the badge's pixels as "no rail". The whole
  occlusion design (next section) exists to stop that.

---

## Signal and evidence

Everything operates on raw `RgbaImage` with **gray = (R+G+B)/3**. No HSV, no blur, no
edge detector, no gradients. Nearest-neighbour sampling via `Math.round` — there is
**no bilinear interpolation anywhere**, which is a real precision limit at these small
offsets (`edgeDeltaPx` is 2.5 px and rounding quantises to 1 px).

**Band sampling (`sampleFourLaneBand`).** Given a center, a heading `h`, and a sideways
offset, it lays down `tangentSamples = 5` points spread evenly along the heading over
`±tangentHalfPx = 4` px, and averages the visible ones. Tangent `t = (cos h, sin h)`;
normal `n = (−sin h, cos h)`, so the normal points **left** of heading. A band is
UNKNOWN when `blocked * 2 >= n` (majority hidden) **or** zero samples are visible.

**Rail measurement.** Inside sample at `rail ± edgeDeltaPx`, outside at the mirror.
Left rail uses offset `−W/2` with inside-sign `+1`; right rail uses `+W/2` with `−1`.
Score is `clamp01((inside − outside) / liftReference)`.

**Inner-lane measurement.** Three sub-bands at `offset + {−laneWidth/3, 0, +laneWidth/3}`.
UNKNOWN if ≥2 sub-bands are blocked, or none visible, or ground is unknown.

**Aggregation ladder.** paired = `min(L, R)` → one-sided = the visible one → both
hidden = `null`. `innerScore = min(visible inner)`. Final `score = min(non-null of
railScore, innerScore)`, or `null`.

---

## Thresholds and constants

### Four-lane sensor (ribbon)

| Name | Value | How derived | Confidence |
|---|---|---|---|
| `edgeDeltaPx` | 2.5 | Copied verbatim from LAB `fourLaneRibbon.ts` @ `ef2a4fc2`. **Why 2.5 is UNKNOWN.** No tuning record, no sweep, no fixture. | **LOW — dataset-fit estimate, treat as landmine** |
| `liftReference` | 45 | Same. Gray-level lift mapping to score 1.0. **Derivation UNKNOWN.** Not normalized to image contrast or exposure. | **LOW — UNKNOWN** |
| `tangentHalfPx` | 4 | Same. **Derivation UNKNOWN.** | **LOW — UNKNOWN** |
| `tangentSamples` | 5 | Same. **Derivation UNKNOWN.** Interacts with the majority rule: 5 means 3 blocked ⇒ UNKNOWN. | **LOW — UNKNOWN** |
| lane count / width | 4 lanes of `W/3` | **Identity, explicitly NOT tunable** (stated in the handoff). Geometric definition. | HIGH |
| lane offsets | `[−W/2, −W/6, +W/6, +W/2]` | Identity, follows from the above. | HIGH |
| guard offsets | `±2W/3` | LAB constant. "Just outside the 4W/3 bundle." **Why 2/3 and not 3/4 is UNKNOWN.** | **LOW — UNKNOWN** |
| inner sub-band offsets | `±laneWidth/3` | LAB constant. **UNKNOWN.** | **LOW — UNKNOWN** |
| band-occlusion rule | `blocked*2 >= n` | LAB constant (majority). **UNKNOWN.** | **LOW — UNKNOWN** |
| inner-lane occlusion rule | ≥2 of 3 sub-bands | LAB constant. **UNKNOWN.** | **LOW — UNKNOWN** |
| divide guard | `1e-6` | Defensive epsilon in `max(liftReference, 1e-6)`. Not tuned. | HIGH |
| `defaultEnabled` | `false` | ABFeature contract: deviations default OFF so default config reproduces frozen dev72 byte-for-byte. | HIGH |

### Oriented rails

| Name | Value | How derived | Confidence |
|---|---|---|---|
| `orientationCount` | 24 | **SPECIFICATION-DERIVED ONLY.** The branch's own file comment says: "No raw 24-angle producer implementation was located." It came from a prose study doc, not from working code. **This is the loudest UNKNOWN in the cluster.** | **VERY LOW — never executed in its original form** |
| angle grid | `θ = i·π/24`, i=0..23 | Follows from `orientationCount`. Axial (mod π), not directional. | HIGH given the count |
| `edgeDeltaPx`, `liftReference` | 2.5, 45 | **Deliberately not forked** — passed in from `fourLaneSensorFeature`. Good hygiene, explicitly called out in the handoff. | HIGH (as a decision) |
| lift clamp | `Math.min(1, lift)` **with `lift > 0` required** | **Asymmetric with the base sensor, which uses `clamp01`.** Here negative lift disqualifies the orientation entirely rather than clamping to 0. Deliberate per the handoff ("Require both >0"). | MEDIUM — intentional but inconsistent |
| tie-break | first maximum wins (strict `>`) | Deterministic by construction; explicitly pinned by a test. | HIGH |

### Course width

| Name | Value | How derived | Confidence |
|---|---|---|---|
| `candidateWidthsPx` | `[24,30,32,36,40,48,56,64]` | LAB defaults. **Why these 8 is UNKNOWN.** Spacing is irregular (6,2,4,4,8,8,8) — looks like accreted observations, not a designed grid. | **LOW — UNKNOWN** |
| `sampleFractions` | `[0.2,0.35,0.5,0.65,0.78]` | LAB defaults. **UNKNOWN, and suspicious:** not symmetric about 0.5 — the last value is 0.78, not 0.8. Gaps are 0.15/0.15/0.15/0.13. **Strongly reads like a typo preserved verbatim from the source.** Flagged, not corrected. | **VERY LOW — probable transcription artifact** |
| no-visible sentinel | `-Infinity` | Design choice so empty rows always lose the sort. | HIGH |
| sort order | meanScore ↓, visibleSamples ↓, widthPx ↑ | Explicit determinism requirement from the handoff; pinned by test. | HIGH |
| final fallback | `40` | Last-resort literal when the candidate array is somehow empty. **Arbitrary — UNKNOWN.** | **LOW — UNKNOWN** |

---

## Gate placement

All three are **`gate: 'ST'`** (Straight Test). Per `features/types.ts`:

> Owner ruling: Straight Test (ST) sits between G4 and G5.

`GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'ST' | 'G5' | 'shared'`, and
`LAB_GATE_MAPPING[5] = 'ST'`. So the pipeline order is
G1 badges → G2 baskets → G3 tees → G4 tee→badge → **ST** → G5 path.

**The operationally critical fact: none of these three execute.** All are registered in
`ALL_FEATURES` and all are `kind: 'deviation'`, `defaultEnabled: false`. They are **not**
in the config's execution list, and no `EngineUnit` calls them. Both handoff docs state
this outright:

> enabling this registered primitive does not execute it without a real caller; no
> inclusion or quality claim is made.

Turning any of these ON changes engine output by **exactly nothing**. They are
deliberate dead code awaiting a straight-test pose seam that does not yet exist.

**Dependencies between the three:**

- `courseWidth` → `fourLaneSensor`: **hard runtime dependency.** It imports and calls
  `observeFourLaneCrossSection`. Injectable via a default `observe` parameter, which is
  how the tests substitute a stub. Cannot be regenerated without the sensor (or a stand-in).
- `orientedRails` → `fourLaneSensor`: **type-only dependency.** It imports
  `FourLaneOccluder`, `FourLanePoint`, `FourLaneSensorKnobs` as types and re-derives its
  own `containsPoint` and `grayAt`. It can be regenerated standalone by inlining three
  small type definitions. It documents `edgeDeltaPx`/`liftReference` as *owned* by the
  sensor but receives them as a parameter rather than resolving them itself.
- `orientedRails` ↔ `courseWidth`: **no dependency in either direction.**

**Shared files all three touch — the only real merge collision surface:**

1. `features/registry.ts` — each appends one import and one array entry. Mechanical.
2. `configs/threeFactor-config.schema.json` — generated from the registry.
3. `tests/unit/threeFactorConfig.test.ts` — a pinned SHA-256 of the canonical resolved
   config. **Each branch changed it to a different value**, from base
   `3c600cf514b57eeb…`:
   - orient-rails → `81794d9665c89d01d1496088b339de0cde5671f0e725d9369065d1373ca1382b`
   - course-width → `082089d085c91ee6f2f5355e41102d2ab1cbd84a72df9f089b2fa25a99dd4c27`

   **Regenerating all three together produces a fourth hash that no branch recorded.**
   Do not copy either pin forward. Recompute it.

---

## Known failure cases

### The trophy-basket / square-bbox landmine — direct hit, called out explicitly

This cluster sits squarely on the named catastrophic failure (a trophy-shaped basket
sprite gets a square bounding box, that square swallows a nearby tee pad, and an
inspector concludes "no tee here" and deletes correct code). Occlusion, bounding boxes,
and negative evidence are the *core subject matter* of these files. Detail:

**The design gets the polarity right, and this is the cluster's single best idea.**
Occluded pixels produce **UNKNOWN (`null`)**, never `0`. The source comment states it:

> Expected pixels hidden by known occluders are neutral: they do not contribute
> zero-valued appearance evidence.

and the handoff repeats it: "Known-hidden expected pixels are neutral, never zeros."
Rails degrade **paired → one-sided → occluded** instead of scoring zero. `orientedRails`
goes further and treats "exactly one side badge-blocked" as a *first-class evidence
mode* rather than a failure. This is exactly the discipline whose absence caused the
original catastrophe. **Preserve it verbatim.**

**But the bboxes really are axis-aligned rectangles.** `FourLaneOccluder` is
`{bboxX, bboxY, bboxW, bboxH}` and `containsPoint` is a plain rectangle test. A
trophy-shaped basket still gets a square. Consequences:

1. **Safe direction (good):** an over-large square marks *more* UNKNOWN, so the sensor
   goes quiet rather than emitting confident false negatives. The failure is
   conservative by construction.
2. **New failure — silent blindness (bad, and unmitigated):** a bbox large enough to
   push `blocked*2 >= n` across enough bands drives `railMode = 'occluded'` and
   `score = null` everywhere. The sensor returns nothing at all. **If any future
   consumer treats `null` as "no corridor" instead of "no information", the original
   catastrophe returns one layer up.** Nothing in this code prevents that, because
   there is no consumer yet. **Any consumer written against these primitives must
   distinguish `null` from `0`. This is the highest-risk regeneration requirement in
   the cluster.**
3. **Boundary is inclusive on all four edges** (`>=` / `<=`), so the rectangle is closed
   and errs toward *more* occlusion. Deliberate — pinned by the test "treats bbox
   boundaries as blocked".
4. **`orientedRails` accepts only ONE occluder** (`badge: OrientedRailOccluder | null`),
   while `fourLaneSensor` accepts an array. `orientedRails` therefore **cannot represent
   a badge and a basket occluding the same cross-section** — the second one is invisible
   to it and its pixels get read as real evidence. This is a genuine correctness gap,
   not a style difference.

### Other failure cases

- **No sub-pixel sampling.** `Math.round` quantises every sample to whole pixels. With
  `edgeDeltaPx = 2.5`, inside/outside samples can land 2 px or 3 px apart depending on
  heading, so rail lift varies with angle for reasons that are pure rounding.
- **`liftReference = 45` is absolute, not relative.** A darker or lighter basemap
  rescales every score. Nothing normalizes for exposure, theme, or map style.
- **Ground estimate collapses when both guards are occluded.** `ground = null` makes
  *both* inner lanes UNKNOWN at once, halving the evidence from a single bad guard pair.
- **Guards at `±2W/3` assume open ground outside the ribbon.** Adjacent fairways,
  paths, or overlapping holes put ribbon pixels in the guard band, inflating `ground`
  and suppressing inner-lane scores.
- **`min()` aggregation is maximally brittle.** One weak lane zeroes the whole
  cross-section. Deliberate (conservative), but it means a single rendering artifact
  kills an otherwise good reading.
- **Course-width can pick a width off a handful of samples.** `meanScore` is not
  penalized for low `visibleSamples`; the count only breaks ties. A width scoring 0.9
  on 2 visible samples beats 0.85 on 200.
- **Course-width trusts frozen tee→badge segments.** Wrong upstream pairings feed
  garbage geometry into the sweep, and there is no rejection path.
- **`orientedRails` requires strictly positive lift on both sides for paired evidence.**
  A rail rendered *darker* than its surroundings (inverted theme, dark mode map) scores
  nothing at all — not low, nothing.

---

## What proves it works

**What is genuinely proven:** the pure math, on synthetic rasters, and config identity.
Nothing else.

| Suite | File | Tests | Covers |
|---|---|---|---|
| four-lane sensor | `tests/unit/fourLaneSensor.test.ts` | 12 | exact lane geometry, paired = min(L,R), one-sided retention, whole-section UNKNOWN, majority-blocked bands, nonzero-heading tangent positions, single-guard ground, inner sub-band occlusion, exact lift transcription, clamp at 0 and 1 |
| oriented rails | `tests/unit/orientedRails.test.ts` | 8 | axial wrap mod π, π-equivalent headings, both-positive paired requirement, exactly-one-blocked one-sided rule, inclusive bbox boundary, 24-orientation selection + doubled-angle vectors, one-sided encoding, first-max tie determinism |
| course width | `tests/unit/courseWidthFeature.test.ts` | 8 | LAB defaults, explicit config resolution, array validation, exact 5-fraction state generation, per-segment heading recompute, non-null-only aggregation, three-level tie order, `-Infinity` rows and fallback |

Recorded gate results (course-width branch, the fullest run):
`npm run check` 0 errors / 0 warnings; `npm run test:unit` 21 files / 146 tests passed;
`npm run build` green; focused slice 5 files / 35 tests; frozen projection hash
`a0a1ac828ce98f89831210896e42aeee468a5527bfe5e752ffa5bf431095396c` **unchanged**
(parity held).

### What is NOT proven — the honest ledger

- **Every fixture is a synthetic raster.** `stripeRaster` and `grayRaster` build 48×48
  hand-drawn gray images in the test file. **No real UDisc screenshot is exercised
  anywhere in this cluster.**
- **Zero rendered evidence images.** Against the project's standing rule that every
  claimed CV number ships with a rendered evidence image: **nothing here has one.**
- **The orient-rails IoU numbers are unreproduced source claims.** ≈0.695 image-only,
  ≈0.694 with scalar strengths, ≈0.732 orientation-preserving, ≈0.738 best small-model
  grid. These come from `badge-disk-ribbon-study.md` on a *different commit*
  (`ef2a4fc2`). **Nothing in this branch reproduces, or even loads, the data behind
  them.** Compounding this: the branch admits no raw implementation of the 24-angle
  producer was ever located, so the code claiming those numbers is not the code that
  produced them.
- **The course-width accuracy numbers are unreproduced source claims.** Dash 40/40,
  Heritage 30/30, Lenard 36/37, TowneLake 36/37. The handoff asked for these as fixture
  expectations "if source rasters are available" — **they were not.** The branch states
  plainly: "the historical Dev72 course-width observations remain source claims, not
  reproduced results here."
- **No OFF-vs-ON evidence exists, and cannot.** With no runtime caller, enabling the
  feature executes nothing. Both docs state this is intentional scope control.

---

## Regeneration notes

### Must get right

1. **Occlusion produces UNKNOWN, never zero.** Non-negotiable. This is the whole point.
   Any regeneration that lets a hidden pixel contribute a 0 has recreated the
   trophy-basket catastrophe inside the sensor.
2. **Whoever writes the first consumer must distinguish `null` from `0`.** Write this
   into the consumer's contract and test it before anything else. It is the one place
   the catastrophe can still get back in.
3. **Lane geometry is identity, not a knob.** `[−W/2, −W/6, +W/6, +W/2]` with lane width
   `W/3`. Do not "improve" it; downstream numbers assume it.
4. **The four knob values, exactly** — 2.5 / 45 / 4 / 5 — if you want to compare against
   any historical Dev72 number. They are unexplained, but they are the only link to
   prior measurements.
5. **Determinism in course-width's sort** (meanScore ↓, visibleSamples ↓, widthPx ↑) and
   **orient-rails' first-max tie**. Both are pinned by tests and both matter for
   reproducibility.
6. **Axial angles are mod π, encoded doubled.** `d = ((θ − H + π/2) mod π) − π/2`, then
   report `cos 2d`, `sin 2d`, and those times strength. Do **not** collapse to a scalar —
   the ablation showing that was flat (0.695 → 0.694) is the most valuable single fact
   in this cluster.
7. **Default OFF, deviation kind, no execution-list entry** unless you are also building
   the consumer. Frozen parity must not move.
8. **Recompute the resolved-config pin.** Neither branch's hash is correct for a build
   containing all three features.

### May freely change

- **File layout and naming.** `st.*.ts` was old-layout convention. Under the rebuild's
  `packages/alg/src/detectors/threeFactor/` use whatever fits.
- **Unify the occluder shape to an array in `orientedRails`.** The single-`badge`
  signature is a defect, not a design. Fix it.
- **Reconcile the clamp asymmetry.** The base sensor uses `clamp01`; `orientedRails`
  uses `min(1, x)` with a `> 0` gate. Pick one and document which, or keep both and say
  why in a comment.
- **Add bilinear sampling.** Nearest-neighbour at 2.5 px offsets is a real precision
  loss and nothing depends on the rounding.
- **Replace `min()` aggregation** with something less brittle (trimmed mean, soft-min) —
  *if* you re-derive the thresholds at the same time, since 45 was fit against `min`.
- **Deduplicate `containsPoint` / `grayAt`.** Copied verbatim into both files.
- **Normalize `liftReference` against local contrast** instead of using an absolute
  gray level. This is the most promising single improvement in the cluster.
- **Fix or re-derive `sampleFractions`.** The `0.78` is very likely a typo for `0.8`.
  Test both; the difference should be negligible, and if it is not, that itself is the
  finding.
- **Drop `orientedRails` entirely.** See Verdict.

### Regeneration order

`fourLaneSensor` first (everything else references it) → then `courseWidth` and
`orientedRails` in either order, or in parallel. They do not interact.

---

## Verdict

**Partially worth regenerating.**

- **Four-lane cross-section sensor — REGENERATE.** Small, self-contained, well-tested
  pure math, and it carries the occlusion-as-UNKNOWN discipline that directly defends
  against this project's known catastrophic failure. Worth rebuilding for that
  discipline alone, even if every threshold gets re-fit.
- **Course-width calibrator — REGENERATE, cheaply.** ~130 lines of deterministic sweep
  over the sensor with no new pixel math. The per-course width variation it corrects
  (30–40 px across four courses) is real and large. Low cost, clear payoff. Re-derive
  the candidate list and fix the `0.78`.
- **Oriented rails — DISCARD or rebuild from data, not from this code.** It is
  specification-derived from a prose document, the branch itself admits no source
  implementation was ever found, its headline IoU gain is unreproduced here, and it has
  a real defect (single-occluder). What is worth keeping is the *finding* — orientation
  must be preserved, scalar strength was measured flat — not these 288 lines. Rebuild it
  against real rasters with real evidence images, or leave it out.

**Cluster-wide caveat:** none of this has ever executed on a real screenshot. Every
number in it is either a synthetic-fixture assertion or an unreproduced claim from
another commit. Regenerate it as *scaffolding to be validated*, never as *behavior known
to work*.
