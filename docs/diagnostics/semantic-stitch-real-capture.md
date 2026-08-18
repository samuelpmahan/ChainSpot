# Semantic stitch real-capture acceptance

Date: 2026-08-18

Base reviewed: `prestaging/demo` @ `f6698ecfb8ffd4f1d321ca9042f7eae8754ad146`

Fixture: committed `resources/real-capture/{TL,TR,BL,BR}.PNG`, cropped with `REAL_CAPTURE_CROP` and judged against the independent transform truth in `tests/helpers/realCapture.js`.

## What the audit found

The semantic stitch architecture was already wired into the production stitch path, but CHSPT-75 had a real source-localization defect that CHSPT-76's transform result hid.

The basket family was good enough to solve every neighboring real-capture translation. The original badge localizer, however, clustered only near-black badge-body components. On the real captures the numbered badge body is interrupted by the white glyph and sometimes by map graphics; meanwhile a few unrelated small dark components formed a tighter repeated cluster. The diagnostic overlays therefore showed the three accepted `badge` observations on tiny false positives while the real numbered badge bodies were missed.

The correction is deliberately small and remains pure TypeScript: prefer the stable white rounded badge outline when it repeats across sources and contains enough dark interior, then retain the original dark-body detector as the fallback for render variants without a separable white frame. Basket localization and the semantic voting algorithm are unchanged.

## Source landmark evidence after the correction

The real four-capture batch produced these family scales:

| family | median bounds | support | source support |
|---|---:|---:|---:|
| badge | 54 × 42 px | 25 | 4/4 |
| basket | 42 × 66 px | 24 | 4/4 |

Per-source observations:

| source | badges | baskets |
|---|---:|---:|
| upper-left | 7 | 6 |
| upper-right | 3 | 5 |
| lower-left | 9 | 8 |
| lower-right | 6 | 5 |

The 25 badge observations are not 25 unique holes; overlapping captures repeat the same physical badges. Visual review of the generated source overlays confirmed the badge rectangles land on the actual numbered frames, including the two-digit 10–18 badges, and the basket rectangles land on the white basket sprites.

Using the independent transform truth to ask whether a landmark visible in both captures repeats at the same physical position, the four neighboring edges have one unmatched overlap-visible observation in total. The repository does not contain independent per-sprite badge/basket truth, so that count is an overlap-consistency inventory, not a defensible precision/recall label.

## CHSPT-76: semantic voting vs generic OpenCV

Representative CI run `32179626263` after the badge correction:

| edge | truth | semantic | semantic inliers | families | max error | semantic vote | generic OpenCV |
|---|---|---|---:|---|---:|---:|---:|
| UL → UR | (822, -90) | (822, -90) | 2 | basket | 0 px | 2.08 ms | 63.31 ms |
| LL → LR | (912, -86) | (912, -85.8) | 5 | badge+basket | 0.20 px | 3.78 ms | 33.02 ms |
| UL → LL | (-246, 1693) | (-246, 1693) | 5 | badge+basket | 0 px | 1.67 ms | 25.50 ms |
| UR → LR | (-156, 1697) | (-155.75, 1697) | 4 | badge+basket | 0.25 px | 0.32 ms | 20.21 ms |

Whole-batch pure-TS landmark localization was 269.64 ms on that GitHub runner. OpenCV warmup was 242.52 ms. These timings are evidence, not CI thresholds; runner speed is intentionally not treated as correctness.

The real fixture therefore demonstrates both useful operating regimes:

- two shared same-family landmarks are sufficient to recover an exact translation on UL → UR;
- four or five shared observations, especially across badge and basket families, produce much stronger ambiguity margins and redundancy on the other three edges.

Generic pixel matching is still required by the architecture when semantic evidence is absent, singular, ambiguous, geometrically inconsistent, or disagrees with local verification. The real fixture does not justify deleting that fallback.

## Acceptance gate

`tests/unit/semanticRealCaptureBenchmark.test.ts` now fails if this committed fixture regresses below the observed semantic floor:

- badge and basket family scales must each be supported by all four sources;
- badge scale must remain in the real 54 × 42 px neighborhood, preventing the former tiny-dark-component failure;
- the batch must retain at least 20 badge and 20 basket observations;
- overlap consistency may lose at most the one currently observed landmark;
- every neighboring edge must have at least two truth-consistent detections and at least two semantic inliers;
- every semantic translation must remain within 1 px of independent transform truth;
- the generic OpenCV baseline remains checked within the existing 4 px tolerance.

The PR-only workflow `.github/workflows/semantic-stitch-acceptance.yml` runs this benchmark together with the focused semantic/pose-graph tests, `npm run check`, and the production build, and uploads the source/translation overlays plus `summary.json`. It intentionally does not append the unrelated full Annotate Course/geocoding suite; that was the reason the earlier semantic validation wrapper appeared red even though its focused semantic tests passed.
