# CV probes on the Phase 3 integration branch

This directory carries the proven/experimental CV work into the branch based on Claude's Phase 3 implementation.

Read `../../docs/cv-clean-course-pipeline.md` first. The important integration correction is that Annotate Round needs **two UDisc images**:

- clean course map for static course geometry and canonical coordinates;
- played round map for dynamic shot/walking evidence.

The final `AnnotatedRound` should still contain one authoritative coordinate space: the clean UDisc map.

## Proven enough to preserve

- `#1 -> UI scale` bootstrap (`scale_anchor.py`).
- Joint hole-number assignment: collect candidate peaks, cluster physical badge locations, then solve a one-to-one `1..18` assignment. On the clean fixture this reached 18/18 unique number locations with minimum assigned template score about 0.914.
- Basket raster/template matching reached 18/18 on the clean-course work.
- Basket geometry should use the **bottom-center stem base** as the semantic hole endpoint, not the glyph/green-circle center. In the exploratory tracer this changed basket terminal hits from 13/18 to 16/18.

## Hole-shape experiments

The exploratory number-seeded tracer was evaluated on all 18 holes with three isolated changes:

1. paired-boundary evidence;
2. beam search;
3. basket terminal behavior.

Findings:

- number-seeded initial orientation is useful;
- paired boundaries help but do not distinguish a UDisc ribbon from a real road/path, which can also have two excellent edges;
- beam search is premature while the local score is imperfect and tends to produce longer, more confident wrong traces;
- semantic basket stopping is useful and should target the stem base;
- wrong-hole capture remains possible, so nearest reachable basket is not sufficient association logic.

The full exploratory implementation remains on `agent/cv-annotation-core-probes` as `scripts/cv-probes/hole_shape_three_variants.py`. It is intentionally not production code yet.

## Static stopping requirement

Before dynamic played-round parsing is wired in, a clean UDisc course screenshot should satisfy:

- 18/18 hole numbers;
- 18/18 baskets;
- 18/18 teepads.

Stretch: every tee and basket assigned to the correct hole.

Hole-shape extraction is a separate iterative layer; do not weaken the static-icon milestone just because corridor work is still researchy.

## Claude Phase 3 pieces to keep

- `AnnotatedHole.corridor` as reviewed vector geometry;
- `holeAnnotation.ts` as manual correction operations;
- the authoritative/no-provenance `Done` boundary;
- Create Graphics source->target alignment;
- `holeGraphics.ts` rendering;
- NAIP/geocode/mosaic work.

The manual UI is not throwaway work. CV should populate **proposals/draft annotations into that review layer**, after which user edits become authoritative at Done.
