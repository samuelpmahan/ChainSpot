# CV Qualification Gallery

This directory is the merge-gate memory for ChainSpot CV.

## Rule zero

A detector may adapt to pixels it observes at runtime. The gallery may not tune the detector per fixture.

Fixture manifests contain only input/truth/provenance. `scripts/verify-cv-gallery.ts` rejects unknown case keys so there is no place to pass per-image thresholds, UI scales, template scales, crop values, or detector modes.

Every enabled gate must have at least one real **non-stitched** fixture and one real **stitched** fixture. Missing resolution coverage is a qualification failure, not a warning.

## Current gates

### Numbers

For every active number fixture:

- detected physical candidate count must equal the manually verified visible badge count;
- labeled count must equal that truth count;
- predicted label set must exactly equal the manually verified visible label set;
- every same-label center must be within 5 source-image pixels of golden truth.

This deliberately supports partial courses. A 9-hole/9-visible The Rec fixture should therefore pass as 9/9 with the exact nine golden labels; the detector still runs with the same production/default configuration used by 18-hole fixtures.

### Baskets — localization only

- exactly 18 basket candidates;
- 18/18 golden basket locations matched;
- 0 false positives.

This does **not** claim basket-to-hole association. Association is explicitly outside this gate.

### Tees

TODO / non-gating while tee research is moving quickly.

## The Rec

`gallery.json` already reserves the existing The Rec captures as pending number fixtures so they cannot be forgotten. They stay blocking until the exact 9-badge view is selected/confirmed and manually verified number centers are committed as truth. Do not bootstrap those centers from the detector being tested.

## Running

```bash
npm run verify:cv
```

`--json` appends a machine-readable result dump:

```bash
npm run verify:cv -- --json
```

A run exits nonzero for:

- a detector regression;
- a pending truth fixture;
- missing stitched/non-stitched coverage;
- a missing input/truth file;
- an invalid gallery schema.

The intended workflow is: add real failure image → add human truth → observe failing qualification → improve shared detector → entire gallery must pass.
