# Blind consensus validation — frozen result

Freeze commit: `4a877fcbe5811418a3dd47e5cebff1302119dc8b`
Freeze SHA-256: `e493a06c17d334ba43d27558a50f89962e1818a0868d34d86a7d2210dc89b335`

## Dev-only OOF calibration

Candidate inventory contained the true tee+basket for 69/72 dev holes; the three unavailable holes were counted as failures in full-system calibration.

- uPair learned U-shaped pair ranker: 68/72 full-system OOF
- physics / 3Factor-ish hand scorer: 61/72
- geometry-heavy renderer-invariant scorer: 56/72
- all three chose the same pair: 55/55 correct
- physics + uPair agreed while geometry differed: 5/5 correct
- geometry + physics agreed while uPair differed: 1/6 correct — frozen `DO_NOT_TRUST`

Predeclared real-candidate ribbon-only falsifier:

- aligned-worst ownership: 15/69 available
- q25/tail ownership: 9/69
- mean ownership: 2/69

Those ribbon-only families were rejected before validation and cast no votes.

## Blind validation confidence

No validation truth was available or used. These are confidence buckets calibrated solely from dev OOF agreement patterns, not accuracy claims.

| Course | holes | Tier A: all 3 | Tier B: physics+uPair | LOW | DO_NOT_TRUST |
|---|---:|---:|---:|---:|---:|
| BeaverRanch-Gold | 21 | 9 | 4 | 3 | 5 |
| ColetoCreek | 18 | 16 | 2 | 0 | 0 |
| FountainHills | 20 | 15 | 2 | 2 | 1 |
| Seatac | 27 | 16 | 5 | 5 | 1 |
| **Total** | **86** | **56** | **13** | **10** | **7** |

Frozen `HIGH` policy = Tier A + Tier B = 69/86 (80.2%). The more conservative headline is Tier A alone: 56/86 (65.1%) with a 55/55 dev OOF precedent. Tier B has only a 5/5 dev sample and should be interpreted with that small-n caveat.

Endpoint-level frozen policy resolves 77/86 tees as high-confidence and 59/86 baskets as high-confidence even when the complete hole pair is unresolved.

## Course artifacts

- BeaverRanch-Gold image SHA-256 `77fa0fe7f9a1b313e6c61efd827590855bbfbd2d070e08cffd8fdc266ad4391a`
- ColetoCreek image SHA-256 `a66ab3e3eecd2b31a52e16dfbc4f7f1f73214adc61144ab8a727fde8945bfb01`
- FountainHills image SHA-256 `7409b6cebdd54a6dc5785aa3708257d1411d0d893033b56cff7071e2a1f9e4ee`
- Seatac image SHA-256 `ccac6ff53f9000237ffbc4e36ed8a3dfbcdaf83296bc6ecb0f39110c0f3195a1`

Exactly one final prediction image per validation course was retained. No intermediate/debug images remain.

## Post-freeze visual inspection

Visual inspection happened only after predictions were immutable. Qualitatively, the confidence split behaves sensibly: several red/orange cases visibly form implausible long cross-course ownership lines, while many green associations track the rendered hole geometry. This observation did not change any prediction or confidence class and is not a truth score.

## Runtime discipline

Each accepted matrix/inference run completed below 40 seconds. One early monolithic OOF roster batch hit the 40-second guard; its partial output was deleted and marked invalid. Subsequent families/runs were split. Between-run housekeeping recorded hashes, endpoint coverage, confidence-policy invariants, and removed temporary images.
