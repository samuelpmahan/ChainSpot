# NuThing P2 — Two-Pass Execution Protocol on the tee pool

CULLED RUN = per-candidate "evidence materialization" task (canonical mask, inner core, bbox/score/rank packaging) run over `pool.forwarded` (primary + candidates scoring >= the 0.40 theoretical floor). FULL REPLAY = the same task re-run from the same boundary over `pool.unculled` (the complete ranked population). Both are independently timed with `performance.now()`; FULL REPLAY genuinely re-executes the task rather than inspecting CULLED RUN leftovers, so it is the falsification check for the 0.40 floor. All 15 corpus images are included in timing. Truth coverage is computed for DashsTrack-full only — see "Truth coverage" below for why the other 4 annotated dev images are excluded.

## Per-image timing

| Image | P1 seconds | CULLED RUN candidates | CULLED RUN seconds | FULL REPLAY candidates | FULL REPLAY seconds |
|---|---:|---:|---:|---:|---:|
| AlexClark-full | 1.415 | 64 | 0.014 | 249 | 0.040 |
| DashsTrack-full | 0.388 | 26 | 0.010 | 105 | 0.019 |
| FountainHills-1 | 4.415 | 203 | 0.041 | 805 | 0.139 |
| FountainHills-2 | 3.110 | 91 | 0.014 | 467 | 0.079 |
| FountainHills-full | 2.483 | 125 | 0.024 | 504 | 0.090 |
| FountainHills-lazy | 5.662 | 221 | 0.035 | 979 | 0.170 |
| HeritagePark-full | 4.296 | 399 | 0.062 | 1111 | 0.176 |
| Lenard-1 | 1.957 | 68 | 0.010 | 311 | 0.051 |
| Lenard-2 | 2.032 | 60 | 0.009 | 340 | 0.054 |
| Lenard-3 | 4.212 | 194 | 0.030 | 927 | 0.156 |
| Lenard-4 | 2.392 | 68 | 0.014 | 365 | 0.059 |
| Lenard-5 | 3.231 | 112 | 0.017 | 573 | 0.100 |
| Lenard-full | 3.963 | 226 | 0.034 | 840 | 0.139 |
| NorthPark-full | 2.775 | 86 | 0.013 | 445 | 0.076 |
| TowneLake-full | 1.878 | 54 | 0.012 | 302 | 0.051 |
| **Total (15 images)** | 44.210 | 1997 | 0.340 | 8323 | 1.398 |

Note: 13 image(s) — AlexClark-full (modal major 2.0px), FountainHills-1 (modal major 2.0px), FountainHills-2 (modal major 2.0px), FountainHills-lazy (modal major 2.0px), HeritagePark-full (modal major 2.0px), Lenard-1 (modal major 2.0px), Lenard-2 (modal major 2.0px), Lenard-3 (modal major 2.0px), Lenard-4 (modal major 2.0px), Lenard-5 (modal major 2.0px), Lenard-full (modal major 2.0px), NorthPark-full (modal major 2.0px), TowneLake-full (modal major 2.0px) — have the anchored-family search locking onto a degenerate noise-sized "modal tee family" instead of a real tee-icon-sized one (a pre-existing property of the P1 port, also present in the Python baseline). Real tee-sized candidates then scale off the 96x96 canonical square and score null, so `teeRanked` (and therefore both pool sizes above) is far sparser for these images than for a normally-seeded image like DashsTrack-full.

## Truth coverage (DashsTrack-full only)

Of the 5 annotated dev images, only DashsTrack-full has an annotation JSON whose `sourceImage.sha256` matches the corpus raster exactly — a verified-correct coordinate frame. Truth coverage below is computed for DashsTrack-full alone; matching the other 4 annotated images' tee coordinates against P1 candidates would be meaningless since their coordinate frames are not confirmed to be the corpus raster frame (see "Excluded from truth coverage" below for the per-image reason).

### DashsTrack-full

Total annotated tees: 18. Found in PRIMARY: 18. Found only in SECONDARY (score >= 0.40): 0. Found only among CULLED (score < 0.40): 0. Unmatched (no candidate at all): 0.

### Aggregate truth coverage

| Total annotated tees | Found in PRIMARY | Found only in SECONDARY | Found only among CULLED | Unmatched |
|---:|---:|---:|---:|---:|
| 18 | 18 | 0 | 0 | 0 |

## Excluded from truth coverage

The following annotated dev images are excluded from truth coverage because their annotation coordinate frame is not verified to match the corpus raster:

- **AlexClark-full**: older annotation schema with no sourceImage.sha256 to verify against; coordinate frame empirically wrong on visual audit.
- **HeritagePark-full**: annotation sourceImage is 1290x2115 but the corpus raster is 1290x2796 (different capture); similarity registration found only 5/18 tee inliers, so no reliable transform exists.
- **Lenard-full**: annotation sourceImage is 1290x2089 but the corpus raster is 1290x2796 (different capture); similarity registration found only 5/18 tee inliers, so no reliable transform exists.
- **TowneLake-full**: annotation sourceImage is 1290x2012 but the corpus raster is 1290x2796 (different capture); similarity registration found only 5/18 tee inliers, so no reliable transform exists.

## Conclusions

The 0.40 theoretical floor withholds 6326 of 8323 ranked candidates (76.0%) from the evidence-materialization task across the 15-image corpus, saving 1.058s of the 1.398s FULL REPLAY would cost (CULLED RUN: 0.340s).

FULL REPLAY did not surface any truth tee candidate that the 0.40 floor would have withheld: every matched annotated tee that had any matching candidate at all was found at or above the floor (PRIMARY or SECONDARY). No floor-falsification cases in this corpus.

Every annotated tee had at least one candidate (of any partition) matching its bbox.

## AlexClark re-examination (floor falsification found)

The original exclusion of AlexClark-full from truth coverage conflated two
different claims. Its annotation has no sha256, but its dimensions match the
corpus raster exactly (1290x2086) and its coordinates land on P1 candidates
within 8-12 px — the coordinate frame is evidently the corpus raster; what
was actually wrong earlier was the badge-at-path-midpoint hypothesis, not
the frame. Checking its 3 annotated holes against the full unculled pool:

- Hole 2 tee: a candidate's bbox contains the annotated tee point (d=12.1px)
  at rank 242/249 with score 0.000 — CULLED by the 0.40 floor. **Only FULL
  REPLAY retains it.** This is a concrete floor-falsification case.
- Holes 1 and 3 tees: no candidate bbox contains the tee at all (nearest
  centroids 112px / 75px). These tees are not in the pool at any score —
  they were lost upstream at the mask/component stage, beyond what the
  unculled lever can recover.

Root cause: AlexClark is one of the 13/15 images whose modal tee family
degenerates to ~2px specks (see note above). With canon scale 60/2 = 30x,
real tee-sized components project off the canonical square and score ~0,
inverting the ranking (specks score up to 0.93; true tees 0.000).

Corrected conclusion: the 0.40 floor is safe where modal-family discovery is
healthy (DashsTrack: 18/18 PRIMARY, replay finds nothing extra), and unsafe
exactly where it degenerates — there, true tees survive only in `unculled`,
which is the diagnostic lever's purpose. n=3 annotated holes on AlexClark;
treat as an existence proof, not a rate.
