# Toph vertical slice + P1 tuning on the 4-course annotated corpus

Date: 2026-08-17. Experiment run on branch `claude/disc-golf-course-research-0nqf8j`
against `main@894854a`. Corpus: `samuelpmahan/chainspot-corpus` `dev/Annotated`
(DashsTrack, Heritage, Lenard, TowneLake; **AlexClark deliberately excluded** per
the experiment scope). This is the first execution of the Toph DESIGN.md Part 3
vertical slice — implemented ChainSpot-side (`src/lib/toph/trace.ts` +
`scripts/toph/record.ts`) since `samuelpmahan/toph` still contains only DESIGN.md.

## What was built

- **Toph core** (`src/lib/toph/trace.ts`): the DESIGN.md slice `Trace` interface +
  frozen `NOOP`. Production imports only this; no recorder is reachable from `src/`.
- **Instrumented P1** (`rawObjectMask.ts`): every gate is a named Toph check;
  all thresholds moved to `RAW_MASK_TUNING_DEFAULTS`. The source experiment
  began with historical constants, but CHSPT-70 W2 intentionally flipped the
  no-argument production defaults to the tuned values; historical values
  remain available through the named comparison preset. One new structural
  option (`basketPoolExcludeInsideBadgeMarginFrac`) performs badge exclusion.
  Badge family is now computed before the basket family (order-independent,
  both read disjoint inputs).
- **First-loss runner** (`scripts/toph-run.ts`): DESIGN.md's headline query —
  GT point → labelmap → lineage → first failed gate with measured value vs
  threshold. Reproduces production intake by running the real
  `proposeSingleImageCrop` before detection (annotations live in the post-crop
  frame; validated against the annotation's recorded source dimensions).
- **Sweep driver** (`scripts/toph-tune.ts`), **0-bend measurement**
  (`scripts/toph-measure-zerobend.ts`).

## Headline numbers (P1, tee/basket recall vs corpus truths, tolerance 26px)

| config | DashsTrack | Heritage | Lenard | TowneLake | totals |
|---|---|---|---|---|---|
| historical | t18/18 b18/18 +0 | t0/18 b15/18 +0 | t0/18 b0/18 **+17FP** | t0/18 b18/18 +0 | t18/72 b51/72 **+17FP** |
| tuned (active default) | t18/18 b18/18 +0 | t8/18 b15/18 +0 | t16/18 b16/18 +3 | t16/18 b18/18 +0 | **t58/72 b67/72 +3FP** |

Tuned config: `basketPoolExcludeInsideBadgeMarginFrac: 0.08`,
`teeAreaVsBasketMin: 0.06`, `basketPoolFillMin: 0.26`,
`teeMinDimBadgeHeightFrac: 0.30`. DashsTrack (the original tuning fixture) is
unchanged under every configuration tried — it is the regression guard, not a
casualty.

## The three mechanisms (Toph-attributed, not guessed)

1. **Badge-digit consensus poisoning (Lenard).** The white hole-number digits
   inside badges are pad-sized bright components (15×21px, fill ~0.53). All 17
   of them pass every basket-pool gate and win `dominantSizeCluster` over the
   16 surviving real baskets → 0/18 baskets + 17 FP, and — because
   `basketMedianArea` is then digit-sized — every derived tee threshold
   collapses too. The tee family already excludes inside-badge components; the
   basket pool did not. Fix: the same exclusion, opt-in
   (`basketPoolExcludeInsideBadgeMarginFrac`). Effect: Lenard baskets 0→16,
   FP 17→0; zero change on the other three courses. Cost, honestly measured:
   Lenard H9's real basket center falls inside a badge bbox (overlapping
   glyphs) and is now excluded — 1 basket traded for 16 baskets + 17 FPs.
2. **Satellite captures render tees smaller relative to baskets/badges.**
   On Heritage/TowneLake/Lenard, real tee glyphs sit 1–4px from the truth
   clicks with areas 116–150px² = 0.066–0.086 × basketMedianArea (floor: 0.09)
   and min-dimensions 11–16px = 0.31–0.44 × badgeMedianHeight (floor: 0.45).
   Both floors are DashsTrack-relative assumptions that don't transfer.
   Lowering `teeAreaVsBasketMin` 0.09→0.06 and `teeMinDimBadgeHeightFrac`
   0.45→0.30 recovers 40 tees across the three courses. Results are flat
   across md 0.28–0.35 (not knife-edge tuned).
3. **Occluded basket icons under-fill on satellite ground.** Real basket
   glyphs at fill 0.29–0.33 vs the 0.40 pool floor (Heritage H12/13/17,
   Lenard H12). `basketPoolFillMin` 0.40→0.26 admits them — but ONLY together
   with fix 1: alone, the relaxed floor floods the pool and flips TowneLake's
   consensus to a wrong cluster (b18→0, +19FP). The fill floor is load-bearing
   for consensus stability; the sweep table records both directions.
   (These four baskets still lose size-consensus afterward — occlusion changes
   their dims — so they remain bounded absences, attributed, not mysteries.)

Dead end, recorded: `basketPoolAspectMin` 1.25→1.05 (for Lenard H9's aspect
1.08) floods every satellite course with square UI chrome (−49 baskets total).
Do not revisit without a different mechanism.

## Remaining losses at the tuned config (all attributed, none mysterious)

- Heritage tees 10: 8 glyphs with minDim 11–13px now pass geometry but fail
  the grey-interior/appearance gates — the exact gates that block the
  documented Heritage rooftop false accept. Not relaxed; that trade needs a
  deliberate decision, not a sweep. H5/6/10: tee glyph merged into the
  basket-icon component (single 1746px² blob) — unrecoverable at P1.
- Lenard: H3 tee fragment (33px²); H9 basket (exclusion cost, above);
  H12 basket (consensus dims). +3 FPs are small bright map details admitted by
  the relaxed tee floors that also pass appearance+grey (worth eyeballing).
- TowneLake tees 2: H3/H18 at minDim 16 vs 16.2 — recoverable at md 0.28 but
  left as-is rather than chasing the last 0.2px on N=4.

## Small-N honesty

Four courses, three of them the same UDisc-satellite render style. Each chosen
axis is implicated by ≥2 courses except the badge exclusion (Lenard-only, but
zero-cost on the other three and mechanism-understood). Values sit on plateaus,
not peaks. Still: this is N=4, the same ceiling the GRayT tuning report hit at
N=2 — treat the tuned values as candidates to re-validate as the corpus grows
(sealed/ and validation/ courses exist for exactly this).

## New structural prior, measured: 0-bend badge-on-chord

The source experiment originally summarized all 44 straight holes as having
their own badge 0.1–2.1px from the tee→basket chord with no distance overlap
against bent holes. Fresh port review did **not** reproduce that wording. The
script measures the *nearest P1-emitted badge* for all four courses, not the
hole-labeled badge except in its separate DashsTrack check. On the SHA-verified
corpus, nearest-badge distance spans 0.0–3.7px for 44 straight holes and
2.1–34.4px for 28 bent controls, so distance alone overlaps.

This is not later corpus drift: all four images and annotations come from the
corpus's initial/current commit `7a1fdac` (before source experiment `6785064`).
The gate verified image LFS OIDs `e6616738` (DashsTrack), `fb77ea13`
(Heritage), `27ad16bc` (Lenard), and `da2a0ccc` (TowneLake). The discrepancy
is between the source summary and its own measurement semantics: the script
always measured nearest emitted badges, then had labeled badge identity only
for DashsTrack. DashsTrack H12 is the concrete falsifier: 3.7px to the nearest
emitted badge and 3.6px to its labeled badge, both above the claimed 2.1px.

The exact joint predicate remains useful and conservative: distance ≤3px at
t ∈ [0.4,0.6] yields exactly one candidate for 43/44 straight holes, zero for
one straight hole, no ambiguous straight holes, and no candidate for any of
the 28 bent controls. A smallest comparison at 4px yields 44/44, 0 ambiguous,
and 0/28 bent candidates in this truth-geometry proxy, but produces no change
to DashsTrack's exact full-pipeline inputs or assignments (hole 16 remains the
only zero-bend lock). Because the other three courses lack a valid autocropped
full-pipeline association harness, production keeps the safer 3px abstention
instead of retuning from one discrepancy. DashsTrack's labeled-badge check
still reports zero aliasing. `scripts/toph-measure-zerobend.ts` prints both the
active predicate and the 4px falsifying comparison.

## Verdicts on the DESIGN.md spike questions

1. **Friction: PASS.** The gate chains made `detectRawObjectMask` more
   readable (gates got names); one hoist total; ~15 call sites as predicted.
2. **Zero-cost claim: FAIL as implemented.** NOOP-instrumented median 149.3ms
   vs 143.2ms original on DashsTrack (~4.3%, target <1%). Suspected cause: the
   per-pixel `if (labels)` branch inside the flood-fill hot loop (the one
   place per-pixel work was added), not the gate calls. Remediation per
   DESIGN.md's own escalation: compile-out or a loop-hoisted labels variant.
   Not fixed in this pass; measured and recorded.
3. **Identity model: PASS.** WeakMap + explicit transform at the
   component→emitted boundary; derivation sites in P1: exactly 3.
4. **Raster↔entity join: PASS.** Labelmap-per-mask answered every truth query
   with no per-pixel events; traces ~2MB/course as PNGs.
5. **Vocabulary: PASS.** check/decide/select/derive covered all P1 decisions;
   `select` (consensus) carried the single most valuable attribution of the
   whole experiment (Lenard).
6. **Payoff: PASS.** `diagnostics`/stage counters are now derivable from the
   trace; every conclusion in this report is a trace query, not archaeology.

## Recommendations for Toph

Kept as a separate document targeting the `samuelpmahan/toph` repo (the
library's feedback should live with the library, not in this course-tuning
report): see the accompanying `toph-slice-feedback.md` delivered with this
experiment.

## Reproduction

```
# images fetched from chainspot-corpus via LFS (sha-verified against pointers)
npx tsx scripts/toph-run.ts --image <dir>/DashsTrack-full.jpg \
  --truth <corpus>/dev/Annotated/DashsTrack/DashsTrack-full.annotation.json
npx tsx scripts/toph-tune.ts <imagesDir> <corpus>/dev/Annotated
npx tsx scripts/toph-measure-zerobend.ts <imagesDir> <corpus>/dev/Annotated
```

Validation at defaults: `npm run check` clean; grey-interior unit suite green;
`pancake-harness` end-to-end on DashsTrack verified per hole,
not just "ready": all 18 holes' proposed tee AND basket land 0.0–4.2px from
that hole number's annotation truth (18/18 tees, 18/18 baskets correctly
assigned; 3.7s wall). The no-trace production call signature is unchanged and
does not load the recorder, but its detector output is intentionally **not**
byte-identical: callers that pass no tuning now receive the tuned active
defaults. Pass the named historical preset only for controlled comparison.
