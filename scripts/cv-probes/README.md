# CV probes on the Phase 3 integration branch

This directory carries the CV work into the branch based on Claude's Phase 3 implementation.

Read `../../docs/cv-clean-course-pipeline.md` first. Annotate Round needs **two UDisc images**:

- clean course map for static course geometry and canonical coordinates;
- played round map for dynamic shot/walking evidence.

The final `AnnotatedRound` still has one authoritative coordinate space: the clean UDisc map.

## Current static parser

`static_course_parser.py` is now the best clean-course probe on this branch. On the current clean Dash's Track fixture it reaches the strict discrete milestone:

- **18/18 hole numbers**
- **18/18 baskets**
- **18/18 teepads**

The pipeline is deliberately layered:

1. broad `#1` template search derives UI raster scale;
2. all number-template peaks are spatially clustered, then `1..18` are assigned one-to-one with Hungarian matching;
3. basket template matching + NMS finds 18 basket glyphs;
4. basket semantic endpoint is the **bottom-center stem base**, not glyph/green-circle center;
5. teepads use two complementary detectors:
   - low-saturation gray-center rectangle;
   - quadrilateral edge loop with bright rim / gray-ish interior;
6. the two tee detectors each find 16 on the fixture but miss different pads; fusion yields exactly 18;
7. tee-to-hole assignment is one-to-one proximity matching;
8. basket assignment adds tee/number polarity so a basket across the fairway is preferred over a nearby basket beside the tee;
9. provisional hole corridors are built with a bounded dynamic-programming tracker from `tee -> number -> basket base`, then cross-sectional edge estimates form a polygon.

The key shape change is that the corridor tracker is **not a free grower anymore**. Every state stays within a bounded lateral displacement from an endpoint-anchored segment, so the Hole 16 road failure and neighboring-hole runaway cannot become arbitrarily long excursions. Corridor polygons are still research-quality proposals and must remain editable in Annotate Round.

Run shape:

```text
python scripts/cv-probes/static_course_parser.py clean-course.png \
  --templates ./templates \
  --out ./cv-out
```

Outputs:

- `report.json` — detector counts / run summary;
- `proposals.json` — tee, basket-base, and corridor proposal geometry in clean-UDisc pixels;
- `static-parser-overlay.png` — visual diagnostic.

## What is strong vs provisional

Strong on the current clean fixture:

- `#1 -> UI scale` bootstrap;
- 18 unique number locations;
- 18 basket detections;
- 18 teepad detections via dual-detector fusion;
- basket stem-base endpoint definition.

Provisional / still needs multi-fixture validation:

- tee-to-hole assignment in dense clusters;
- basket-to-hole assignment in dense clusters;
- corridor centerlines and polygons;
- all thresholds across Android / different UDisc raster assets.

Do not turn internal CV confidence into fields on final `AnnotatedRound`. CV results are proposals in Annotate Round; after user review and Done, geometry is authoritative.

## Earlier hole-shape experiments

The free number-seeded tracer was evaluated with three isolated changes:

1. paired-boundary evidence;
2. beam search;
3. basket terminal behavior.

Findings preserved in the current parser design:

- paired boundaries help, but a real road can also have excellent parallel boundaries;
- beam search is premature when the local score is imperfect and tends to create longer confident wrong paths;
- semantic basket stopping is useful and should target the stem base;
- nearest reachable basket is not sufficient association logic.

The old free-tracer implementation remains on `agent/cv-annotation-core-probes` for comparison. The integration branch intentionally moves toward discrete static anchors first, then bounded corridor refinement.

## Claude Phase 3 pieces to keep

- `AnnotatedHole.corridor` as reviewed vector geometry;
- `holeAnnotation.ts` as manual correction operations;
- the authoritative/no-provenance Done boundary;
- Create Graphics source->target alignment;
- `holeGraphics.ts` rendering;
- NAIP/geocode/mosaic work.

The manual UI is not throwaway work. Static CV should populate draft proposals into that review layer; dynamic played-round CV comes later after played->clean registration.