# The Minesweeper Index

Owner directive 2026-08-28: *"This is a sport with 150 ft holes and 1700 ft
holes. Mins and maxes like that are ALWAYS footguns."* Every detector feature
was indexed and cross-referenced for anything with the odor of a foot or a
gun, after three confirmed exemplars surfaced the same day: the G4 recovery's
~83px predecessor-basket search box, badge digit glyphs escaping ownership
(chrome measured as tee evidence), and the hard 3° axis gate.

- [`index-a-g0-g3.md`](./index-a-g0-g3.md) — G0 intake, G1 badges/digits,
  G2 baskets, G3 tees, shared infra (35 files).
- [`index-b-g4-g7.md`](./index-b-g4-g7.md) — G4 recovery, G5 straight/ribbon/
  routing, G6 assignment, G7 zfit, exec plumbing (22 files, ~7.2k lines).

Classification rubric: **COURSE-ASSUMPTION FOOTGUN** (course-scale geometry as
a constant) · **STRUCTURAL WORLDVIEW** (baked layout/order assumptions) ·
**DATASET-FIT THRESHOLD** (corpus-tuned; legitimate only when knobbed with
provenance) · **RASTER-GEOMETRY** (cell/antialias allowances; legitimate).

## Combined severity picture

18 course-assumption footguns + 16 structural worldviews across the detector;
24 dataset-fit thresholds of which the bare/unknobbed ones are flagged in the
indexes; HIGH-severity items (silently lose or misplace course objects on a
legal course):

1. `measure.ts` hole labels hard-capped to 1–18 — a course longer than 18 (or
   any read outside the range) is structurally unassignable.
2. Fixed-pixel corridor geometry (`corridorWidthPx=37`, `widthsSrc=[24..64]`)
   — absolute pixels with no image-scale tie; the literal 150ft-vs-1700ft
   collision.
3. G4 predecessor-basket search box (under repair: predicate-as-filter
   rebuild in flight) and the predecessor-adjacency chain walk (hole 1 and
   non-adjacent numbering cascade-fail).
4. teeFamily single-largest-size-family clustering — correct tees at a
   non-dominant rendered scale are voted out.
5. Fixed 42×66 basket sprite constant — one bitmap scale for the game's only
   rigid object class.
6. Intake worldviews: chrome stripping silently skipped for non-portrait
   captures; AutoStitch assumes left-to-right order with a badge-bearing
   first tile. Both fire BEFORE any gate can compensate — direct risk to the
   TheRec L+R stitch challenge.

Fix policy: course-derived values with printed provenance replace absolute
literals; the acceptance predicate is the filter (no spatial prefilters);
raster-cell allowances survive but must be commented as raster geometry.
