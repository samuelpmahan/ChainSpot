# Dash's Track — S3 clean checkpoint

Human-reviewable source: DashsTrack-full.jpg

## Semantic result

- TP: 15
- FP: 3
- FN: 3
- matched tee localization: ~0.1–1.3 px from semantic truth after S0 crop offset

## Tick / Calculation funnel

- `Tee.detectRings` / `fn.Tee.detectRings`
  - enclosed: 32
  - elongated: 27
  - badge-excluded: 3
  - candidates: 24
- `Tee.findFamily` / `fn.Tee.findFamily`
  - measured: 20
  - unframed: 4
  - selected family: 18
- `Tee.findPx` / `fn.Tee.findPx`
  - final Tee Parts: 18

## False-negative provenance

- Hole 3: absent at `fn.Tee.detectRings`; no nearby ring candidate (~141 px nearest). First-pass detection miss.
- Hole 5: ring candidate exists (~47 px from truth), survives candidate filtering, then has no enclosing bright frame and lands in `family.unframed`. Pruned in `fn.Tee.findFamily` frame association.
- Hole 12: ring detected ~6.1 px from truth, valid enclosing frame enters `family.measured`, then `selectTeeFamily()` rejects its 171 px frame as outside the selected common family. Pruned inside `fn.Tee.findFamily`.

## False positives

Final unmatched Tee Parts are bottom-edge junk, approximately:
- (1178, 2035)
- (144, 2052)
- (118, 2057)

They are not semantic matches for holes 3, 5, or 12.

## Stage semantics

S3 is visible-tee first pass. Occluded-object recovery belongs explicitly to S4. This receipt preserves where each missing semantic Tee disappeared so S4 can consume the long tail without pushing recovery heuristics backward into S3.
