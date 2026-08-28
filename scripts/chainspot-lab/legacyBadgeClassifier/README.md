# Legacy badge classifier resurrection (OCR strike team, Sonnet B)

Standalone, offline harness that resurrects the PRE-REBUILD pure-TS badge
glyph classifier (`old-stuff/src/lib/autoAnnotation/badgeGlyphClassifier.ts`)
and runs it head-to-head against the CURRENT reader
(`packages/alg/src/detectors/threeFactor/digits/{segment,readBadges,logisticInference}.ts`)
on the same canonical rasters, using CURRENT's own `detectBadges` bbox/center
geometry for both. **Not wired into the engine or any ABFeature** — this is
comparison tooling only.

## Files

- `oldClassifier.ts` — verbatim port of `classifyKnownBadgeBodiesPureTs` +
  `normalizeBadgeGlyphMask` + Dice scoring. Only the template-loading I/O was
  changed (fetch/canvas -> pngjs/fs); every threshold, margin, and formula is
  copied unchanged. Shims are documented in the file header.
- `selfTest.mjs` — mirrors old-stuff's own unit-test contract
  (`badgeGlyphClassifier.test.ts`): every one of the 18 canonical
  `hole-NN.png` templates must classify as itself. Run:
  `node --import tsx legacyBadgeClassifier/selfTest.mjs` from
  `scripts/chainspot-lab/`. Result: 18/18.
- `headToHead.ts` — runs OLD vs CURRENT over one or more Dev6 courses' full
  canonical sweep renders, writes
  `artifacts/orchestration/legacy-badge-classifier/head-to-head.json`.
  Usage: `node --import tsx legacyBadgeClassifier/headToHead.ts [course...]`
  (no args = full Dev6: DashsTrack, Lenard, TowneLake, NorthPark,
  HeritagePark, AlexClark).
- `contactSheet.ts` — extracts padded/upscaled crops of the mission's named
  disputed badges and tiles them via `scope/render.ts`'s
  `makeLabeledContactSheet` (reused, not reimplemented). Writes
  `artifacts/orchestration/legacy-badge-classifier/disputed-badges-contact-sheet.png`.

## Headline result (2026-08-28 Dev6 full sweep, 108 badges)

OLD's best-guess label (its top candidate even on an abstained/ambiguous
read) forms an **exact bijection onto 1..18 on every one of the 6 Dev6
courses** — including the 3 courses where CURRENT produces duplicate labels
or literal garbage strings. Every disputed badge was confirmed against the
actual crop pixels (see the contact sheet): OLD's answer was correct in
100% of examined cases, CURRENT's was wrong in every case OLD disagreed with
by more than an abstention.

See `docs/CLAIMS-LEDGER.md` for the receipted claim and
`artifacts/orchestration/ocr-legacy-progress.md` for the full narrative.
