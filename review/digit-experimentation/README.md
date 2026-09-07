# Digit experimentation handoff

Comparison base: 56076112878edf4ac167d97c66f9f83082abe2b1.
Continue experiments on this review branch. lab/s0-viewer retains white recognition and shared Comparator machinery only among this checkpoint's additions.

Build: `npm run build --workspace @chainspot/alg`
Reproduce template experiment: `node scripts/run-number-templates.cjs review/digit-experimentation/inset-4-input.json /tmp/s1-number-comparison`

Inputs are measured 4px-inset UnaccountedDigitPx from one capture; labels come from the white matcher. Luna reproduced 18/18 labels with byte-identical normalized digit masks. The supplied compact input preserves samples and labels consumed by the runner.

Feature-discovery and bbox sweep code is preserved for investigation. Depth-limited trees on one example per class were not useful. Tight-cropped templates self-match 18/18. Dice versus symmetric Manhattan Chamfer: right shift 2/18 versus 13/18; down shift 11/18 versus 18/18; synthetic removal/noise conditions all 18/18. These are same-source sensitivity tests, not held-out accuracy. Timing is a single run, not a reliable benchmark.

Next proposed experiment: explicit small translation search. Then independent captures and data-derived acceptance; unresolved Badges go to white matching. No experimental recognizer is promoted. Preserve required Comparators, executable PCR composition, and pixel-level inspection.
