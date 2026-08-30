---
name: chainspot-cv-engrams
description: ChainSpot CV memory — what the map renderer actually draws (chrome component signatures, C1S/C2D rings, z-order variance), the tee completeness invariant, and hard-won diagnostic facts about the detector. Load before diagnosing any missed/misplaced detection, before touching G3/G4 code, and before trusting any number computed from a bright-mask component.
---

# ChainSpot CV engrams (vision)

## What the renderer draws (identify BEFORE measuring)

Bright-mask component signatures, stable across Dev6 (sizes at current
corpus zoom — signatures are shape+context, sizes shift with zoom):

- **Badge plate**: ~450px, ~55×42 rounded-rect outline, centroid = badge
  center. The digit glyphs inside are SEPARATE components: digit "1" ~78px
  7×21 (PCA ~85°), other digits ~155-170px 14-16×21. Recovery owns every
  bright pixel inside badge bboxes (commit dc96000) precisely because
  un-owned digits masqueraded as tee shards.
- **Basket glyph**: ~1746px, 42×66, PCA 90°. A tee pad touching it can
  MERGE into its component; the pad remnant appears only after basket
  sprite-cell subtraction.
- **C1S / C2D rings**: solid 10m / dashed 20m range circles around every
  basket. Dash segments are small components lying on a common circle;
  pixel radius is ZOOM-DEPENDENT — measure per course by circle-fit, never
  assume. Fitted radii + known real radii ⇒ meters-per-pixel (the
  course-derived ruler). **Z-order varies by course**: NorthPark renders
  the tee pad ON TOP of C2D; DashsTrack renders it UNDER. Therefore chrome
  removal is PIXEL subtraction with remnants kept — never whole-component
  drops.
- **Screen chrome clusters**: phone-UI leftovers; screenChrome.ts
  classifies (tuned bottom-edge/AlexClark — known limitation).

A number computed on chrome is not evidence about terrain. The retraction
that taught this: "H14's pad is 19.8° off its badge ray" — measured on
badge 15's "5" glyph (docs/CLAIMS-LEDGER.md rows 1-2).

## Identity precedes geometry (owner correction, 2026-08-29)

Object identity is a hard prerequisite to object-specific measurement.

A bright component is `UNKNOWN` until the canonical raster/context establishes
what rendered/physical object owns those pixels. Do not infer identity from a
useful angle, fit, location, assignment improvement, or the fact that no better
candidate exists.

Known high-cost failure: badge digit glyphs have repeatedly been promoted to
"tee shards" because their downstream geometry looked plausible. Therefore:

- badge chrome is the default competing hypothesis for components inside/at a
  badge until visually disproven;
- `UNKNOWN` is a successful diagnostic classification;
- tee-specific PCA/ray/support/fit reasoning starts only after tee/remnant
  identity has been established;
- tiny isolated brightness is not evidence of a tee by itself.

The correct workflow is:

`pixels -> identity -> measurement -> gate interpretation`

never:

`pixels -> useful measurement -> desired identity`.

## The completeness invariant (owner, 2026-08-28)

Every tee is exactly one of:
(a) **non-occluded** → G3 visible detection must find it; a miss is a G3
    defect (e.g. C2D dashes merged with the pad outline break the
    enclosed-ring test);
(b) **occluded by a known occluder** (badge, basket, C1S/C2D per z-order,
    screen chrome) → G4 must recover it from the visible remnant.
No third state. Classify every miss — G3-defect / recovered /
recovery-rejected(reason) / invisible — with pixel receipts.

## Detector facts that keep being re-learned

- G3 tee detection is enclosed-hole RING detection: a pad whose outline is
  broken (chrome overlap, occlusion) produces no ring and never reaches
  teeFamily. teeFamily then majority-votes by size family — correct tees at
  a non-dominant scale get excluded (minesweeper HIGH item).
- G4 recovery acceptance: badge-ray-constrained hollow-support fit; every
  visible pixel must fit the support band (±1.25px raster allowance),
  support ≥ 8px, axis within the configured gate (soft ceiling; target
  P100 5° then 3°). Pad dimensions come from the course's own measured
  pads (medians), thickness from intact-pad area A = 2t(W+H) − 4t².
- Discovery history: originally bounded to ~83px around the PREDECESSOR
  basket tip ("tee touches previous basket" worldview) — the founding
  footgun. Replaced by predicate-as-filter over all unowned bright
  components (owner design; no spatial prefilter).
- `ComponentStats` carries label/cx/cy/area/bbox/major/minor/angle; look
  up by `.label` — the array is NOT indexed label−1.
- Hole labels are currently hard-capped 1-18 in measure.ts (minesweeper
  HIGH item) — a >18-hole course is structurally unassignable today.
- Fragment PCA ≠ constrained fit: a partial shard's PCA can sit 40°+ off
  while the all-pixels support fit still passes at a ray-aligned angle.
  Judge by the fit, not the fragment's PCA.
