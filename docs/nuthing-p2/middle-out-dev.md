# Middle-out endpoint discovery — dev truth gate

Pipeline per image: badge stage (P1 semantics, tee scoring skipped) → logistic digit reading → paired-edge ribbon support field → per-badge geodesic endpoint discovery. A truth hole passes when its badge exists (digits == hole number) and BOTH tee and basket have an endpoint candidate within 10px. Endpoint pools follow the CandidatePool semantics (primaryCount=2, floor on mean ribbon support).

| image | badges | stage ms | read ms | field ms | endpoints ms | total s | holes w/ badge | tee+basket pass | tee-only | basket-only | neither |
|---|---|---|---|---|---|---|---|---|---|---|
| DashsTrack-full | 18 | 93 | 12 | 707 | 271 | 1.08 | 18 | 18 | 0 | 0 | 0 |
| HeritagePark-full | 14 | 100 | 3 | 803 | 238 | 1.14 | 14 | 14 | 0 | 0 | 0 |
| Lenard-full | 16 | 103 | 2 | 812 | 245 | 1.16 | 16 | 16 | 0 | 0 | 0 |
| TowneLake-full | 18 | 87 | 2 | 770 | 200 | 1.06 | 18 | 18 | 0 | 0 | 0 |
| AlexClark-full | 16 | 59 | 2 | 623 | 202 | 0.89 | 3 | 3 | 0 | 0 | 0 |

**Gate: PASS** (every badge-backed truth hole tee+basket matched, and total < 2 s/image).