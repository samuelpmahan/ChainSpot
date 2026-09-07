# S3 validation

S3 continues the validated S1/S2 Python PxC/PQL/PCR transfer pattern from `5c87d48945ecc11b6e1466cfd193b071747238b6` without changing production S3 semantics.

## Reproduce

From repository root:

```sh
python -m pip install -e packages/quick_anno_py
python experiments/quick-anno-python/s3.py \
  ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg
```

The run executes real S0 -> S1 -> S2 -> S3, exports the S3 runtime/PxC material, loads ring candidates / measured frames / selected family / Tee objects / exact TeePx into first-class Python PxC, runs one Python PCR summary Calculation, queries the resulting scratch Parts through PQL, emits Mermaid, and materializes the neon-first correctness sheet.

## Observed Dash's Track production result

```json
{
  "enclosed": 32,
  "elongated": 27,
  "excludedByBadge": 3,
  "ringCandidates": 24,
  "measuredFrames": 20,
  "unframed": 4,
  "family": 18,
  "teeObjects": 18,
  "teePx": 4884,
  "overlapPx": 0,
  "remainingOpaquePx": 2682186
}
```

The bounded Python summary is expected to publish:

```json
{
  "ringCandidates": 24,
  "measuredFrames": 20,
  "family": 18,
  "tees": 18,
  "teePx": 4884,
  "excludedByBadge": 3,
  "unframed": 4,
  "framedOutsideFamily": 2
}
```

Production S3 explicitly reports:

```text
recovery: NOT RUN
component fallback: NOT RUN
materialization: subtraction raster is PCR output only; it is not written to PxC
```

## Visual inspection

Primary artifact:

```text
experiments/quick-anno-python/generated/DashsTrack-S3/s3-neon-correctness-sheet.png
```

The sheet is readable enough to judge the computation directly: source context remains visible behind every global overlay, exact TeePx is enlarged in local context rather than isolated on black, and the remaining raster uses checkerboard transparency for removed TeePx.

### HUH — production-visible Tee set is not materially correct on this input

Expected: the 18 objects at `px.tees` should be visually defensible visible Tee objects before this transfer checkpoint can be accepted as S3 correctness proof.

Encountered: the last three production-accepted objects are located in the bottom iOS map chrome rather than disc-golf Tee evidence:

```text
T16 center ~= (1178.4, 2035.1) — bottom-right MAP/SAT control region
T17 center ~= (143.7, 2051.6) — bottom-left Maps/logo chrome
T18 center ~= (117.5, 2056.6) — bottom-left Maps/logo chrome
```

The exact-pixel local crops make this visible immediately; these are not subtle pixel-level ambiguities.

Current guess: clean S3's ring/frame family semantics are faithfully transferred, but they admit UI-chrome components on this canonical raster. The transfer lane must not silently filter them in Python because that would change production semantics, and the task explicitly forbids threshold/detector redesign here.

Therefore:

- Python transfer pattern: **PASS** — same first-class PxC/PCR/PQL/Mermaid/materialization architecture as S1/S2.
- Reproducibility: **PASS** — deterministic observed counts and exact TeePx subtraction are captured.
- Evidence readability: **PASS** — source context is preserved and the false positives are visibly inspectable.
- Production S3 material correctness on Dash's Track: **FAIL / HUH** — 18 accepted does not equal 18 visually defensible Tee objects.
- S4: **NOT STARTED**.

No convenience was added to PxC/PQL/PCR. The repeated readability friction was handled in the S3 materializer itself by preserving source evidence and adding exact-pixel local-context crops; no new parallel telemetry or semantic store was introduced.
