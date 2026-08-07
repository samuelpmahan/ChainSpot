# Annotate Round: clean-course CV integration

This branch starts from Claude's Phase 3 implementation and records the semantic integration point for the CV work.

## Two UDisc rasters, one canonical coordinate space

Annotate Round needs two logically different UDisc inputs:

1. **Clean course map** — static course geometry: numbers, tees, baskets, routing.
2. **Played round map** — dynamic evidence: shot landings, pale-blue shot connections, purple walking path.

The clean course map is the canonical annotation coordinate space. Dynamic played-round detections are registered into clean-UDisc pixels before review. `Done` emits one authoritative `AnnotatedRound` in clean-UDisc coordinates; Create Graphics then keeps the existing clean-UDisc -> satellite alignment.

```text
CLEAN UDISC COURSE MAP
        | static CV
        v
numbers / tees / baskets / centerlines
        |
        | canonical clean-UDisc pixels
        |
PLAYED UDISC ROUND MAP
        | dynamic CV
        v
shots / walk
        | played -> clean registration
        +-----------------------> provisional holes
                                      |
                                Annotate Round review
                                      |
                                     Done
                                      |
                                AnnotatedRound
                                      |
                              source -> satellite
                                      v
                                Create Graphics
```

## Static parser stopping bar

The current clean Dash's Track fixture reaches:

- **18/18 hole numbers**
- **18/18 baskets**
- **18/18 teepads**
- **18/18 tee-to-basket centerline proposals**

The preferred probe is now `scripts/cv-probes/static_course_centerline.py`. It reuses the proven detector/assignment layer from `static_course_parser.py`.

## Representation breakthrough: extract routing, not UDisc width

UDisc's translucent hole band is presentation, not reliable fairway truth. ChainSpot does not need to reproduce its width or boundary precisely. The static parser should recover:

```ts
interface ParsedHole {
  number: number;
  tee: SourcePoint;
  basket: SourcePoint;
  centerline: SourcePoint[];
}
```

Rendering owns the rest: band width, solid/outline/hatch/centerline-only treatment, palette, contour treatment, information blocks, and framing. A creator preset can therefore style an entire season consistently from the same geometry.

This also makes elevation straightforward later: transform/sample centerline points to lat/lon, query elevation along that 1D path, and draw a profile. No contour-line CV is required.

## Proven discrete layers

### Numbers

1. Search canonical `#1` broadly to derive UI raster scale.
2. Search all `1..18` templates only near that scale.
3. Cluster physical badge locations.
4. Solve one-to-one number assignment with Hungarian matching.

The current fixture produces 18 unique badge locations.

### Baskets

- Multiscale template matching + NMS produces 18 basket detections.
- The semantic endpoint is the **bottom-center basket stem base**, not the glyph/circle center.

### Teepads

Fuse two complementary detectors:

- low-saturation gray-center rectangle;
- quadrilateral edge loop with bright rim / gray-ish interior.

Each finds 16 on the current fixture and misses a different two; fusion yields all 18.

### Static association

- tees: one-to-one proximity assignment to number badges;
- baskets: one-to-one assignment with tee/number polarity so the far-side basket is preferred over a nearby basket beside the tee.

Dense clusters remain provisional until more clean fixtures are available.

## Centerline extraction

Outside the basket decoration, the tracker remains deliberately bounded:

1. track `tee -> number` with DP over lateral offsets from the anchored baseline;
2. independently locate where the route enters C2;
3. track `number -> C2 entry` with the same bounded DP;
4. reconstruct the final C2 segment geometrically to the basket stem base;
5. lightly smooth while snapping tee, number, and basket anchors back exactly.

This keeps roads and neighboring holes from becoming unlimited escape routes while avoiding unnecessary boundary segmentation.

## C1/C2 are foreground occlusion, not fairway evidence

The previous parser consistently damaged the final ~60 ft because UDisc adds basket / C1 / C2 artwork over the underlying route.

The new parser detects the repeated putting-circle radii directly by aggregating basket-centered radial edge strength across all 18 holes. On the current fixture the common peaks are approximately:

- **C1: 25 px**
- **C2: 50 px**

The C2 entry search works **backward from the basket** but scores pixels only outside C2. Inside C2, appearance is ignored entirely; a smooth terminal segment connects the detected entry to the known basket stem base.

That is an explicit semantic rule, not an attempt to make the local CV score explain foreground putting-circle graphics.

## Relationship to Claude's Phase 3 code

Keep:

- `holeAnnotation.ts` as the manual review/correction layer;
- `createAnnotatedRound` validation and authoritative/no-provenance Done boundary;
- Create Graphics alignment, NAIP/geocode/mosaic work, and rendering structure.

Change later when the parser is wired into production:

- add `round-overview` for the played UDisc evidence image;
- keep `source-overview` as the canonical clean UDisc map;
- replace or supplement `AnnotatedHole.corridor` with authoritative `centerline` geometry;
- have `holeGraphics.ts` generate presentation-width bands from transformed centerlines instead of preserving a source-raster polygon;
- static CV proposals run on clean UDisc;
- dynamic CV proposals run on played UDisc and are registered into clean coordinates before review.

Suggested roles:

- `source-overview` = clean UDisc canonical map;
- `round-overview` = played UDisc evidence map;
- `target-basemap` = clean satellite/NAIP image.

## Immediate order

1. Validate the centerline parser against more clean UDisc captures, especially Android/different zooms.
2. Fix any dense-cluster tee/basket association errors without weakening 18/18 icon detection.
3. Port the stable static parser primitives to the existing OpenCV.js/WASM stack.
4. Change the review/domain representation from corridor-first to centerline-first.
5. Add the played-round input and played -> clean registration.
6. Add dynamic shot/walking extraction.

CV confidence/provenance stays inside Annotate Round review state only. After Done, geometry is authoritative.