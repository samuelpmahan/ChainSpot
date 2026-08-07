# Annotate Round: clean-course CV integration

This branch starts from Claude's Phase 3 implementation and records the semantic integration point for the CV work developed on `agent/cv-annotation-core-probes`.

## Key correction: Annotate Round needs two UDisc rasters

The Phase 3 implementation currently treats one UDisc `source-overview` as the place where tee, basket, shot, and corridor geometry are all annotated. The CV experiments showed that this is the wrong production boundary.

We need two logically different UDisc inputs:

1. **Clean course map** — no played-round overlays. This is the best source for static course geometry:
   - hole number badges
   - teepads
   - baskets
   - UDisc hole/corridor raster

2. **Played round map** — contains round-specific overlays. This is the source for dynamic round geometry:
   - shot landing markers
   - pale-blue shot connections
   - purple walking path

The clean course map should be the **canonical annotation coordinate space**.

## Why the clean course map should be canonical

Claude's Create Graphics implementation already has a clean architecture:

`AnnotatedRound source pixels -> source/target alignment -> clean satellite target pixels`

Keep that.

Static features are easiest to detect on the clean UDisc map, so do not detect them there and then force the authoritative artifact back into an occluded played-round coordinate system. Instead:

1. Detect static course features on the clean UDisc map.
2. Detect dynamic round features on the played map.
3. Register played UDisc -> clean UDisc.
4. Transform dynamic detections into clean-UDisc pixels.
5. Review/correct everything in Annotate Round.
6. `Done` emits one authoritative `AnnotatedRound` whose `sourceImage` is the clean UDisc map and whose entire geometry is expressed in clean-UDisc pixels.
7. Create Graphics remains responsible for clean-UDisc -> satellite alignment and rendering.

The played screenshot is evidence used during annotation; once its dynamic features have been reviewed and transformed into canonical coordinates it does not need to be carried by the final `AnnotatedRound` artifact.

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
                    | existing Claude alignment
                    v
          CLEAN SATELLITE / NAIP TARGET
                    |
                    v
              Create Graphics
```

## Registration between the two UDisc rasters

This should be much easier than generic image registration because both captures contain the same repeated UDisc UI grammar.

Preferred automatic correspondences:

1. hole-number badge centers — strongest first choice; current clean-course probe uniquely located all 18/18 badges;
2. basket locations/base points;
3. teepad points once the static detector is reliable.

Estimate a similarity transform first; affine is a reasonable fallback for stitched/cropped capture differences. Manual correction can use the existing correspondence-editor concepts if automatic registration is not good enough.

## CV findings to preserve

From `agent/cv-annotation-core-probes`:

- broad search for hole `#1` is a good UI-scale bootstrap;
- on the clean fixture all 18 number badges can be located uniquely by clustering candidate peaks and solving a one-to-one Hungarian assignment;
- full-course basket template matching reached 18/18 on prior probes;
- the semantic basket endpoint is the **bottom-center base of the basket stem**, not the center of the green/basket treatment;
- moving the tracer's basket terminal from glyph center to stem base improved basket-terminal hits from 13/18 to 16/18 in the current exploratory grower;
- paired-boundary evidence helps but roads can also have two excellent boundaries;
- beam search is premature when the local score is wrong: it tends to produce longer confident wrong traces;
- hole-number-seeded local orientation is useful; continuation/termination is the current hole-shape problem;
- generic gray/low-saturation detection is not a sufficient definition of either a teepad or a hole shape.

## Relationship to Claude's Phase 3 code

Keep:

- `AnnotatedHole.corridor` as the reviewed vector representation of the UDisc hole raster;
- `holeAnnotation.ts` pure edit operations as the manual correction layer;
- `createAnnotatedRound` validation and the authoritative/no-provenance Done boundary;
- `holeGraphics.ts` source->target transform/render path;
- Create Graphics NAIP/geocode/mosaic work;
- current alignment machinery.

Change before CV is wired into production:

- Annotate Round must accept both clean-course UDisc and played-round UDisc inputs;
- image-role/session plumbing needs to distinguish those two inputs;
- static CV proposals should run on the clean map;
- dynamic CV proposals should run on the played map;
- played->clean registration should happen before provisional holes are presented for final review;
- `Done` should use the clean course map as `AnnotatedRound.sourceImage`.

## Suggested role semantics

Minimize downstream changes by treating the existing `source-overview` role as the canonical **clean UDisc course map**, because Create Graphics already understands it as the source side of source->target alignment.

Add one new transient/project role for the played capture, e.g. `round-overview`.

Then:

- `source-overview` = clean UDisc canonical geometry image;
- `round-overview` = played UDisc evidence image;
- `target-basemap` = clean satellite/NAIP image.

Stitch Map should eventually be able to hand a stitched image to either UDisc role. For the immediate clean-course CV iteration, direct upload of the clean map is sufficient; do not block detector work on Stitch Map UX.

## Immediate implementation order

1. Add the second UDisc input/role and make clean UDisc the Annotate Round canonical coordinate space.
2. Reuse Claude's manual annotation UI as review/correction rather than throw it away.
3. Port the proven static primitives first: `#1 -> scale`, joint 18-number assignment, basket template/base point.
4. Finish the strict clean-course static milestone: 18/18 numbers, 18/18 baskets, 18/18 teepads.
5. Continue hole-shape extraction on the clean map.
6. Only then add played-round dynamic extraction and played->clean registration.

This keeps the current work separable: static course parsing can become reliable without route/shot occlusion handling, while Claude's Create Graphics work remains useful almost unchanged downstream.
