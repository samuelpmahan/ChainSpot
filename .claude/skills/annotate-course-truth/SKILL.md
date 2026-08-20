---
name: annotate-course-truth
description: Build a course truth annotation (<Course>-full.annotation.json) for a UDisc capture through a human-in-the-loop render-correct-rerender loop, using scripts/nuthing/manual_annotate.py. Use whenever a course has no annotation file (or a partial one), whenever the user says "annotate this course", "make truth for", "hand-annotate", or before a truthless course can be scored. The human is the oracle; the model drives the script and the renders.
---

# Annotate course truth

Truth files unlock exact scoring (`pair-matrix` truth matching, 18px tee /
16px basket tolerance) — without one, a course can only be judged by eye
forever. This skill turns eye-judgment into a truth file once, through a
converging correction loop. The tool is
`scripts/nuthing/manual_annotate.py`; the schema is DashsTrack's
(`course`, `imageWidthPx/imageHeightPx`,
`holes[{number, tee{xPx,yPx}, basket{xPx,yPx}, corridorBends[...]}]`).

**Coordinate law (CX-038): everything in the annotation is FULL-CAPTURE
pixels.** Pipeline caches are viewport-cropped; the emitted
`*-assignments.json` files already add `viewport.top` back, but they are in
the GEOMETRY frame — a dual-scale capture (CX-058) needs
`--geo-scale` on seed so coordinates land in the capture's native frame
(e.g. 0.5-scale geometry → `--geo-scale 0.5` divides them back up).
`render` hard-fails if the image dimensions don't match the annotation,
which catches most frame mistakes at the door.

## The loop

1. **Init** from the capture image:
   `python3 scripts/nuthing/manual_annotate.py init <out.json> --image <capture> --course <Name>`
2. **Seed from the pipeline, never from scratch.** Run the pairing pipeline
   on the course first (truthless is fine: `pair-matrix.ts --demo-course`)
   and seed: `... seed <out.json> --assignments <Course>-assignments.json
   [--geo-scale S]`. Correcting a mostly-right overlay converges in 2–3
   rounds; placing ~20 holes by hand from nothing does not. Seed never
   clobbers a piece a human already set, so re-seeding after a pipeline
   improvement is safe.
3. **Render**: `... render <out.json> --image <capture> --out-dir <dir>`
   → `overlay.png` / `overlay-small.png` (whole course) and `h<N>.png`
   zoom crops. Crops carry a 50px grid whose labels are ABSOLUTE capture
   pixels — the human reads corrections straight off the image.
4. **Show the human** the overlay plus any suspect crops, and ask for
   verdicts per hole. Accept corrections in whatever form they arrive —
   "h4 tee +12 -3" (`nudge 4 tee 12 -3`), "tee 4 is at 1948,1451"
   (`set 4 tee 1948 1451`), "h7 bends at the path junction ~(830,1240)"
   (`bend 7 add 830 1240`). Do not proceed past a hole the human hasn't
   judged; do not guess a bend the human didn't call.
5. **Re-render and repeat** until the human signs off. Then
   `... validate <out.json>` (all pieces present, in bounds, no duplicate
   holes) and commit the file NEXT TO the capture image in the corpus repo
   (`dev/<Course>/<Course>-full.annotation.json` in
   samuelpmahan/chainspot-corpus), not in ChainSpot.

## Rules

- Every round ships images. A correction request without a fresh render is
  asking the human to annotate blind.
- Marker colors are the pipeline's own convention (tee yellow, basket
  blue-ish, bends magenta, route green) so overlays read the same across
  every tool in this repo.
- Bends are the human's call, not the seeder's: assignments carry no bend
  data, and pipeline-routed paths can cut corners — never derive
  `corridorBends` from a routed leg (that is the weakness truth exists to
  measure).
- A finished truth file's first use should be a scoring run against the
  pipeline that seeded it; disagreements are findings about one of the two,
  and the render loop settles which.
