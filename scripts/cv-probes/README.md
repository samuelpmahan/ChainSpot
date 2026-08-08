# CV probes on the Phase 3 integration branch

This directory carries the clean-course CV work into the branch based on Claude's Phase 3 implementation.

Read `../../docs/cv-clean-course-pipeline.md` first. Annotate Round ultimately needs two UDisc images: a clean course map for canonical static geometry and a played-round map for dynamic evidence.

## Current clean-course parser

Discrete detection remains in `static_course_parser.py`; centerline experiments build on top of it.

On the original clean UDisc-screenshot dev fixture (never checked into the repo — see
`docs/cv-tee-basket-detection-gap-plan.md`), the parser reaches:

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

## Semantic centerline correction: `semantic_exact_anchor.py`

`semantic_exact_anchor.py` (v4) is the current, canonical centerline probe — a from-scratch
rewrite, not built on top of `static_course_centerline.py`/`static_course_centerline_semantic.py`
(v2/v3). It combines everything the v2 -> v3 -> v3.1 -> v3.2 chain iterated toward: exact
hole-number-badge-center anchoring, glyph-only number labeling (`number_badge_classifier.py`),
and the H5/H6 ownership correction below. `run_full_rerun.py` treats it as canonical.

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

**First real-data validation (this session):** every prior run of this pipeline — all four
centerline iterations, `run_full_rerun.py` — only ever ran against a single, never-committed local
image. Running `semantic_exact_anchor.py` against `resources/GoldenTeeSet.chainspot.zip`'s real
photographed capture immediately hit `static milestone not met: numbers=18, baskets=4, tees=64`,
because it reuses `static_course_parser.py`'s original `detect_baskets`/`detect_tees` — the exact
bugs already found and fixed in the TS port (`src/lib/autoAnnotation/basketTemplateDetection.ts`,
`teePadDetection.ts`), never fixed here. Feeding it ground-truth tee/basket endpoints (from
`GoldenTeeSet`/`GoldenBasketSet`) to isolate the tracker from that separately-tracked detector gap:
**the tracker itself held up** — every hole stayed correctly on its own route, including the dense
clusters, with no cross-hole confusion.

That run also surfaced a real, independent bug: `detect_putting_circle_radii`'s search ranges
(originally 15-35px for C1, 36-80px for C2) were tuned to the old dev fixture's pixel scale and
mostly measured basket-icon edges, not real putting-circle edges, on this image. Measured directly
(median radial edge score across all 18 baskets): a clean, sharp peak at **C1 ≈ 92px** on this
fixture — nothing close to it in the original search range. Fix: widen the C1 search to where the
signal actually is, and derive **C2 = 2 × C1** from disc golf's fixed ratio rather than an
independent search — C2's dashed rendering dilutes a simple radial-mean edge score too much to
find reliably on its own. Not yet ported into `semantic_exact_anchor.py` itself (validated via an
ad hoc bridge script, not committed here) — worth doing before this probe is trusted further.

The older `static_course_centerline.py` (v2) and `static_course_centerline_semantic.py` (v3) are
retained — not as pure history, but because `ribbon_centerline_experiments.py` (a separate
band/ribbon-width research thread) still imports both. `static_course_centerline_semantic_exact_anchor.py`
(v3.1) and `static_course_centerline_semantic_glyph.py` (v3.2) — pure intermediate steps toward v4,
nothing else depended on them — and the orphaned `scale_anchor.py` bootstrap experiment (its idea
is fully absorbed into `static_course_parser.py`'s `ui_scale_from_hole_one`) were deleted this
session as dead weight.

## Static primitives currently working on the fixture

- broad `#1` search -> UI scale;
- joint 1..18 number assignment via clustered template peaks + Hungarian matching;
- 18/18 basket template detections;
- basket semantic endpoint = bottom-center stem base;
- 18/18 teepads from gray-center + edge-loop detector fusion;
- repeated radial edge aggregation recovers approximately **C1 = 25 px** and **C2 = 50 px** on the
  original dev fixture — see the real-data validation note above for why these numbers are
  fixture-specific, not universal, and need re-deriving per capture rather than hard-coding.

## What remains provisional

- validate association and centerline routing on additional real, non-UDisc-screenshot courses
  (only one has been tried, per the note above);
- port the C1/C2 search-range fix into `semantic_exact_anchor.py` itself;
- port proven pieces to the existing OpenCV.js/WASM runtime — nothing in this directory has a TS
  equivalent yet, unlike numbers/tees/baskets (all ported and fixed);
- `TODO(shared-endpoints)` in `semantic_exact_anchor.py`: tee/basket assignment is strictly
  one-to-one Hungarian matching — multi-tee or multi-basket holes (alternate pin positions) aren't
  modeled;
- wire proposals into Annotate Round's manual review layer;
- later add played-round dynamic extraction and played->clean registration.

Do not put CV confidence/provenance on final `AnnotatedRound`. CV results are proposals before Done; reviewed geometry is authoritative afterward.
