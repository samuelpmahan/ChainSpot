# Python quick_anno S3 checkpoint

Branch: `task/quick-anno-s3-materialization`
Base validated S2 checkpoint: `5c87d48945ecc11b6e1466cfd193b071747238b6`

## Purpose

Carry the accepted Python quick_anno transfer pattern through production S3 without changing S3 detection semantics:

- execute real S0 -> S1 -> S2 -> S3;
- export the smallest useful visible-Tee runtime snapshot;
- seed first-class Python PxC Parts;
- run one bounded PCR Calculation over S3 testimony;
- query the published scratch Parts with PQL;
- emit Mermaid from the same PCR composition;
- materialize a neon-first correctness sheet from the same production snapshot;
- visually inspect the sheet before claiming correctness.

This lane does not redesign S3, tune thresholds, add recovery, or add component fallback.

## Production S3 semantics preserved

The transfer follows the current clean S3 contract exactly:

```text
bright enclosed holes
  -> elongated tee-ring candidates
  -> exclude ring centers muted by prior Badge objects
  -> pair remaining rings with enclosing bright frames
  -> select common major/minor/area frame family
  -> construct visible Tee objects from exact accepted frame pixels
  -> materialize TeePx subtraction as PCR output only
```

Recovery is `NOT RUN`. Component fallback is `NOT RUN`. The subtraction raster is not written back into production PxC.

## Reproduce

From repository root after the TypeScript package has been built and Python dependencies are installed:

```sh
python -m pip install -e packages/quick_anno_py
python experiments/quick-anno-python/s3.py \
  ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg
```

Outputs:

```text
experiments/quick-anno-python/generated/DashsTrack-S3/
  snapshot.json
  python-summary.json
  python-rejected.json
  python-S3.mmd
  s3-neon-correctness-sheet.png
  s3-ring-candidates-neon.png
  s3-family-neon.png
  s3-visible-tees-neon.png
  s3-tee-px-local-crops.png
  s3-remaining-checkerboard.png
  s3-rejected-neon.png
  s3.receipt.txt
```

## Python PxC / PCR / PQL slice

Meaningful S3 material is seeded at:

```text
px.tees.rings.candidates
px.tees.family.measured
px.tees.family
px.tees
px.tees.px
scratch.s3.rejectedCandidates
```

The bounded Python Calculation `fn.quickAnno.s3.summarizeVisibleTees` publishes:

```text
scratch.s3.visibleTeeSummary
```

PQL reads both the summary and rejected-candidate scratch Parts. Mermaid is emitted from the same `S3.quick-anno` PCR.

## Visual materialization contract

The correctness sheet is deliberately evidence-preserving:

1. ring candidates: thick cyan boxes over the source raster;
2. enclosing frames: orange, with accepted common-family frames green;
3. production-visible Tee objects: thick green boxes plus magenta centers;
4. exact TeePx: magenta pixels in 18 enlarged local-context crops, so object identity remains inspectable;
5. actual remaining raster: exact TeePx transparent over checkerboard;
6. production rejection/not-accepted categories: red Badge-muted rings, yellow unframed rings, orange framed candidates outside the selected family.

The source image is never replaced with a black field to make overlays look convincing.

## Checkpoint status

The transfer/materialization implementation is mechanically complete and reproducible, but **S3 correctness is not accepted**. Visual inspection found production-accepted objects at the bottom iOS map chrome; see `S3_VALIDATION.md`.

Per the task boundary, this checkpoint does not change production S3 to remove those objects and does not proceed to S4.
