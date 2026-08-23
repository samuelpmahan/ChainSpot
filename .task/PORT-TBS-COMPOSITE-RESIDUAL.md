# TBS port — outside→inside composite residual

Branch: `codex/ab-tbs-composite-residual`. Port ONE bounded behavior from the fresh Dev72 quick pass: learn the renderer transformation across known rails, then score proposed rail samples by residual. This is not literal alpha recovery; the screenshot is flattened. The bounded object is a deterministic per-channel affine outside→inside transform.

Use current straight-test gate (`TBS`, `GS`, etc.). Deviation, default OFF.

## Exact training sample geometry
From already-frozen Tee→Badge segments, sample each segment polyline every `4px`. Skip the first 3 generated samples and the last 4 generated samples. For each remaining center point and both rail signs:
- rail center = center + `sign*(W/2)*normal`
- inward direction = `-sign`
- inside sample C = rail + inward * `edgeDeltaPx` * normal
- outside/background sample B = rail - inward * `edgeDeltaPx` * normal
- quick-pass `edgeDeltaPx=3`
- skip a sample when the rail center lies inside the known badge bbox expanded by `badgeSkipPadPx=2`

## Exact fitted transform
Fit each RGB channel independently by ordinary least squares:

`C_ch = a_ch * B_ch + k_ch`

Use design matrix `[B_ch, 1]`; no regularization. Output six coefficients `(aR,aG,aB,kR,kG,kB)`.

For a pair `(B,C)`, predicted inside is `Cpred = B * a + k` componentwise. Residual:

`sqrt(mean((C - Cpred)^2 over RGB))`

Training residual scale used in the quick pass:
`sigma = max(2, q75(training residuals))`

The first experiment used residual directly for ranking (lower = more ribbon); sigma was recorded but not needed for AUC. Do not invent a probability transform unless exposed explicitly.

Held-out-hole quick-pass separation against HARD negatives chosen because they had strong ordinary positive edge lift: true median residual ~13.9 RGB units versus hard-negative ~29.5. Mean residual AUC ~.664 versus edge-only mean AUC ~.584. By course median residual AUC: Dash ~.693, Heritage ~.787, Lenard ~.573, Towne ~.694. Lenard is the falsifier: composite residual is useful but not sufficient alone.

Observed fitted coefficients varied heavily by course (e.g. median channel slopes roughly Dash .31-.33, Heritage .60, Lenard .21-.26, Towne .53-.56). Therefore DO NOT hard-code a universal alpha/overlay color. This feature is specifically course-local adaptation; a later global seed may regularize it.

## Knobs
Expose:
- `sampleStepPx=4`
- `skipStartSamples=3`
- `skipEndSamples=4`
- `edgeDeltaPx=3`
- `badgeSkipPadPx=2`
- `residualScaleQuantile=0.75`
- `residualScaleFloor=2`

Export pure pair collection (given raster/known segments), affine fit, and residual scorer. No randomness. If wired as a rejector, rejected drawables must contain observed residual and threshold. Do not combine minRequiredRun in this branch; that has its own port. Follow ABFeature contract; parity must not move.
