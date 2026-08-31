# PCR 4 — residue still spells the digit

After fixing the missing dark-counter custody, exact subtraction still leaves structured RGB residue around the digits.

To test whether that residue is real signal rather than arbitrary fringe:

- crop each residual digit with a consistent normalization bbox;
- treat that bbox only as a coordinate frame;
- keep a separate support/mute map so unstable stragglers do not automatically count as evidence;
- fit a deliberately simple leave-one-out nearest-mean residual template matcher across five courses.

Observed result from the scratch reproducer:

- 135 residual digit samples;
- canonical normalization bbox: 22x29;
- accuracy: 130/135 = 96.3%;
- `0`: 5/5;
- `1`: 50/55;
- `2..8`: 10/10 each;
- `9`: 5/5.

All five errors were `1 -> 4`, one from badge `11` on each course. Those failures remain first-class evidence: the neighboring `1` contaminates the normalized crop and demonstrates why normalization support and evidence support must stay separate.

This checkpoint establishes that the post-subtraction residue preserves digit identity. It does not yet claim a final renderer/compositor ontology for that residue.
