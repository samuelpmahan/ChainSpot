# Straight-hole edge-pattern search

The original sampler ran on nine annotation-selected straight DashsTrack holes
plus H18 as the reference. Source review found opposing waves on straight H16
at 57–107 px beyond Badge and H11 at 40–90 px. Those windows retain positive
edge support: this recurring pattern does not require the ray to leave a ribbon.
The cause is unresolved; no pathfinding improvement is claimed.

Run `bash exp/straight-edge-pattern/run.sh` from this directory after the
checkpoint's `prepare.py`. This saves all readings, searches, parity, and figures.
Node 24 strips the sampler's TypeScript types. Source bands are saved in
`output/bands.json`; negative distances are before the Badge.

The sampler is the recovered original `sampleFourLaneBand`, preserving signed
inside-minus-outside measurements. It samples five points along the heading.
The sideways grid spans -60..60 px at 0.5 px spacing, and the longitudinal grid
spans -220..300 px at 1 px spacing. These are observation limits, not width or
hole-length constraints. Known Badge bboxes are masked. Other glyphs and circles
remain in the observations and must be inspected when interpreting patterns.

Annotations select straight examples and supply inspection landmarks. They do
not steer the sampling ray, which follows the saved Tee-to-Badge heading.
H3 and H12 use annotation-assisted Tee seeds, retained in inputs.json.

## What was searched

Two questions are recorded separately in `search.py`:

1. Shape similarity to H18 d105–155: no side swap, time reversal, stretching,
   or smoothing. Search both original +/-20 readers and movable offsets.
   Correlations rank candidates for inspection; they are not probabilities.
2. Opposite movement between the original two readers: every available 50 px
   window within the annotated Tee/Basket extent, inset 15 px. This found H16
   and H11 without moving the readers. Windows can include range-circle pixels.

Every straight hole's best result is retained, including poor matches. The best
individual-curve match (H11 after lateral search) is NOT the strongest opposite
pair. These questions must not be collapsed into a success count.

`verify.py` compares 5,719 overlapping original-reader values with the original
script's outputs: exact equality, maximum difference zero. This verifies the
sampler reconstruction, not the interpretation of curve recurrence.

![Source-backed recurrence](output/straight-edge-recurrence.png)

![Two-dimensional H16 readings](output/H16-two-dimensional-readings.png)

The H16 field keeps the straight boundaries visible while their sampled
strengths vary. Small boundary displacement, background variation and raster
sampling remain competing explanations; this run does not identify their cause.
