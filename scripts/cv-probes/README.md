# CV probes on the Phase 3 integration branch

This directory carries the clean-course CV work into the branch based on Claude's Phase 3 implementation.

Read `../../docs/cv-clean-course-pipeline.md` first. Annotate Round ultimately needs two UDisc images: a clean course map for canonical static geometry and a played-round map for dynamic evidence.

## Current clean-course parser

Discrete detection remains in `static_course_parser.py`; centerline experiments build on top of it.

On the current clean Dash's Track fixture the parser reaches:

- **18/18 hole numbers**
- **18/18 baskets**
- **18/18 teepads**
- **18/18 tee-to-basket centerline proposals**

UDisc's translucent band width is now treated as presentation, not course truth. The intended product representation is:

```ts
interface ParsedHole {
  number: number;
  tee: SourcePoint;
  basket: SourcePoint;
  centerline: SourcePoint[];
}
```

The renderer owns band width, outline/hatch/solid treatment, palette, and other styling.

## Semantic centerline correction

`static_course_centerline_semantic.py` is the newest centerline probe.

The motivating failure was Hole 5 in the dense 4–7 cluster. Hole 6's tee sits almost beside Hole 5's basket. A naive basket-backward tracer therefore sees Hole 6's fairway as excellent local evidence and follows Hole 6 toward its number before eventually reconnecting to Hole 5's tee.

That is not merely an appearance problem; it is an **ownership/topology** problem.

The corrected rules are:

1. the current hole's number badge is strong routing/ownership evidence;
2. the badge pixels themselves are foreground UI and therefore an occlusion, not fairway pixels;
3. trace from the tee to the near edge of the own-number badge;
4. trace backward from the basket/C2 side toward the far edge of the own-number badge;
5. bridge through the badge geometrically instead of tracing around its black/white raster;
6. when selecting a C2 departure direction, a ray that runs through another hole's tee very close to the current basket is explicitly penalized;
7. inside C2, ignore appearance and reconstruct the terminal to the basket stem base.

This preserves the useful 'look backward and tolerate obstruction' idea without demoting the number badge to a weak hint. For H5 specifically, the own `5` badge keeps the route on Hole 5 while the nearby H6 teepad becomes negative semantic evidence.

The older `static_course_centerline.py` is retained as comparison history; it is the simpler v2 that first introduced centerlines and the C2 semantic-occlusion rule.

## Static primitives currently working on the fixture

- broad `#1` search -> UI scale;
- joint 1..18 number assignment via clustered template peaks + Hungarian matching;
- 18/18 basket template detections;
- basket semantic endpoint = bottom-center stem base;
- 18/18 teepads from gray-center + edge-loop detector fusion;
- repeated radial edge aggregation recovers approximately **C1 = 25 px** and **C2 = 50 px**.

## What remains provisional

The clean fixture is now much more useful as a failure suite, but this is still probe code. The remaining work is mostly:

- validate association and centerline routing on additional clean UDisc courses;
- stress dense overlapping / opposite-direction fairways like H5/H6;
- port proven pieces to the existing OpenCV.js/WASM runtime;
- wire proposals into Annotate Round's manual review layer;
- later add played-round dynamic extraction and played->clean registration.

Do not put CV confidence/provenance on final `AnnotatedRound`. CV results are proposals before Done; reviewed geometry is authoritative afterward.
