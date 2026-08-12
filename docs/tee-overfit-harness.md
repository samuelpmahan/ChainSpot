# Tee-detection overfitting harness

`npm run overfit:tees -- <bundle.chainspot.zip> --out <dir> [--baskets <bundle>]`

A metric-discovery tool for one specific labeled course: given tee truth
(`holes[].tee`) and optionally basket truth (`holes[].basket`), it computes a
battery of per-patch metrics on the truth tees vs dense local distractors and
hard negatives, reports each metric's discrimination (AUC, per-hole local
rank), greedy-searches a weighted combination, and verifies it. The scorer it
emits (`tuned-scorer.json`) is deliberately overfit — one image, no holdout.

## Result on the golden fixture

```
npm run overfit:tees -- resources/GoldenTeeSet.chainspot.zip \
  --baskets resources/GoldenBasketSet.chainspot.zip --out out/overfit
```

- Baseline fused detector: 17/18, tee 5 missed (no candidate within
  tolerance anywhere in the fused/occluded pool — re-ranking cannot fix it).
- `gap-fill` verification (default): baseline keeps its 17 holes; the tuned
  scorer slides a local window anchored on the missed hole's NUMBER BADGE
  (truth is used only for evaluation), and candidate peaks are validated by
  the badge-ray invariant below. With the sweep estimator, tee 5 is
  badge-ray-validated at `(484, 852)`, 7.6 px from truth (12.4 px tolerance),
  with axis 152.5° and NCC 0.698: **17/18 → 18/18**.

## The badge-ray invariant

A valid tee pad AIMS at its own number badge: the pad's major axis is the
initial throw/fairway direction, and UDisc places the number badge on that
same ray. The harness requires the center ray plus both long-side offsets to
pass within the badge disc, with the badge beyond the pad's front edge. Tee 5
sits 40.5 UI multiples from badge 5 — just past the production 40-multiple
gap-fallback radius — so the badge-anchored search uses 45.

### Correction: the old fitter was wrong, not the invariant

The first validator estimated the axis with RANSAC over bright rim fragments.
On a second labeled course, Alex Clark, that fitter locked onto basket glyphs,
road edges, or putting-ring arcs on 5/18 pads and reported false invariant
violations. Visual inspection plus independent rotation sweeps showed that the
pads themselves still obey the rule.

Orientation is now measured by `sweepPadOrientation`: rotation-swept,
TM_CCOEFF_NORMED-equivalent NCC against synthesized hollow-pad templates
(background 120, rim 235, interior 158), with angles from 0° to 180° in 2.5°
steps and a small local translation search. The templates remain UI-scale
derived; two nearby outer-footprint interpretations are searched and NCC
chooses between them from the pixels, rather than configuring a size per
fixture. Weak matches also get a conservative script-local pass that ignores a
small halo around near-black glyph pixels. Badge and basket geometry never
enter the orientation estimator.

A sweep score below 0.30 is **UNMEASURABLE**: it is not a FAIL and cannot be
used to produce an invariant verdict. Gap-fill auto-approval is intentionally
stricter than measurement: a newly proposed location needs NCC >= 0.50 before
its badge ray is allowed to validate it. Marginal peaks remain visible as the
existing `UNVALIDATED top` diagnostic instead of becoming false recoveries.

Measured with `npm run validate:badge-invariant`:

- **GoldenTeeSet: PASS 18/18; FAIL 0; UNMEASURABLE 0.**
- **AlexClark: PASS 17/18; FAIL 0; UNMEASURABLE 1.** Tee 12 is the sole
  unmeasurable pad (NCC 0.272); its rendered pad is heavily buried by a glyph.

The second course also exposes the physical basis of the rule: the pad tracks
the initial fairway/throw line, and the number badge lies on that line. It does
not blindly point at the basket. In the original visual/reference bearing
audit, the clearest divergent cases were tee 13 (~1.5° to badge vs ~14.3° to
basket) and tee 16 (~1.0° vs ~16.5°). With the sweep's refined centers in the
final validator run those are 1.4° vs 17.0° for tee 13 and 1.1° vs 18.6° for
tee 16 — the same qualitative result: **when badge and basket bearings diverge,
the pad tracks the badge**.

The invariant remains pure ray geometry against the badge disc; baskets and
other rendered course structures can occlude the visible pad and are not
first-object-hit constraints.

### Frozen-transfer check

The Golden scorer was re-derived deterministically, then transferred unchanged
to Alex Clark:

```
+2*padEvidenceScore +2*softGrayFraction +2*edgeDensity -2*satIqr
```

Alex's fused baseline remains **13/18**, missing tees 5, 8, 11, 12, and 13.
The transferred scorer does not recover a true missing pad, so the combined
result honestly remains **13/18**. Crucially, after the orientation correction
and strong-confidence auto-validation threshold, all five gap proposals are
reported as **UNVALIDATED**. The wrong-location peaks that the old rim fitter
had falsely badge-ray-validated are no longer blessed as recoveries.

## Why hole 5 is hard, and what actually separates it

Hole 5's pad is bisected by **basket 6's** C2 putting circle (radius ≈87px,
course-wide; there is a second ring family ≈40px), and its interior color
(S 15–18, V 171–172) sits outside the production gray-center window
(S≤18, V 148–168) because the semi-transparent fill picks up the basemap
tile — which is exactly why `gray-center` cannot see it.

The discovered metric, `padEvidenceScore` (AUC 0.995, rank 1 of ~296 local
windows on 16/18 holes including hole 5), is a conjunction:

```
padEvidenceScore = softGrayFraction * offStructureCleanBrightDensity
```

- `softGrayFraction`: widened interior window (S≤25, V 145–180).
- `offStructureCleanBrightDensity`: bright rim-like pixels that are (a) NOT
  within 6px of a known dash structure — dashed rings fitted around every
  basket from the dash-blob population, plus dashed connectors basket N →
  tee N+1 — and (b) NOT within 3px of near-black pixels (which identifies
  black-outlined basket glyphs and number badges).

Each factor kills a different confuser class: gray paths have no rim, dashes
are on-structure, glyphs/badges are black-adjacent. Only a pad keeps both
factors non-zero. The full tuned scorer adds `softGrayFraction`,
`edgeDensity` and `-satIqr` refinements on top.

## Integration path (not yet wired)

`tuned-scorer.json` + the structure fit are designed to slot into
`detectCalibratedTeeGapFallbackCandidates` (`cvCalibratedDetectors.ts`): for
a badge with no confident tee, slide the scorer in the fallback radius and
consider the peaks. A peak is only auto-approved when its independently
measured pad orientation is strongly measurable and satisfies the badge-ray
invariant; otherwise it remains a review candidate. Basket positions come from
the existing 18/18 basket detector; ring radii are fitted from dash blobs at
runtime. Guard any production wiring with a new 18/18 assertion in `verify:cv`
rather than loosening the current one. `railCapScore` (parallel rails +
perpendicular cap) measured AUC 0.74 at this patch scale — supportive but not
sufficient alone as an auto-approve gate; `padEvidenceScore` is the stronger
candidate for that.
