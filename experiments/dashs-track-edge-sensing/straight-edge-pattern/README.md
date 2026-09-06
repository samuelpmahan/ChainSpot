# Straight-hole edge-pattern search — checkpoint

Current state: the original sampler has run on nine annotation-selected straight
DashsTrack holes plus H18 as the reference. Pattern matching and source review
are in progress; no detection improvement is claimed by this checkpoint.

Run `node exp/straight-edge-pattern/sample.mjs` from this directory.
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
