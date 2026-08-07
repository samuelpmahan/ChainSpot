# Annotate Round: clean-course CV integration

This branch starts from Claude's Phase 3 implementation and records the semantic integration point for the CV work developed on `agent/cv-annotation-core-probes`.

## Key correction: Annotate Round needs two UDisc rasters

The Phase 3 implementation currently treats one UDisc `source-overview` as the place where tee, basket, shot, and corridor geometry are all annotated. The CV experiments showed that this is the wrong production boundary.

We need two logically different UDisc inputs:

1. **Clean course map** — no played-round overlays. Best source for static course geometry:
   - hole number badges
   - teepads
   - baskets
   - UDisc hole/corridor raster
2. **Played round map** — round-specific overlays:
   - shot landing markers
   - pale-blue shot connections
   - purple walking path

The clean course map should be the **canonical annotation coordinate space**.

## Pipeline

```text
                    CLEAN UDISC COURSE MAP
                            |
                            | static CV
                            v
               numbers / tees / baskets / corridors
                            |
                            | canonical coordinate space
                            |
PLAYED UDISC ROUND MAP      |
          |                 |
          | dynamic CV      |
          v                 |
 shots / connections / walk |
          |                 |
          +-- register -----+
              played -> clean
                    |
                    v
             provisional holes
                    |
                    v
            Annotate Round review
                    |
                   Done
                    |
                    v
      AnnotatedRound (all geometry in clean-UDisc px)
                    |
                    | existing Phase 3 alignment
                    v
          CLEAN SATELLITE / NAIP TARGET
                    |
                    v
              Create Graphics
```

Static features are easiest to detect on the clean UDisc map, so do not detect them there and then force the authoritative artifact back into an occluded played-round coordinate system. Detect static geometry on clean UDisc, transform dynamic played-round evidence into that same coordinate system, review once, then let Create Graphics keep its existing clean-UDisc -> satellite alignment.

## Current static parser milestone

`scripts/cv-probes/static_course_parser.py` is the current best probe. On the clean Dash's Track development fixture it now reaches the explicit static-icon stopping bar:

- **18/18 hole numbers**
- **18/18 baskets**
- **18/18 teepads**

That is materially better than the earlier state where teepads were the weak detector.

### Number layer

1. Search canonical `#1` over a broad scale range.
2. Derive UI raster scale from the matched badge dimensions.
3. Search all `1..18` templates only in a narrow scale window.
4. Cluster physical badge locations before classification.
5. Solve one-to-one number assignment with Hungarian matching so multiple templates cannot claim the same badge.

### Basket layer

- Multiscale template matching + NMS reaches 18 detections on the clean fixture.
- The semantic hole endpoint is the **bottom-center base of the basket stem**, not the center of the basket glyph or green circle.
- This endpoint rule came from the earlier tracer experiment where stem-base stopping improved terminal hits from 13/18 to 16/18.

### Teepad layer

One detector was not enough, but two simple detectors have complementary failures:

- **gray-center detector** — repeated low-saturation gray interior rectangle;
- **edge-loop detector** — quadrilateral edge loop with bright rim and gray-ish interior.

On the fixture each finds 16 pads and misses a different two. Fusing their centers yields exactly 18 physical teepads. This is preferable to reviving the old generic `gray rectangle` detector, which produced dozens of false positives.

### Static association

The parser currently proposes one tee and basket per number:

- tees: one-to-one proximity matching against number badges;
- baskets: one-to-one matching with a tee/number polarity term, preferring a basket on the opposite side of the number from its tee.

That polarity rule fixes the obvious nearest-basket failure on Hole 1. Dense upper-course associations remain provisional until validated on more fixtures.

## Hole shape: current best direction

The earlier free grower had a fundamental failure mode: once its local score preferred a road or neighboring hole, beam search merely found a longer, more confident wrong answer.

The current parser therefore changes the shape problem structurally:

1. tee, number, and basket base are discrete anchors first;
2. track `tee -> number` and `number -> basket` separately;
3. each segment uses smooth dynamic programming over bounded **lateral offsets** from its endpoint-anchored baseline;
4. no state can wander arbitrarily far from the intended hole;
5. estimate left/right ribbon boundaries from cross-sectional feature gradients;
6. simplify those boundaries into an `AnnotatedHole.corridor` proposal polygon.

This keeps the useful local ribbon score while removing the most embarrassing free-growth failure mode. It also naturally makes Hole 16's road a local scoring nuisance rather than an unlimited escape route.

Corridors are still the researchy part. The generated polygon is a **proposal for the existing manual review UI**, not something to bless directly into final `AnnotatedRound` without inspection.

## Registration between clean and played UDisc

This should be easier than generic image registration because both captures contain the same UDisc UI grammar.

Preferred automatic correspondences:

1. hole-number badge centers;
2. basket stem-base points;
3. teepad centers.

Estimate similarity first; affine is a reasonable fallback for stitched/cropped capture differences. Manual correction can reuse the existing correspondence-editor concepts if automatic registration is not good enough.

## Relationship to Claude's Phase 3 code

Keep:

- `AnnotatedHole.corridor` as reviewed vector geometry;
- `holeAnnotation.ts` pure edit operations as the manual correction layer;
- `createAnnotatedRound` validation and the authoritative/no-provenance Done boundary;
- `holeGraphics.ts` source->target transform/render path;
- Create Graphics NAIP/geocode/mosaic work;
- current alignment machinery.

Change before CV is wired into production:

- Annotate Round must accept both clean-course UDisc and played-round UDisc inputs;
- image-role/session plumbing needs to distinguish those two inputs;
- static CV proposals run on the clean map;
- dynamic CV proposals run on the played map;
- played->clean registration happens before provisional holes are presented for final review;
- `Done` uses the clean course map as `AnnotatedRound.sourceImage`.

## Suggested role semantics

Minimize downstream changes:

- existing `source-overview` = **clean UDisc canonical map**;
- new `round-overview` = **played UDisc evidence image**;
- existing `target-basemap` = **clean satellite/NAIP image**.

Stitch Map should eventually hand a stitched image to either UDisc role. Do not block static-detector work on that UX.

## Immediate implementation order

1. Validate `static_course_parser.py` against additional clean UDisc captures, especially Android / different raster scales.
2. Correct any remaining static association failures while preserving the now-achieved 18/18 icon counts.
3. Iterate corridor proposals with the endpoint-constrained tracker; manual review remains mandatory.
4. Add `round-overview` and make clean UDisc the Annotate Round canonical source.
5. Port stable static primitives from Python to the existing OpenCV.js/WASM stack.
6. Add played-round dynamic extraction and played->clean registration.

Keep provisional CV confidence inside Annotate Round review state only. Final `AnnotatedRound` geometry remains authoritative after Done and must not gain CV provenance/confidence fields.