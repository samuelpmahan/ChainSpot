# S1 badge pixel coverage — dev-set investigation

Run: GitHub Actions `S1 badge dev-set investigation`, run 34076451503, commit `135b2503a293ad97b1801972f4532e0ffd815ea3`.

Scope: six `chainspot-corpus/dev` course inputs: AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake. Corpus checkout used Git LFS. The exact S1 `exp/badge-assembly` PCR was built and run on this investigation branch.

This remains a detector-derived footprint completeness measurement, **not annotation recall**.

## Course results

| Course | candidates | owned px | footprint px | residual px | coverage | outer 1 px halo |
|---|---:|---:|---:|---:|---:|---:|
| AlexClark | 18 | 41,290 | 43,510 | 2,220 | 94.898% | 4,007 |
| DashsTrack | 18 | 37,295 | 39,529 | 2,234 | 94.348% | 3,548 |
| Heritage | 18 | 41,293 | 43,521 | 2,228 | 94.881% | 4,039 |
| Lenard | 18 | 39,667 | 41,847 | 2,180 | 94.791% | 3,800 |
| NorthPark | 18 | 38,979 | 41,157 | 2,178 | 94.708% | 3,737 |
| TowneLake | 18 | 37,378 | 39,552 | 2,174 | 94.503% | 3,548 |
| **Total** | **108** | **235,902** | **249,116** | **13,214** | **94.69564%** | **22,679** |

The per-course spread is only 0.55 percentage points. The enclosed residual count is similarly stable: 2,174–2,234 pixels per course.

## Enclosed residual classification

Across all 13,214 enclosed residual pixels:

- `neutral-transition`: **13,154 (99.546%)**
- `chromatic-transition`: **60 (0.454%)**
- black-core: **0**
- white-core: **0**

Using 1-pixel adjacency to the already-owned semantic Parts:

- plate ↔ digit: **7,674 (58.075%)**
- plate ↔ border: **4,688 (35.478%)**
- single digit adjacency: **800 (6.054%)**
- single plate adjacency: **6 (0.045%)**
- single border adjacency: **30 (0.227%)**
- adjacent to none of those Parts: **16 (0.121%)**

Therefore **93.55%** of all enclosed residual pixels lie directly between two semantic Parts, and **99.88%** touch at least one semantic Part within one pixel.

This strongly supports the original DashsTrack interpretation: the missing enclosed material is overwhelmingly threshold-transition material created by the gap between black `V<=45` and white `V>=210 && OpenCV S<=45`, rather than missing badge geometry.

## Course consistency

The pattern repeats almost mechanically across the corpus.

- Lenard, NorthPark and TowneLake have **zero chromatic enclosed residual pixels**.
- AlexClark has 25 chromatic residual pixels.
- DashsTrack has 35.
- Heritage has zero chromatic residual pixels despite containing the only material adjacency outlier below.

The plate↔digit count is 1,275 on four courses, 1,284 on AlexClark, and 1,290 on DashsTrack. Plate↔border is 768–802. This is much too regular to look like arbitrary detector leakage.

## Outlier: Heritage candidate

One Heritage candidate is qualitatively different:

`badge-candidate:black-component-4546:white-component-1284`

- coverage: **90.78498%**
- residual: **216 px**
- plate↔border: 58
- plate↔digit: 112
- single:border: 30
- no adjacent semantic Part: 16

This is the **only** candidate in all 108 with `none` adjacency pixels, and the only source of `single:border` residual pixels. It should be inspected visually before treating `footprint - semanticCore` as universally safe BadgePx.

Apart from this candidate, the lowest coverage is AlexClark at 92.05209%; the remaining low-cover candidates still retain the normal transition adjacency structure.

## Outer halo is a different problem

The 1-pixel exterior neighborhood around the detected border contains 22,679 pixels:

- neutral-transition: **19,325 (85.211%)**
- chromatic-transition: **2,342 (10.327%)**
- black-core: **1,012 (4.462%)**

This is substantially less pure than the enclosed residual (99.546% neutral transition). The exterior ring therefore should **not** be promoted using the same rule as enclosed transition material.

The prior split remains useful:

- **inside the detected border footprint:** overwhelmingly safe badge-associated transition material;
- **outside the detected border:** badge-related halo mixed with map/background structure, requiring a separate `{BadgeFootprintDefinition}` decision and likely `MutedPx` treatment rather than automatic BadgePx ownership.

## Proposed bounded refinement

Do not dilate plate, border, digit or loop Parts independently. That would manufacture overlapping ownership at exactly the boundaries we are trying to preserve.

The corpus evidence instead supports a candidate-level derived Part:

`interiorTransitionPx = footprintPx - semanticCorePx`

with these constraints:

1. remains inside the enclosing detected border footprint;
2. preserves existing plate/border/digit/loop pixel membership unchanged;
3. does not assign the transition pixels to one of the semantic sub-Parts;
4. leaves the outer halo unowned or MutedPx pending `{BadgeFootprintDefinition}`;
5. retains an inspection escape hatch for anomalous candidates such as Heritage's 90.78% candidate.

No refinement was promoted by this investigation.

## Recommendation

The dev set strongly confirms that **enclosed transition ownership is a bounded representation problem, not a badge detector recovery problem**. It should not block digit recognition.

Continue S1 digit recognition and final contract work. When ownership completeness matters downstream, implement `interiorTransitionPx` as a separate candidate-owned Part and use the Heritage outlier as the first adversarial review case.
