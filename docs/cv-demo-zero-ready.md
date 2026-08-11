# Why the shipped demo dataset yields "0 ready, 18 need review"

Investigation only — no fix landed here. `src/lib/cv/` and `src/lib/autoAnnotation/`
belong to another agent's in-flight work; see the "smallest fix" section for what to
hand off.

## Method

Ran the real product, not a script: `/demo` → **Start** → wait for Smart Import to
place and validate all four tiles → **Use as UDisc source** → the ordinary
Annotate Round import banner → **Detect full course**, exactly the path a visitor
takes and the same path a prior audit used. Driven with Playwright against
`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`, dev server on `PW_PORT=4188`.
Confirmed the resulting source image is the real stitched composite
(`udisc-capture-4-stitched.png`, **1985×3709**), not a single raw tile.

To see *why*, not just *that*, `holeNumberDetection.ts` and
`basketDetection.worker.ts` were temporarily instrumented with `console.log`
at the exact decision points, the flow re-run, the real numbers captured below,
and **the instrumentation was then reverted** (`git checkout --`) — no diagnostic
logging is left in `src/lib/cv/` or `src/lib/autoAnnotation/`. Only this doc and
a new, independent test file (`tests/unit/holeNumberDetectionShortfall.test.ts`)
are committed.

Result, matching the previously-established baseline exactly:

```
Found 18 holes — 0 ready, 18 need review
0 numbers · 18 tees · 15 baskets · 0 ready
```

## Q1 — What makes a hole "ready"?

`associateCourseGrammar` in `courseGrammar.ts` (line 680):

```ts
status: hasError ? 'incomplete' : confidence >= 0.7 && holeFailures.length === 0 ? 'ready' : 'review',
```

A hole is `ready` only if: no `severity: 'error'` failure, overall confidence
`>= 0.7`, **and zero failures of any kind** (warnings count too). The
`annotate-round` page's summary line (`+page.svelte:2565-2570`) buckets
everything that isn't `ready` into "need review" — so `incomplete` holes and
genuinely `review` holes both show up under that one label.

**Which condition fails for all 18 here:** every hole gets a hard
`missing-number-badge` error. Stage 1 of `associateCourseGrammar` (line 423)
builds badge-assignment cost from `labelConfidence(badge, holeNumber)`, which
needs either a matching `labelScores` entry or `badge.holeNumber === holeNumber`.
Every number-badge candidate on this dataset has `holeNumber: undefined` (see
Q2), so every cost is `BLOCKED_COST`, every hole gets the error, and every hole
is `status: 'incomplete'` — not merely a low-confidence `'review'`. The UI text
doesn't distinguish the two, but the code does.

## Q2 — Why are 0 of 18 badges labeled?

Labeling happens in `holeNumberDetection.ts`'s `assignedCandidates()` (line 820).
It does NCC glyph matching (`matchTemplate` against tiny digit-interior crops),
but only after this gate, line 827:

```ts
if (clusters.length !== templates.length || templates.length === 0) return null;
```

`clusters` comes from `selectBadgeBodies()` (line 296): threshold the image for
dark connected components, keep the ones that look badge-shaped
(`plausibleBadgeBody`: 12–120px wide, 9–90px tall, aspect 1.12–1.75, fill ≥ 0.55),
then find the **single largest same-size cluster** among those (within a ±20%
log-size tolerance of each other) and use only that cluster.

Measured on the real stitched demo image (18 templates supplied — the pack is
complete, `static/resources/chainspot_cv_templates/hole-01.png`…`hole-18.png`
all present and load correctly):

| Stage | Count |
| --- | --- |
| Dark connected components in the image | 2830 |
| Pass the per-component badge-shape filter | 17 |
| Survive the same-size clustering (`selectBadgeBodies`) | **16** |
| Templates supplied | 18 |

`clustersLength (16) !== templatesLength (18)` → `assignedCandidates` returns
`null` before a single `matchTemplate` call → `detectHoleNumberBadges` falls
back to `labeling: 'candidate-only'` → **every** candidate keeps its location
but `label` stays `undefined`. This is not "18 badges scored too low to trust" —
glyph scoring never runs at all. It's an all-or-nothing gate: being 2 candidates
short costs you all 18 labels, not 2.

Of the 17 plausible components, 16 cluster tightly (width 28–29px, height 21px,
fill 0.73–0.89, at analysis-image scale). The 17th — the one `selectBadgeBodies`
excludes — is `{w:12, h:10, fill:0.56}`, roughly a third the linear size of a
real badge; almost certainly a small unrelated dark UI speck, not a badge. Its
exclusion is *correct* behavior. The real defect is that **one genuine badge on
this image produced no passable connected component at all** (not present even
in the 17-item plausible list) — most likely because a stitching seam, blend,
or overlapping line art broke its dark rounded-rect background at that spot.
16 real candidates found, 0 labeled: a "found 16 but need exactly 18" bug, not
a "candidates too small/faint to read" bug and not (primarily) a chrome bug —
see Q3.

## Q3 — Is map chrome polluting detection?

Tested directly on the real image, both visually and by the numbers above.

**For number badges: no, not meaningfully.** Of 2830 raw dark components in the
full stitched course map (which does contain plenty of un-cropped chrome — see
below), only **one** survives the per-component badge-shape filter as a
non-badge false positive, and the existing same-size-cluster step already
excludes it correctly, for free. Removing chrome entirely would not change the
outcome: 16 real badges would still be 16, still `≠ 18`, still zero labels. The
owner's suggested fix (chrome filtering) would not have fixed this dataset's
headline symptom.

**For baskets: yes, chrome does leak in, and it's visible.** The stitched
composite genuinely does *not* crop Apple Maps' attribution watermark (import
only trims phone status bar / UDisc chrome, not this) — it appears twice in
the composite, once from each of the two tiles that meet at that seam.

A screenshot crop (`16-watermark-zoom.png`, path below) shows a **basket-candidate marker (`fill:#facc15`, the
app's own basket-candidate color) sitting almost exactly on the "a" in
"Maps"** — this is the same artifact the owner described. Basket detection
(`detectBasketTemplateCandidates`) is capped at `maxCandidates` and ranks by
NCC score, so unlike the number-badge path, a high-scoring chrome false
positive here genuinely can occupy a slot a real basket should have had. This
run found 15/18 (and 16/18 on an earlier pass) baskets — consistent with, though
not conclusively proven to be fully explained by, chrome occupying 1-3 slots.
Chrome filtering is a real, worthwhile improvement — but it is a **basket**
precision fix, not the fix for 0 labeled numbers / 0 ready holes.

Screenshots (in this worktree's scratchpad, not committed):
- `.../shots/cv-0ready/14-after-detect-full-course.png` — full app state after
  detection on the real stitched image, "Found 18 holes — 0 ready" visible,
  unlabeled (numberless) yellow/red candidate dots scattered across the map.
- `.../shots/cv-0ready/16-watermark-zoom.png` — zoomed crop: a basket-candidate
  marker directly on the Apple Maps watermark's "a".
- `.../shots/cv-0ready/10-stitch-assignment.png`, `11-stitch-ready.png` — Smart
  Import placing and validating all four tiles before detection ran.

(Full path prefix:
`/tmp/claude-0/-home-user-ChainSpot/a9101edf-3734-5aca-b7cf-182b5fd60641/scratchpad/shots/cv-0ready/`)

## Q4 — Why 6 ready on the owner's own data but 0 here?

Not fully closed — the owner's source image isn't in this repo, so it couldn't
be measured directly the same way. But the sharpest, evidence-backed structural
difference found: **the demo dataset requires Smart Import stitching** (four
separately-captured phone screenshots warped and merged into one 1985×3709
composite), something the owner's course data most likely didn't need (a
single, clean, un-stitched UDisc screenshot — matching the "clean course
pipeline" doc's own stated best case: 18/18 numbers, 18/18 baskets, 18/18 tees
against "a real clean-course screenshot", not a stitched one).

That fits what was actually measured here: 16 of 18 badges are clean and
consistent; the other 2 look like exactly the kind of local damage a stitching
seam/blend would cause (one badge's dark body doesn't survive as a connected
component at all; a much smaller stray fragment appears nearby). The codebase's
own history backs this domain split: the tee/basket detection gap-plan doc
explicitly found a *different* fixture class (a photographed/exported map
capture, not a clean UDisc screenshot) breaking `uiScalePx` transfer and other
assumptions "because the same UI... draws both the number badge and the basket
icon at a shared, consistent scale... it does **not** hold here." Stitching is
the same kind of domain shift, applied to this dataset specifically.

Also directly measured, independent of Q1–Q3: a **second, real scale bug** in
the browser worker path, worth naming because it's concrete and easy to miss.
`basketDetection.worker.ts` derives the basket-matching scale from the
number-badge anchor's scale (`deriveBasketTemplateScale`), but the number
anchor is measured against the **downscaled analysis raster**
(`grayscaleRaster()`, capped at `MAX_ANALYSIS_DIM = 2200px`), while basket
detection then runs against the **full-resolution** raster. The anchor's
`scale` field is deliberately left un-multiplied by the analysis→source scale
factor (comment in `sourceNumberDetection`: "intentionally NOT multiplied by
source-coordinate scale" — correct for its own within-analysis-image glyph
matching) but gets reused as-is for basket matching in a different pixel
domain. Measured on this run:

```
rawAnalysisDomainAnchorScale: 0.598   (correct, but only in the downscaled domain)
sourceScale (full-res / analysis):     1.686
basketTemplateScaleUsed:               1.073   ← what production actually searches around
what it should be (× sourceScale):     1.810
```

Basket matching searches ±10% around the scale it's given
(`SCALE_RANGE_LOW/HIGH = 0.9/1.1` in `basketTemplateDetection.ts`), i.e.
`[0.966, 1.180]` here — the correct value (1.810) is ~53% above the top of that
window. `uiScalePx` (used for tee-pad detection) sidesteps this because it's
derived from the anchor's already-source-scaled *matched pixel dimensions*,
not from the raw `scale` field — which is exactly why tees came back 18/18
while baskets came back 15–16/18. This bug is invisible from the CLI
(`scripts/detect-course.ts`) because the CLI never downscales the image before
number detection (`sourceScale` there is effectively 1), which likely explains
the doc's own previously "unexplained" CLI-vs-browser detection-count gap.

This basket-scale bug is real, confirmed with concrete numbers, and
independent of the number-badge collapse — but it cannot be the cause of "0
ready / 0 labeled": in the worker, number-badge detection runs and finalizes
(`numbersMs` stage) **before** basket detection starts (`basketsMs` stage,
which needs the number anchor as an input), and `associateCourseGrammar`'s
badge-assignment stage (`courseGrammar.ts` lines 421-461) never reads basket
candidates at all — it only uses each badge candidate's own `holeNumber` /
`labelScores`. A hypothesis that basket detection feeding a downstream
`recognizeCourse` step causes unlabeled badges was checked directly against
the code and does not hold: `recognizeCourse` (`+page.svelte:1401`) is a
separate, best-effort "Course Memory" library lookup that *consumes* the
already-computed `numberBadges`/`labeledBaskets` (themselves already derived
from `result.grammar.holes`, i.e. after grammar association has already run)
to suggest a previously-annotated course match — it has no path back into
`detectHoleNumberBadges` or `assignedCandidates`.

## Q5 — Smallest fix, ranked

1. **Highest value, lowest risk — soften the number-badge equality gate.**
   Replace `if (clusters.length !== templates.length...) return null` with a
   partial assignment: build a `clusters.length × 18` cost matrix and solve it
   with dummy-column padding, exactly the pattern `courseGrammar.ts` already
   uses (`withDummyColumns` + Hungarian) for its own candidate-to-hole
   assignment. 16 found badges would label 16 (or close to it), leaving 2 holes
   correctly flagged `missing-number-badge` instead of all 18. This alone
   would very likely take "0 ready" to something well above zero, since 16/18
   labeled numbers plus already-working 18/18 tees would let most holes clear
   the `ready` bar. Confined to `holeNumberDetection.ts`'s `assignedCandidates`
   / `detectHoleNumberBadges`.
2. **Real, independent, worth doing — fix the basket-scale domain mismatch.**
   In `basketDetection.worker.ts`, `deriveBasketTemplateScale` needs the
   *source-corrected* anchor scale, not the raw analysis-domain one — e.g.
   multiply by `sourceScale` before calling it, or derive it the same way
   `uiScalePx` already does (from `matchedWidthPx`/`matchedHeightPx`, which are
   already in full-resolution terms) instead of from `anchor.scale` directly.
   Low risk, single call site, concrete before/after numbers to verify against
   (search window should bracket ~1.81 instead of ~1.07 on this fixture).
3. **Worth doing, but secondary — basket chrome filtering.** The owner's
   instinct is right for baskets specifically: a watermark-derived false
   positive can occupy a `maxCandidates` slot. A targeted filter (or reusing
   whatever "known chrome band" logic import already applies) would firm up
   basket recall. Confirmed by direct measurement to be *not* the fix for the
   number-badge collapse, so it should not be sold as resolving "0 ready" on
   its own.
4. **Root-cause the actually-missing 18th badge**, once (1) is in — is it a
   stitching seam artifact specifically, and can Smart Import's own stitch
   validation flag/avoid landing a badge exactly on a seam line? Medium effort,
   addresses the cause rather than just tolerating the shortfall.

## What's committed here

- This doc.
- `tests/unit/holeNumberDetectionShortfall.test.ts` — two tests against the
  real `detectHoleNumberBadges` export, using a synthetic (photo-free) raster
  so the pathology is deterministic and doesn't depend on the demo images:
  - one **passing** test that pins today's actual behavior (16 well-formed
    physical candidates found, 18 templates supplied → 0 labeled);
  - one **`.skip`-marked** test asserting the desired behavior (most of the 16
    should get labeled). Verified by temporarily un-skipping it that it
    currently fails: `AssertionError: expected 0 to be greater than or equal
    to 14`. Left skipped so it doesn't redden the suite for other agents
    currently working in `src/lib/autoAnnotation/`; un-skip once fix #1 above
    lands.

No changes to `src/lib/cv/` or `src/lib/autoAnnotation/` are included — those
files were only temporarily instrumented locally to take the measurements
above, then reverted (`git checkout --`) before this doc was written.
