# Smart two-pass basket matcher — checkpoint

Base: `cb160a5d5f3d68df272770044b30ff4f34e7225a` (`lab: make dark badge plates primary`).

## Goal

Replace the current broad global matched-filter behavior with renderer-aware basket identity and overlap recovery.

The detector should answer two separate questions:

1. **Is this visibly a basket sprite?**
2. **If the basket is partially hidden by another renderer object, can the visible remainder still prove its identity?**

Ownership by hole remains downstream.

## Beaver Ranch finding

The blind-consensus basket pool on Beaver Ranch originally contained 44 candidates. Visual audit showed:

- 21 real visible baskets
- ~20 vertically shifted echoes of those same baskets
- 3 low-score junk candidates

The old confidence picture therefore confused assignment ambiguity and duplicate candidate generation with basket visibility.

On the crop-local Beaver raster, 18 of 21 real baskets are an almost absurdly strong renderer family:

- white connected component bbox: `42 x 66`
- white component area: `1746 px` for all 18
- the binary component shape is byte-identical for all 18
- 2px shell around the white component is about `0.68` dark-mask support
- essentially all dark shell pixels belong to one connected dark component
- the total size of that dark component is irrelevant; several merge into very large terrain/furniture components

The remaining three baskets are badge-overlap cases. A local occlusion-aware family search seeded from the badge recovers all three with no extra candidates:

| recovery | identity | effective visible white |
| --- | ---: | ---: |
| Beaver overlap A | 0.956 | 60.9% |
| Beaver overlap B | 0.994 | 94.2% |
| Beaver overlap C | 0.963 | 77.0% |

All non-basket badge-neighborhood hypotheses on Beaver remained far below the recovery threshold.

## Dev72 audit

Using only the near-exact clean-family geometry and dark-shell condition for Pass 1:

- DashsTrack: `17/18`
- Heritage: `15/18`
- Lenard: `16/18`
- Towne Lake: `18/18`
- total: **66/72**

The six Pass-1 misses are exactly the renderer overlap cases: badge-over-basket and basket-over-basket stacks. They are not a separate terrain/brightness family.

A prototype Pass 2 seeded only from badge/basket overlap neighborhoods recovers all six:

- Pass 1: `66/72`
- Pass 2: `6/6`
- total Dev72 candidate recall: **72/72**
- extra candidates in the prototype: **0**

One Lenard overlap exposes only about **39%** effective basket-white evidence. It is recovered as `MEDIUM`, not promoted to high confidence.

## Proposed detector

### Pass 1 — clean/topmost renderer identity

Operate on connected bright and dark masks, not a whole-image sliding-score leaderboard.

A clean basket candidate must satisfy the renderer family:

- bbox near the known `42 x 66` family
- bright area near the known `1746 px` family
- near-exact white-family support
- dark shell support around the white component
- most shell-dark testimony comes from one connected dark component

Crucially: **do not gate on the total bbox/area of the dark component**. Overlapping black borders and map furniture may merge; only local enclosure matters.

Prototype clean-family envelope:

- bbox width `40..44`
- bbox height `64..68`
- bright area `1680..1785`
- 2px shell dark fraction `>= 0.50`
- dominant shell-dark component fraction `>= 0.80`

On Dev72 + Beaver this admits exactly the clean/topmost basket family observed above.

### Pass 2 — seeded overlap recovery

Do not scan the whole raster for partial basket fragments.

Start a BFS/queue from objects already known to exist:

- badge dark plates
- Pass-1 basket detections
- newly recovered baskets

For each seed, search only basket placements whose family bbox overlaps the seed perimeter. A recovered basket is then allowed to seed the next search, which supports basket-on-basket chains.

Search-space optimization:

1. tile the overlap region at about half the family width/height (`W/2`, `H/2`)
2. use visible white mass / family-piece evidence as a cheap coarse gate
3. refine the best tiles at a few-pixel stride
4. finish top hypotheses at stride 1

### Occlusion-aware evidence

Pass-1 detections establish the current-image family:

- expected white mask
- expected white-pixel count
- consensus dark-border mask around the family

For a Pass-2 candidate:

- mask the known seed occluder before measuring missing expected white
- measure `whiteCoverage` only on expected white that is still available
- measure `effectiveVisibility = availableFraction * whiteCoverage`
- require strong consensus black-border support outside the occluder
- allow the black border to be split across multiple dark components under overlap; do **not** reuse the strict Pass-1 single-component rule here

Prototype recovery gate:

- identity `>= 0.90`
- visible-family white coverage `>= 0.90`
- consensus black-border support `>= 0.80`
- effective basket visibility `>= 0.25`

The current prototype identity is deliberately simple:

`0.60*whiteCoverage + 0.30*blackBorder + 0.10*darkCoherence - 0.25*brightInExpectedBlack`

That formula is a lab probe, not yet a production constant.

## Confidence semantics

Basket confidence should mean **how much renderer identity is actually visible**, not raw matched-filter score and not later ownership agreement.

Proposed first buckets:

- `HIGH`: `effectiveVisibility >= 0.50` and identity gates pass
- `MEDIUM`: `0.25 <= effectiveVisibility < 0.50` and identity gates pass
- `LOW`: `< 0.25` visible, or identity testimony is incomplete

Thus a basket can be confidently detected even when its ownership is ambiguous, and a heavily occluded but real basket can remain in the pool without masquerading as high-confidence evidence.

## Why this is different from the old matcher

The old global matched filter asks every raster location whether it resembles the sprite and then tries to clean the echoes afterward.

This design instead uses renderer structure:

- clean baskets are a repeated exact white family inside local black enclosure
- partial baskets are searched only where a known renderer object could have occluded them
- duplicate shifted responses are not independent basket candidates
- confidence is explicit visibility + identity testimony

## Current status / caveat

The numbers above come from the Python reproduction probe used during this investigation. Beaver Ranch has now been visually inspected and is no longer blind for basket-detector development. Dev72 annotations were used only to evaluate candidate recall after the blind detector logic was fixed.

Next checkpoint: pure-TS port, regression tests for clean family / badge overlap / basket overlap, then rerun the basket gate before wiring ownership.