# OCR strike team — Opus lead progress

Started 2026-08-28. Base `ffcf9dc` (worktree spawned stale; reset to FETCH_HEAD).

Mission: root-cause G1 badge digit garbage, diff current
`packages/alg/src/detectors/threeFactor/digits/` against
`old-stuff/.../badgeGlyphClassifier.ts`, publish a FIX CONTRACT + RECEIPT
FORMAT for the two Sonnet builders. Detector source NOT modified by this lane.

## Status: COMPLETE

- [x] Worktree stale; `git reset --hard FETCH_HEAD` -> `ffcf9dc`; `packages/alg` present
- [x] `npm install`, `npm run build --workspace @chainspot/alg`, `./lab setup` (exit 0)
- [x] Fresh G1 sweeps: AlexClark, NorthPark, HeritagePark
- [x] Read current pipeline (segment / readBadges / normalize / logisticInference / badgeGlyph / measure)
- [x] Read old pipeline (badgeGlyphClassifier, sourceBadgeIdentity, its unit test)
- [x] Per-failing-badge forensics with intermediate values + 6x visual crops
- [x] Counterfactual proving the root cause by repair
- [x] Fix contract C1-C6 + receipt format
- [x] Ledger rows 16-20

## Root cause (one line)

`extractBadgeGlyph`'s frame-exclusion test `brightLabels[i] !== badge.label`
(`digits/badgeGlyph.ts:55`) is a silent NO-OP for `dark-plate-recovery`
badges, which carry the sentinel `label: -1` (`badgeStage.ts:157`). No pixel
in `brightLabels` is ever -1, so the badge's own bright plate OUTLINE is fed
to `segmentDigits` as a glyph. All 7 failures are `dark-plate-recovery`;
zero `bright-family` badges affected.

Two downstream amplifiers make it silent rather than loud:

- **Cap bypass** — `labelCandidates` enforces 1-18 only when digit count is
  already 1 or 2; at 3+ it returns empty and `measure.ts:250`'s
  `|| entry.reading.label` emits the raw concatenation ("1868", "295", "787").
- **Signal/noise inversion** — when the outline is ~2x the digits' height,
  `segment.ts`' relative height filter drops the REAL digits as noise, leaves
  exactly 2 outline fragments, and the 1-18 filter then launders pure noise
  into a plausible in-vocab label (HeritagePark's duplicate "12"/"17", "03"->13).

## Proof by repair (counterfactual, nothing else changed)

| course | badge | before | after |
|---|---|---|---|
| AlexClark | badge-10 | `"1868"`@0.0278 | **18**@0.9811 |
| AlexClark | badge-16 | `"295"`@0.0029 | **5**@0.9892 |
| NorthPark | badge-2 | `"787"`@0.0015 | **7**@0.9936 |
| HeritagePark | badge-7 | `"12"`@0.0262 | **12**@0.9926 |
| HeritagePark | badge-9 | `"12"`@0.0250 | **13**@0.9891 |
| HeritagePark | badge-12 | `"17"`@0.0044 | **15**@0.9899 |
| HeritagePark | badge-14 | `"13"`@0.0756 | **2**@0.9926 |

Recovered labels are exactly each course's absent set (AlexClark {5,18},
NorthPark {7}, HeritagePark {2,12,13,15}). 47/47 healthy reads unchanged.

## Deliverables

- `docs/seven-whys/g1-badge-digit-garbage.md` — forensics, WTF-HAPPENED
  old-vs-new diff with file:line both sides, FIX CONTRACT C1-C6, RECEIPT FORMAT
- `docs/CLAIMS-LEDGER.md` rows 16-20
- `artifacts/ocr-forensics/<Course>/badge-<n>.crop6x.png` — visual receipts
- `scripts/ocr-forensics.mjs`, `ocr-intruder-probe.mjs`, `ocr-counterfactual.mjs`
  — read-only probes over `dist/`

## For the builders

- **Eval-harness Sonnet**: the receipt format section is the target output;
  the counterfactual script is the A/B pattern; the 0.0015-0.0756 vs
  0.978-0.994 margin separation is the metric that matters. Note contract C4:
  any floor must be DERIVED with printed provenance, not a literal.
- **Old-classifier Sonnet**: the three lost properties are enumerated with
  file:line in the WTF-HAPPENED section — abstention (`:363-364`),
  `bestLabel` (`:369`), `badgeGlyphBatchIsComplete` (`:420-426`). The old
  thresholds (`minScore 0.58`, `minMargin 0.045`) would have caught all 7.
- C1 alone repairs all 7 observed failures. C2-C6 are what make the NEXT
  segmentation failure loud instead of silent. Both halves are in scope.
