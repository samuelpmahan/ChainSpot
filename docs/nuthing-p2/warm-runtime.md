# Warm full-course badge recognition runtime

Model: `logistic(resources/nuthing-p2/digits/models/logistic.json)`. Warm timing = median of 5 repeats after one warmup pass; "badge reading" covers glyph extraction, segmentation, normalization and classification for every badge of the course — the stage the 100 ms loose ceiling applies to. P1 localization is timed separately (single warm run). End-to-end readings are cross-checked against manifest truth (training labels on dev, evaluation-only labels on Fountain Hills; the non-digit arrow badge is excluded).

| image | badges | P1 s | badge reading ms (median) | reads correct | mismatches |
|---|---|---|---|---|---|
| AlexClark-full | 16 | 1.47 | 3.86 | 16/16 | 0 |
| DashsTrack-full | 18 | 0.36 | 3.69 | 18/18 | 0 |
| FountainHills-1 | 10 | 4.40 | 1.50 | 9/9 | 0 |
| FountainHills-2 | 13 | 3.02 | 2.74 | 13/13 | 0 |
| FountainHills-full | 20 | 2.57 | 3.85 | 20/20 | 0 |
| FountainHills-lazy | 16 | 5.53 | 2.93 | 16/16 | 0 |
| HeritagePark-full | 14 | 4.64 | 2.64 | 14/14 | 0 |
| Lenard-1 | 7 | 2.06 | 1.36 | 7/7 | 0 |
| Lenard-2 | 7 | 2.17 | 1.61 | 7/7 | 0 |
| Lenard-3 | 4 | 4.31 | 0.69 | 4/4 | 0 |
| Lenard-4 | 6 | 2.44 | 1.25 | 6/6 | 0 |
| Lenard-5 | 7 | 2.99 | 1.31 | 7/7 | 0 |
| Lenard-full | 16 | 3.91 | 2.94 | 16/16 | 0 |
| NorthPark-full | 16 | 2.77 | 2.96 | 16/16 | 0 |
| TowneLake-full | 18 | 1.90 | 3.18 | 18/18 | 0 |

**End-to-end reads correct: 187/187.**