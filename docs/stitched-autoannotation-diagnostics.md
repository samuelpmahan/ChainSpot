# Stitched autoannotation stage diagnosis

Fixtures: `GoldenTeeSet.chainspot.zip` / `GoldenBasketSet.chainspot.zip` and
`resources/real-capture/ReferenceStitch.png` (the same course at a larger map
zoom). The stitched truth comparison uses the affine transform fitted from the
18 independently detected numbered badges; 25 native pixels is the reporting
tolerance.

## Failure entry points

- **Baskets:** all 18 correct native template peaks survive local maxima, NMS,
  score floor, bounds, and the 18-candidate cap on both rasters. The observed
  16/18 was not detector recall: the exact-18 physical badge cap admitted a
  false dark body and crowded a real badge out, which changed map bounds and
  downstream grammar. Keeping 24 physical bodies lets glyph assignment label
  the true 18 and leave the extra body unlabeled. The remaining stitched
  basket errors entered in global ownership: a REVIEW tee could permute three
  dense early holes. AUTO tees now reserve via polarity-aware local claims;
  remaining holes solve only the remaining baskets using native distance and
  the median trusted basket distance. This restores semantic ownership 18/18.
- **Tees:** canonical normalization is real (`worldScale = 1.851` stitched,
  `0.998` small). The large count is mostly spatially distinct recovery-tier
  distractors, not a canonical-to-native mapping bug: stitched is 92 raw tier
  hypotheses -> 90 native geometric clusters. Cross-tier NMS merges the two
  genuine overlaps and retains tier/support provenance. Ownership emits 18
  unique semantic results, never clones a physical candidate, and misses only
  stitched H2 in appearance-localization truth.

## Final measured stages

| Fixture | badges | baskets | tee raw | tee native dedup | tee AUTO / REVIEW / NONE | exact tees | duplicate semantic tees | runtime |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| small | 18 labeled / 18 physical | 18/18 semantic | 86 | 83 | 14 / 4 / 0 | 18/18 | 0 | 69.5 s |
| stitched | 18 labeled / 19 physical | 18/18 semantic | 92 | 90 | 14 / 4 / 0 | 17/18 | 0 | 165.3 s |

The high deduped appearance count is intentionally reported, not hidden by a
top-18 slice. The semantic surface is one proposal per hole. H2 on stitched is
the remaining tee appearance miss; badge alignment is not used to manufacture
it.

## Staged artifacts

Each exact CLI run writes `tee-raw.png`, `tee-deduped.png`,
`tee-assigned.png`, `basket-raw.png`, `basket-assigned.png`, `course.png`, and
fully instrumented `course.json` (native/canonical coordinates, dimensions,
orientation, appearance score, tier/support provenance, nearest badge,
badge-axis error, and semantic owner).

- small: `/tmp/chainspot-small-two-stage/`
- stitched: `/tmp/chainspot-big-two-stage/`

## Remaining falsification gap

Stitched H2 remains the one tee appearance miss (575.6 px); it is surfaced as
REVIEW and is not manufactured from its badge axis. Basket detection and
semantic ownership are both 18/18. No hole-path or bend code was changed.
