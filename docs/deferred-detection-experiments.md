# Deferred detection experiments

Detection/grammar changes that were built, validated for safety, and then
deliberately **not** wired into the live pipeline -- either because they
regressed something and got walked back, or because they're safe but have
no demonstrated benefit yet. Kept here so the next person (or agent) doesn't
have to rediscover them from git archaeology, and doesn't re-attempt one
that's already been tried and found wanting.

**Convention**: a deferred idea's code lives in its own file (or a clearly
self-contained section of an existing file), fully implemented and unit
tested, but never imported by the live pipeline (`courseGrammar.ts`,
`cvCalibratedDetectors.ts`, `basketDetection.worker.ts`,
`scripts/detect-course.ts`). Add an entry below when you defer something new.
Move an entry to "graduated" (or delete it) once it actually gets wired in
and ships.

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

**What would justify reviving it further**: a masked-NCC-template approach
instead of rail-pair detection (mirroring `basketOcclusionRecovery.ts`'s
technique for the analogous basket case), or extending
`teeBootstrapPolicy.ts`'s template sweep with the same
putting-circle/icon-structure masking. Both maskers here
(`fitPuttingCircleRadiusPx`, `deriveBasketIconMasksPx`) are reusable as-is
as the mask source for either approach -- the gap isn't the masking, it's
that rail-pair detection needs more surviving rectangle than a masked-out
occluder reliably leaves behind.

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
