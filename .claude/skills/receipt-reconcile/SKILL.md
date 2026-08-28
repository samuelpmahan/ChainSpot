---
name: receipt-reconcile
description: Visually reconcile a ChainSpot receipt against its rendering and the raw evidence — verify that what a run.receipt.txt / run.visual.receipt.txt CLAIMS matches the pixels, components, and trace it points at. Use whenever a receipt line is challenged ("SHOW ME THE RECEIPT"), when diagnosing a missed/misplaced detection, before entering or resolving a row in docs/CLAIMS-LEDGER.md, or when a claim about angles/distances/support sounds plausible but hasn't touched pixels yet.
---

# Receipt reconciliation

The failure mode this skill exists to prevent, observed 2026-08-28: a claim
("H14's pad is 19.8° off its badge ray") was computed correctly on the wrong
pixels — the "shard" was a neighboring badge's digit glyph. The receipt's
numbers were internally consistent and completely wrong about the world.
Reconciliation means walking a claim back to pixels a human can look at.

## The procedure

1. **Quote the claim verbatim** — the exact receipt line(s), with path. A
   paraphrase is already an interpretation.

2. **Locate the evidence the claim rests on.** Every receipt line has a
   provenance note; follow it: trace unit drawables, board slot, artifact
   `.bin` + sidecar, rejection pixel coordinates. If the line has no
   provenance, that is itself the finding (receipt contract violation).

3. **Rebuild the evidence independently from the canonical raster** —
   never from the receipt's own intermediate numbers:
   - Canonical PNG: `<run>/renders/input/g0.canonical.png`.
   - Bright mask + components, via the real detector code (never a
     re-implementation):
     ```js
     import { computeBrightDarkMasks } from '<repo>/packages/alg/dist/detectors/threeFactor/raster.js';
     import { extractComponents } from '<repo>/packages/alg/dist/detectors/threeFactor/components.js';
     ```
     `ComponentStats` already carries `label, cx, cy, area, bbox*, major,
     minor, angle` — look components up by `.label` (the array is NOT
     indexed label-1).

4. **Identify what each component actually IS before trusting any number
   computed from it.** The chrome signatures (learn these cold):
   - badge plate: ~450px, ~55×42 outline, centroid = badge center
   - digit "1": ~78px, 7×21, PCA ~85° (vertical)
   - other digits: ~155-170px, 14-16×21
   - basket glyph: ~1746px, 42×66, PCA 90°
   - C1S/C2D dashes: small segments lying on a circle around a basket tip
     (solid 10m / dashed 20m rings; pixel radius is zoom-dependent —
     measure, never assume; z-order vs the pad varies by course)
   A number computed on chrome is not evidence about terrain.

5. **Render the reconciliation image** — a crop around the disputed area
   with bright-mask pixels tinted (green), 3x zoom, using pngjs. The human
   accepts or rejects by LOOKING. Pair it with a component table:
   `comp#label | area | bbox | centroid | dist-to-anchor | pca | ray |
   axis-vs-ray`.

6. **Check pixel-exact claims mechanically** where the receipt makes them
   (e.g. `badgeBrightPixels: 8291` must equal the count of pure-yellow
   pixels in `run.visual.png`) — count in the PNG, don't trust the text.

7. **Enter the outcome in `docs/CLAIMS-LEDGER.md`** in the same commit:
   claim | receipt | status (UPHELD / RETRACTED / PENDING) | fate. A
   retraction records what falsified it and what the truth turned out to
   be. Append-only; never edit dead rows.

## Interpretation guardrails

- "Never ran" ≠ "ran and found 0" ≠ "not scheduled" ≠ "not enabled" —
  receipts distinguish these; so must your reading.
- The owner's law: absolute course-distance/size assumptions are ALWAYS
  footguns (150ft-1700ft holes). If a claim depends on one, check
  `docs/minesweeper/` — it may already be indexed.
- The completeness invariant: every tee is either non-occluded (G3 must
  see it) or occluded by a known occluder (G4 must recover it). A missed
  hole gets classified — G3-defect / recovered / recovery-rejected(reason)
  / invisible — with pixel receipts, not vibes.
- Detector ordinals (`badge-7`) are not hole numbers; map through
  `BadgeEvidence.label` (digit read + confidence) and say UNREAD when the
  read is garbage, never guess.

## Useful one-liners

Truth-free per-hole viewport (works on every course):
`./lab scope hN` · all holes: `./lab scope holes` ·
batch to ONE image: `./lab scope batch Course:h5,h6 OtherCourse:h14`

Fresh receipts: `./lab sweep packages/alg/src/detectors/threeFactor/configs/default.json ../chainspot-corpus/dev/<Course>/<image>`
(rebuild first: `npm run build --workspace @chainspot/alg` — LAB runs dist).
