# CV Qualification Gallery

This directory is ChainSpot's lightweight CV memory: one shared gallery for merge qualification **and** day-to-day detector development.

## MVP rule

Qualification protects claims ChainSpot already needs for the MVP. It is not a mandate to benchmark every subsystem or hand-label every image.

Adding a gate should have a demonstrated MVP regression risk or near-zero annotation cost. Coverage breadth is not a goal.

Course Memory is intentionally **not** in this suite. Tees are intentionally **not** gating while that detector is under active research.

## Rule zero: no per-image tuning

A detector may adapt to pixels it observes at runtime. The gallery may not tune the detector per fixture.

Fixture entries contain inputs, truth/provenance, and the kind of evaluation available. `scripts/verify-cv-gallery.ts` rejects unknown case keys, so there is no fixture field for thresholds, UI scales, template scales, crop values, or detector modes.

If fixing one image breaks another, improve the shared detector. Do not add an image-specific parameter.

## Two modes

### Development mode

```bash
npm run cv:dev
```

Development mode runs every gallery case it can, including pending-truth and candidate fixtures. It does **not** care whether merge gates pass and does not exit nonzero because an individual detector result is bad.

Each run is persisted under:

```text
artifacts/cv-runs/<timestamp>/
  run.json
  <case-id>/... detector overlays/artifacts ...
```

`run.json` records the git commit, timestamps, fixture results, and detector metrics. This is the experiment notebook: compare runs instead of remembering which screenshot/version looked good.

To iterate on one fixture without paying for the whole gallery:

```bash
npm run cv:dev -- --case numbers-reference-stitched
```

Development output deliberately says `RUN`, `SKIP`, or `ERROR`, not PASS/FAIL.

### Merge-gate mode

```bash
npm run verify:cv
```

Gate mode runs only active required fixtures and exits nonzero for a regression, a required pending-truth fixture, or missing required stitched/non-stitched coverage.

`--json` is available in either mode for machine-readable stdout.

## Current MVP gates

### Numbers

Numbers intentionally require both non-stitched and stitched real imagery.

For every active golden number fixture:

- physical candidate count equals the manually verified visible badge count;
- labeled count equals that truth count;
- predicted label set exactly equals the visible golden label set;
- every same-label center is within 5 source-image pixels of golden truth.

The existing native 18-hole reference is active. One stitched full-course truth set is still required. The Rec must contribute **one** verified 9/9 case; the alternate Rec capture stays development-only unless it proves independently useful. Do not annotate both just for breadth.

### Baskets — localization, not association

The existing `GoldenBasketSet.chainspot.zip` remains the hard localization gate:

- exactly 18 basket candidates;
- 18/18 golden basket locations matched;
- 0 false positives.

For stitched imagery, MVP does **not** require manually reconstructing 18 more basket centers. The stitched gate is a scale/regression smoke test through the production course-detection path:

- exactly 18 raw basket candidates.

This catches the class of stitched-raster scale failures that already bit ChainSpot without turning basket annotation into a second project.

Neither basket gate claims basket-to-hole association. Association is explicitly not evaluated.

### Tees

TODO / non-gating while tee research is moving quickly.

## Fixture admission

A real CV bug should usually leave behind a cheap regression fixture. But do not expand the gallery merely because another image exists.

The intended MVP loop is:

```text
observe real failure
→ add/reuse the cheapest fixture that captures it
→ run cv:dev while iterating
→ shared detector improves
→ required gallery goes green
→ merge
```
