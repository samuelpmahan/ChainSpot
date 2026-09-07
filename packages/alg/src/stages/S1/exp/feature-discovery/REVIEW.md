# Feature discovery checkpoint

This is an experimental training/inspection composition, not the S1 recognition default.
Requires warm px.s1.exp.badgeAssembly.badgeCandidates and px.s1.discovery.labels.
Labels map Badge IDs to {value, source, captureId}; {} permits unlabeled feature mining.
No labels are inferred from Badge order. White predictions must be identified as such in source.

Decisions exposed for review:
- {InteriorGeometry: bbox inset 2 pixels; four corner rectangles each 15% of interior width and height. These are provisional guesses, not inferred white-border thickness or learned corner shapes.}
- {Canvas: 32x24, aspect-preserving bbox coordinates, centered. Original points survive; no binary resizing or duplicate-pixel loss.}
- {FeatureGrid: 4x3 cells. Occupancy is fraction of retained points. Direction is local PCA, weighted by anisotropy; bend compares adjacent cells and does not assert a traced curve.}
- Tree uses Gini reduction, depth 6. It does not claim globally optimal or cost-optimal splits.
- Boost uses multiclass SAMME, up to 12 stumps. Same measured features, different combination.
- Pair mining uses per-feature median low/high tokens. PCY is checked against exact direct pair counts.
- Triples require all three frequent pairs. 20,000 candidate cap is explicit and reported; truncated output is not exhaustive.
- Model predictions are training-fit only. Unknown labels remain null. No acceptance threshold, white routing, or S1 contract completion is introduced.
- Sensitivity probes shift normalized points by one unit, drop every tenth point, or add neighboring points. Synthetic points retain source references and must not be represented as observed image pixels. These probes are not independent validation captures.
- {ValidationSet: reviewed labels and independent captures are needed for accuracy/acceptance; current code preserves capture identity but does not implement held-out evaluation.}
- Feature renderer consumes saved measurements and caller-selected feature IDs. It does not silently pick winners. No render has been run at this checkpoint.
- Mining combinations are inspectable outputs; feeding conjunctions back into a classifier awaits feature review.
- Comparator compares training predictions and total composition duration. Tree/boost training times are also separate. These timings do not measure deployed lazy inference; discovery intentionally materializes all features.
