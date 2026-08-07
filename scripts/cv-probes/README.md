# CV probes on the Phase 3 integration branch

This directory carries the CV work into the branch based on Claude's Phase 3 implementation.

Read `../../docs/cv-clean-course-pipeline.md` first. Annotate Round needs **two UDisc images**:

- clean course map for static course geometry and canonical coordinates;
- played round map for dynamic shot/walking evidence.

The final `AnnotatedRound` still has one authoritative coordinate space: the clean UDisc map.

## Current static parser

`static_course_centerline.py` is now the preferred clean-course probe. It reuses the proven discrete detectors in `static_course_parser.py`, but changes the geometry target from a ribbon polygon to a **tee-to-basket centerline**.

On the current clean Dash's Track fixture it produces:

- **18/18 hole numbers**
- **18/18 baskets**
- **18/18 teepads**
- **18/18 centerline proposals**

The important product decision is that UDisc's band width is presentation, not course truth. ChainSpot should extract routing geometry and let the creator's style preset choose band width, outline/hatch/solid treatment, palette, and chrome.

### Pipeline

1. broad `#1` template search derives UI raster scale;
2. all number-template peaks are clustered, then `1..18` are assigned one-to-one with Hungarian matching;
3. basket template matching + NMS finds 18 basket glyphs;
4. basket semantic endpoint is the **bottom-center stem base**;
5. teepads fuse two complementary detectors (gray-center rectangle + bright-rim quadrilateral), yielding 18/18 on the fixture;
6. tee and basket candidates are assigned one-to-one to holes;
7. outside the putting circles, bounded DP tracks `tee -> number -> C2 entry`;
8. C1/C2 are detected as repeated basket-centered radial edge peaks across all 18 holes;
9. pixels inside C2 are treated as foreground contamination, not fairway evidence;
10. the final C2 segment is reconstructed geometrically from the detected C2 entry to the basket stem base.

On the current fixture the repeated radial peaks recover approximately:

- C1 radius: **25 px**
- C2 radius: **50 px**

That directly addresses the previous failure where basket / C1 / C2 artwork distorted the final ~60 ft of the inferred route.

Run:

```text
python scripts/cv-probes/static_course_centerline.py clean-course.png \
  --templates ./templates \
  --out ./cv-out
```

Outputs:

- `report.json` — counts, putting-circle radii, centerline point counts;
- `proposals.json` — number badge, tee, basket base, centerline, and C2 entry for every hole;
- `static-centerline-overlay.png` — full-course visual diagnostic with all static annotations.

`static_course_parser.py` remains as the v1 polygon experiment and supplies the shared proven detector/assignment helpers. Do not delete it yet; it is useful comparison history.

## Representation direction

The parser should converge on something like:

```ts
interface ParsedHole {
  number: number;
  tee: SourcePoint;
  basket: SourcePoint;
  centerline: SourcePoint[];
}
```

The final renderer can generate a constant-width band, outline, hatch, centerline-only treatment, contour overlay, or other visual styles from the same centerline. Boundary extraction is no longer a static-parser stopping requirement.

This implies a later Phase 3 domain change: `AnnotatedHole.corridor` should be replaced or supplemented by authoritative centerline geometry, and `holeGraphics.ts` should construct presentation width after source-to-target transformation rather than preserving UDisc's source raster width.

## Strong vs provisional

Strong on the current clean fixture:

- `#1 -> UI scale`;
- 18 unique number locations;
- 18 basket detections;
- 18 teepad detections;
- basket stem-base endpoint;
- repeated C1/C2 radius recovery.

Still provisional / needs more fixtures:

- tee-to-hole assignment in dense clusters;
- basket-to-hole assignment in dense clusters;
- centerline routing through the densest overlapping 4–7 area;
- thresholds across Android and other UDisc raster/scaling variants.

Do not put CV confidence/provenance on final `AnnotatedRound`. These are review-layer proposals; after correction and Done, geometry is authoritative.
