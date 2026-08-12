# Deferred detection experiments

Detection/grammar changes that were built, validated for safety, and then
deliberately **not** wired into the live pipeline -- either because they
regressed something and got walked back, or because they're safe but have
no demonstrated benefit yet. Kept here so the next person (or agent) doesn't
have to rediscover them from git archaeology, and doesn't re-attempt one
that's already been tried and found wanting.

**Convention**: a deferred idea's code lives in its own file (or a clearly
self-contained section of an existing file), fully implemented and unit
tested, but either (a) never imported by the live pipeline
(`courseGrammar.ts`, `cvCalibratedDetectors.ts`, `basketDetection.worker.ts`,
`scripts/detect-course.ts`), or (b) wired in behind an explicit,
off-by-default flag (see `TeeBootstrapExperiments` in
`cvCalibratedDetectors.ts`) when the idea is cheap to re-test and worth
keeping reachable from the CLI without resurrecting a diff first --
production call sites (`basketDetection.worker.ts`) must not pass the flag,
so real users see (a) and (b) identically. Add an entry below when you defer
something new. Move an entry to "graduated" (or delete it) once it actually
gets wired in and ships (i.e. its flag, if any, flips to on by default).

---

## Bend-toward-next-tee basket polarity

**File**: `src/lib/autoAnnotation/basketBendPolarity.ts` (+ tests in
`tests/unit/basketBendPolarity.test.ts`). Not imported anywhere else.

**Idea**: `courseGrammar.ts`'s basket-polarity penalty assumes a straight
tee->badge->basket line. On a dogleg the badge doesn't sit on that line at
all -- checked against ground truth (IMG_5641 + Alex Clark, the two fixtures
with full tee+basket truth) and found that 5 of 6 bent holes across both
courses bend toward hole (N+1)'s tee, a real pattern. The module computes a
discounted polarity penalty for a candidate whose bend direction matches.

**Status**: built, wired into `courseGrammar.ts` briefly, found to regress
IMG_5641's basket accuracy 18/18 -> 16/18 (an ungated discount let a wrong
candidate underbid a correct, already-well-fitting straight basket on two
clearly-straight holes). Fixed with a gate (only discount when no nearby
candidate already fits the straight model well) and re-verified back to
zero regression on both fixtures -- but at that point it also had zero
measured benefit: every bent hole on both fixtures was already correctly
assigned without the discount. Pulled back out of `courseGrammar.ts` and
parked here instead of landing safe-but-unproven code in the live path.

**What would justify wiring it in**: a real course where a bent hole's
basket is currently mis-assigned *and* this discount would fix it. Alex
Clark's 7 badly-wrong baskets (see below) are not that case -- checked, none
of them are bend/polarity failures.

**To wire in**: replace `courseGrammar.ts`'s plain `basketCost` polarity
term with a call into `bendAwarePolarityPenaltyPx`, using
`isBendDiscountEligible` to gate it per hole, in Stage 4 of
`associateCourseGrammar`. The exact integration (computing `nextTee` from
`teeForHole`, requiring it to be non-bootstrap) is preserved in this
branch's git history if you want the reference implementation rather than
redoing it from scratch.

---

## Putting-circle / basket-icon occlusion masking for tee recovery

**Status**: landed and wired in (unlike the other entries in this doc).
**Branch**: `claude/teepad-putting-circle-recovery`.
**Files**: `src/lib/autoAnnotation/teePadDetection.ts`
(`fitPuttingCircleRadiusPx`, `derivePuttingCircleMasksPx`,
`deriveBasketIconMasksPx`), a third recovery tier in
`detectCalibratedTeeBootstrap` (`cvCalibratedDetectors.ts`).

**Idea**: `teePadDetection.ts` already had an `ignoreCirclesPx` masking
option built for "tee pads whose outline is broken by a putting circle or a
basket icon," never wired to a real basket position by any live caller. Two
maskers feed it: `derivePuttingCircleMasksPx` fits a putting circle's radius
per image (pooling evidence across confidently-detected baskets, since the
radius is constant within one image but varies by map zoom across different
screenshots) and masks an annulus; `deriveBasketIconMasksPx` masks a disc
offset upward from a basket's stem anchor (the icon graphic is drawn almost
entirely above its own anchor point, measured directly off a real course
image -- see the function's doc comment), sized as a UI-scale-relative
constant since the icon, unlike the putting circle, is a fixed-size UI
element rather than something drawn at map scale. Both only ever run for
badges still not AUTO after every existing tier.

**Result**: safe on both ground-truth fixtures (IMG_5641 unaffected: still
17/18 tees, 18/18 baskets; zero regressions confirmed against the full unit
suite and the CV gallery gate). On Alex Clark, basket accuracy improved
8/18 -> 9/18 (hole 9 newly correct) with the icon masking added, and no
tee/basket regressed anywhere.

It does **not**, however, recover the holes that motivated it: IMG_5641's
hole 3 (putting-circle-crossed) and Alex Clark's holes 8/11/13 (icon
sits almost directly on the tee). Checked directly (temporary debug
logging, since removed): the masked occluded-edge-loop search does return
*something* for these holes, but it's the same spurious noise for multiple
different holes, not the real pad -- and the existing acceptance logic
correctly rejects it rather than shipping a confident wrong answer, which is
why these holes end up missing rather than wrong. For hole 3 specifically:
the rail-pair (Hough) search finds nothing within 160px of the true
location even with the dash masked out -- the dash apparently crosses the
pad's own near rail, not just open space next to it, and the pad's long
axis is close to tangent to the ring at that point (the worst-case angle
for a rail-pair detector). The existing weak-tee NCC template sweep, a more
thorough angular/distance search, doesn't find it either. Same story for
the icon-occluded Alex Clark holes: not enough of the rectangle survives
for rail-pairing to work with, regardless of what's masked out.

**What would justify reviving it further**: see the masked-NCC-template
entry below -- that's the follow-up this pointed at, and it's also deferred,
for a different reason.

---

## Masked-NCC-template tee-pad recovery

**File**: `src/lib/autoAnnotation/teeOcclusionRecovery.ts` (+ tests in
`tests/unit/teeOcclusionRecovery.test.ts`). Not imported anywhere else --
briefly wired into `detectCalibratedTeeBootstrap` as a fourth recovery tier,
then pulled back out. Both maskers from the entry above
(`fitPuttingCircleRadiusPx`, `deriveBasketIconMasksPx`) are reusable as-is
as this module's mask source, and it's built to take them directly.

**Idea**: the entry above found that rail-pair (Hough) detection, even with
the occluder masked out, often doesn't have enough surviving rectangle to
work with. This module tries a fundamentally different signal --
`findOccludedTeePadMatch` mirrors `basketOcclusionRecovery.ts`'s technique
exactly: a coarse-to-fine, masked, zero-mean NCC search for a synthesized
tee-pad rectangle template (reusing `teeBootstrapPolicy.ts`'s proven
rim/interior/background rectangle synthesis, reimplemented self-contained
per this module's own convention), scored only over pixels not covered by a
known occluder (every badge on the course, plus the putting-circle/icon
masks above). Unlike rail-pairing, this only needs *some* surviving
pad-shaped pixels, not two intact parallel rail segments -- so in principle
it should tolerate heavier occlusion.

**Status**: the core module is sound -- 5 unit tests against synthetic
rasters all pass, including a partially-occluded pad recovered correctly
via masking. It's the real-world validation that failed. Wired in and
tested against IMG_5641 (hole 3) and Alex Clark (holes 8/11/12/13):

1. First pass (full `majorSizesPx` range, `max(autoDistancesPx) * 1.5`
   search radius, `MIN_TRUSTED_FRACTION = 0.2`): found nothing correct
   anywhere, and for hole 3 specifically, confidently matched (score 0.89)
   a location 300px from the true tee -- a false positive from the
   *smallest* candidate size correlating with unrelated structure, using
   only 30% of its pixels.
2. Tightened `MIN_TRUSTED_FRACTION` to 0.55 and `MIN_MASKED_SCORE` to 0.6:
   still found a false positive nearby (score 0.69-0.73), just at a
   different location.
3. Tightened the search radius to the course's *median* auto-tier
   badge-to-tee distance × 1.3 instead of the max × 1.5 (a max-based radius
   sized to the course's longest hole was letting the search reach 230-300px
   away): the false positive persisted at essentially the same location,
   just outside the new, smaller radius by a hair less than before.
4. Restricted the search to a single representative pad size instead of the
   full course-observed size range: same false positive, same location,
   now scoring against the representative size instead of the smallest one.
5. Visually inspected the false-positive location (see this session's
   record for the crop): it's a **dashed walking/cart path**, not a tee pad
   or random noise. The small light-colored dashes against a darker
   background apparently correlate with a small rectangular rim/interior
   template closely enough to survive every threshold tightened above.

This is a genuinely new failure mode, distinct from what motivated the
module (putting-circle/basket-icon occlusion): dashed path segments are
visually pad-*like* in exactly the features (bright rim, roughly rectangular
dash, contrast against background) the template is built to detect. Pulled
the live wiring back out rather than ship a recovery path that produces
confidently wrong matches -- worse than the status quo of leaving a hole
unresolved.

**What would justify reviving it**: a way to distinguish a real, isolated
tee-pad rectangle from one dash in a *periodic sequence* of similar small
rectangles (a real path is a repeating pattern; a real pad is not) --
e.g., reject a candidate whose local neighborhood contains other
similarly-sized, similarly-oriented bright blobs at roughly regular
spacing. Alternatively, cross-validate any masked-NCC match against the
badge-ray invariant (`teeBootstrapPolicy.ts`'s `TeeBadgeRayEvidence`) more
strictly than this first attempt did, since a real tee's major axis should
point at its own badge and a path-dash's "orientation" is just whatever the
path happens to run at.

---

## Dashed walking/cart-path detector

**File**: `src/lib/autoAnnotation/teePadDetection.ts`
(`detectDashedPathChains`, `deriveWalkingPathMasksPx`, + tests in
`tests/unit/walkingPathDetection.test.ts`). Exported, but only ever called
by tests -- no production caller.

**Idea**: this is the periodicity discriminator the masked-NCC entry above
asked for. A course's walking/cart path is drawn as a sequence of short
bright dashes, calibrated straight off a real image (IMG_5641, the path
near hole 3): ~17px dashes, ~24-25px start-to-start spacing at
uiScalePx~1.81. `detectDashedPathChains` finds dashes via HoughLinesP on a
bright/low-saturation mask, then unions them into chains via union-find on
angle + distance + perpendicular-offset from the chain's own line, keeping
only groups of >=3 (fewer is indistinguishable from an isolated rectangle,
the exact ambiguity this exists to resolve). `deriveWalkingPathMasksPx`
turns a chain into one `ignoreCirclesPx` exclusion circle per dash, for the
same masking pool `derivePuttingCircleMasksPx`/`deriveBasketIconMasksPx`
feed.

Building this surfaced a real, separate bug: `orientationDeg` is undirected
mod 180, so two dashes on the same physical line can legitimately read ~0
and ~180 depending on which end Hough returns first (arbitrary per
detection). Naively averaging two such readings gives ~90 -- a spurious
perpendicular reference angle that silently fractured real chains in
testing (a synthetic 6-dash chain was only grouping 3). Fixed with
`circularMeanOrientationDeg` (averages the doubled angle as a unit vector,
which has no wraparound ambiguity) for both the pairwise perpendicular
check and the chain's summary orientation. Checked the two places in the
*live* pipeline that combine multiple angle/direction estimates
(`occludedPair` in this file, `badgeRayInvariantHolds` in
`teePadOrientation.ts`) -- both already sign-align via dot product before
combining, a different but equally correct fix for the same ambiguity, so
neither had this bug.

**Status**: wired as exclusion masking (goal 1: keep a path from being
mistaken for a pad) into `detectCalibratedTeeBootstrap`'s tier-3 recovery,
tested against both ground-truth fixtures. GoldenTeeSet (IMG_5641):
byte-identical result with and without -- `correctHoles` unchanged at
17/18, hole 3 wrong at exactly the same 151.6px both times. The path
masking made no difference there at all (nothing near hole 3 changed
candidate-side once masked). Alex Clark: `correctHoles` unchanged for both
tee (12/18) and basket (10/18) with and without. Hole 10 -- the one
actually adjacent to a path, the case that motivated this in the first
place -- is untouched, wrong at exactly the 205.5px distance either way,
consistent with the subagent finding (commit `5f54801`) that hole 10
loses ownership to an unrelated occluded-edge-loop false positive, not a
path-occlusion problem. One side effect: hole 8 (tee and basket) flipped
from *missing* to *wrong* (spurious candidates at 241px/90px) once the
path mask was live -- `correctHoles` didn't change, but it's a sign the
newly-unmasked pixels are exposing something, just not the truth. Safe
(no regression on either fixture) but zero measured benefit, so per this
doc's own convention it stays **off by default** in the live pipeline,
same disposition as the two entries above it.

Rather than reverting the wiring outright (which would mean resurrecting
a diff from git history to re-test it later), it's gated behind an
explicit, off-by-default lever: `TeeBootstrapExperiments.walkingPathMasking`,
the sixth parameter of `detectCalibratedTeeBootstrap`
(`cvCalibratedDetectors.ts`). `basketDetection.worker.ts` (production)
doesn't pass it, so real users get exactly the same behavior as a full
revert. `scripts/detect-course.ts` exposes it as
`--experiment-walking-path-masking` specifically so re-testing this (or
any future course) is a one-flag CLI run, not a code change --
`npx tsx scripts/detect-course.ts <bundle> --experiment-walking-path-masking --out <dir>`
reproduces the "on" numbers above exactly; omitting the flag reproduces
the "off"/production numbers exactly (both verified byte-for-byte before
this entry was written).

**What would justify wiring it in by default**: a real course where a
hole's tee/basket recovery search is actually blocked by a path crossing
the evidence *and* flipping the flag changes the outcome for the better --
neither ground-truth fixture's currently-broken holes are that case yet.
Worth re-running the flag once more labeled courses with path-crossed pads
exist, rather than reimplementing the masking from scratch.

**Goal 2 (not started by this entry)**: using a path chain's terminus and
direction as a *positive* signal for an unresolved hole's tee position/
orientation -- course routing walks from one green to the next tee, so a
chain ending near a badge with no resolved tee is suggestive. Needs its own
empirical validation (does this actually hold on the labeled courses, and
often enough to be useful) before any implementation; not attempted here.

---

## Tee-axis-alignment / white-edge-rail tee recovery

**Source**: commit `b51528e` on `origin/main`'s history (reverted by
`6d62e32`, never present on this branch). No file currently in this repo --
recoverable via `git show b51528e -- <path>` against
`courseGrammar.ts`/`teePadDetection.ts`/`cvCalibratedDetectors.ts`.

**Idea**: a `detectWhiteEdgeCandidates` fallback (finds a tee from its
surviving white perimeter rail when the gray interior is occluded) plus a
tee-axis-alignment / tee-badge-ray-conflict penalty in `courseGrammar.ts`
(a tee pad's fitted major axis should point at its own badge).

**Status**: independently reconstructed and benchmarked (once by this
session, once by a separate agent working the same task in parallel) against
`scripts/benchmark-course-corpus.ts`. Both reconstructions found it
regresses tee accuracy (17/18 -> 16/18) and, via wrong tees flipping
Stage-4 basket polarity scoring, basket accuracy too (18/18 -> 16/18 or
worse). Not landed by either attempt.

**What would justify reviving it**: a different scoring formula --the core
problem was that axis-alignment/ray-conflict penalties changed the *winner*
of the Hungarian solve for holes that were already correct, not just for
genuinely occluded ones. Any revival needs the same "only touch holes
already struggling" scoping this file's other two entries converged on
independently.

---

## Alex Clark hole 5/10 tee misses: not a terrain-color threshold, and hole 10's cause is still open

**Investigated, partially fixed**: `src/lib/autoAnnotation/teeBootstrapPolicy.ts`
now proposes a genuinely-tied candidate to both badges it's equidistant from
(see `assessCandidate`'s ownership-tie handling and
`AMBIGUOUS_STRONG_PAD_CONFIDENCE_CAP`); that recovers hole 5's real tee pad
as a REVIEW proposal. Hole 10's failure has a *different* cause, described
below, and is still open.

**The working hypothesis going in was wrong**: Alex Clark hole 5's tee
(green-grass terrain) looked like a `detectGrayCenterCandidates`/
`detectEdgeLoopCandidates` saturation/value-band miss tuned against
IMG_5641's brown/dirt terrain. Direct pixel measurement refutes this: the
real pad interior at hole 5 (median HSV `~(24, 3, 147-160)`) and at the
correctly-detected hole 1 control (median `~(75, 3, 161)`) are essentially
identical in saturation and value -- both comfortably inside the fixed
`[148,168]` value / `<18` saturation gray-center window, and both detectors
in fact find hole 5's real pad (dual `edge-loop`+`gray-center` support,
14px from the labeled ground truth) when run in isolation. Terrain color is
not the discriminator; nothing in `teePadDetection.ts`'s thresholds needed
to change.

**Hole 5's real cause**: hole 5's pad sits almost exactly on the line
between hole 3's badge and hole 5's own badge (a course-layout coincidence:
badge-ray distances of ~146px and ~148px, well inside the tie margin).
`teeBootstrapPolicy.ts`'s ownership model picked whichever badge was a few
pixels closer and discarded the candidate for the other entirely, so hole 5
never saw its own real pad as a candidate at all and fell back to a much
worse `occluded-edge-loop` guess ~275px away. Fixed by proposing a
genuinely-tied candidate to both competing badges (each capped at a
confidence tier that lets an unambiguous real match for either badge still
win, but that isn't automatically buried under a lower-tier single-support
guess) -- see the "genuinely tied pad" test in
`tests/unit/teeBootstrapPolicy.test.ts`. This lands hole 5 on its correct
physical pad (274.9px error -> 14.3px), though it stays just outside the
12.7px auto-grading tolerance: the labeled ground-truth point itself sits
~14px from the pad's own measured visual center (confirmed by directly
segmenting the rim-enclosed interior blob), which looks like a label
placement quirk specific to this hole rather than a detector error worth
chasing further.

**Hole 10's cause is different, and unresolved**: hole 10's real pad is
also found almost exactly (`gray-center` only, 2px from ground truth) --
its `edge-loop` support is missing because the badge/dashed-cart-path
occlusion visible over that tee breaks the Canny rim (a real, already-known
occlusion problem, not terrain color either). That alone would only cost it
`strong` pad evidence, not ownership -- unlike hole 5, there's no badge-ray
tie here. Instead, an unrelated `occluded-edge-loop` rail-pair false
positive elsewhere in the image (small parallel-edge structure that isn't
a real tee, at `(388.9, 511.4)`) happens to score a fraction higher on
`teeBootstrapPolicy.ts`'s confidence ladder -- 0.79 vs. 0.73 -- than hole
10's real, correctly-located pad, purely because both are single-support
("weak" pad evidence) and the false positive's orientation-NCC score and
ray alignment happen to be marginally better. The ownership-tie fix above
does not touch this: there is no tie, just a real candidate narrowly
losing a magnitude contest to a decoy.

**What would justify a hole-10 fix**: some terrain-independent way to
prefer a primary-detector-supported candidate (`gray-center`/`edge-loop`)
over an `occluded-edge-loop`-only one when they compete for the same badge
at similar confidence -- e.g. a distinct base tier between today's binary
`strong`/`weak` `padEvidence`, or a modest confidence discount specific to
`occluded-edge-loop`-only support. Prototyping that (by hand, not landed)
showed the two candidates end up within a hair of an exact tie rather than
a clean win, which is a sign the underlying confidence formula needs more
than a single constant tweak to separate "recovery-tier guess" from
"occlusion-weakened but real" evidence -- and `occluded-edge-loop` is the
exact detector tier the parallel `claude/teepad-putting-circle-recovery`
occlusion-masking work is actively tuning, so reweighting its general
competitiveness is higher-conflict, higher-risk surface than the narrow
ownership-tie fix above. Left open rather than forced.
