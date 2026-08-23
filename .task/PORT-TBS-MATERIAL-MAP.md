# TBS port — course-local inside-vs-outside material likelihood

Branch: `codex/ab-tbs-material-map`. Port ONE bounded behavior from the Dev72 study: learn a tiny course-local ribbon material model from already-frozen Tee→Badge halves, then score pixels by inside-likelihood versus outside-likelihood. No path search, no basket identity, no trained cross-course model.

Use current straight-test gate (`TBS`, `GS`, etc.). Deviation, default OFF.

## Exact study sampling
For each frozen Tee→Badge segment of length L and renderer width W:
- heading from tee directly to badge
- sample along segment every `3px`
- start `max(12, 0.12*L)`
- stop before `max(13, 0.80*L)`

At each center sample, normal offsets for known INSIDE pixels:
`[-0.30W, -0.15W, 0, +0.15W, +0.30W]`

Known OUTSIDE pixels:
`[-0.90W, -0.75W, -0.65W, +0.65W, +0.75W, +0.90W]`

The gap around the rails is intentional.

Pixel features:
- gray = `(R+G+B)/3`
- chroma = `max(R,G,B)-min(R,G,B)`

Winning direct model used a 2D histogram:
- gray edges `linspace(0,256,25)` => 24 bins
- chroma edges `linspace(0,128,13)` => 12 bins; clip chroma to `<128`
- add-one smoothing to EVERY cell independently for inside and outside histograms
- normalize each histogram to sum 1 after smoothing

Score pixel = `log(P_inside_bin / P_outside_bin)`. Classification boundary in the study was score `>=0`.

Held-out-hole Dev72 direct result: macro IoU ~0.671, precision ~0.735, recall ~0.882. Per-course IoU: Dash .735, Heritage .669, Lenard .546, Towne .733. This is a material prior, not sufficient ownership evidence; Lenard is the main falsifier.

## Knobs
Expose all sampling/bin constants:
- `sampleStepPx=3`
- `segmentStartPxFloor=12`
- `segmentStartFraction=0.12`
- `segmentEndPxFloor=13`
- `segmentEndFraction=0.80`
- inside offset fractions array as above
- outside offset fractions array as above
- `grayBins=24`
- `chromaBins=12`
- `chromaMax=128`
- `histogramPseudoCount=1`
- `decisionLogOdds=0`

Runtime need not do leave-one-hole-out; that was evaluation leakage control. A real course-local model may train on all already-frozen Tee→Badge segments available before scoring the unknown outgoing ribbon.

Export pure sampling/model/scoring functions. Deterministic. Instrument histogram/model counts and emit a heatmap if wired spatially. Do not reject candidates silently. Follow ABFeature contract; parity must not move.
