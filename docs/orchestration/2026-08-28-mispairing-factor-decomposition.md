# HeritagePark badge-5/tee-12 mispairing: factor decomposition

Run: default config (`packages/alg/src/detectors/threeFactor/configs/default.json`,
`dev72-recovered-default`, zfit OFF) against
`/home/user/chainspot-corpus/dev/Heritage/HeritagePark-full.png`, in-process
(no `./lab sweep`), repo revision `285a2b2` (clean, "9:37 pre-regression").
Source: `board.get('assignment.scoredPairs')`, the pre-recovery G6 scoring
table (before any post-G6 re-assignment touches `assignment`). Script:
scratchpad `decompose.ts`, wired like `scripts/chainspot-lab/sweep/operation.ts`
(`seedBoard` → `executeCompiledPlan` → read board slots) with `createNullSink()`.

Score (`scoring.ts:scorePair`, zfit off ⇒ zfit factor=1):
`score = alignedWorst · simplePath · teeOrientation · badgeFraction · collinearity · basketIdentity · recoveredPrior`.
`alignedWorst` isn't a printed factor; recovered below as
`factors.alignment × raw.worstWindowMean` (verified to reproduce `score` exactly).
`badge-5`/`badge-8`/`badge-4` are **internal G1 ordinals**, not hole
numbers: badge-5 reads "5" (H5), badge-8 reads "4" (H4), badge-4 reads "10" (H10).

## (a) badge-5 (H5) — top 10 of 252 candidate pairs

| rk | tee | basket | score | teeOrient | badgeFrac | collin | dist(tee→badge) | axis∠badge | fraction | collin∠ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | tee-12 | basket-1 | **0.1895** | 0.6565 | 1.0000 | 1.4402 | 317.2px | 7.8° | 0.496 | 1.1° |
| 2 | tee-12 | basket-3 | 0.1795 | 0.6565 | 0.9409 | 1.0000 | 317.2px | 7.8° | 0.587 | 22.6° |
| 3 | tee-12 | basket-0 | 0.1497 | 0.6565 | 1.0000 | 1.0000 | 317.2px | 7.8° | 0.337 | 29.2° |
| 4 | tee-12 | basket-7 | 0.1447 | 0.6565 | 1.0000 | 1.0000 | 317.2px | 7.8° | 0.541 | 54.2° |
| 5 | tee-12 | basket-4 | 0.0954 | 0.6565 | 1.0000 | 1.0000 | 317.2px | 7.8° | 0.427 | 42.8° |
| 6 | tee-12 | basket-2 | 0.0876 | 0.6565 | 0.4385 | 1.0470 | 317.2px | 7.8° | 0.686 | 3.2° |
| 7 | tee-3 | basket-12 | 0.0237 | 0.0946 | 1.0000 | 1.0000 | 278.9px | 18.4° | 0.379 | 21.7° |
| 8 | tee-11 | basket-1 | 0.0218 | 0.1124 | 1.0000 | 1.0000 | 292.2px | 17.7° | 0.474 | 11.5° |
| 9 | tee-11 | basket-0 | 0.0218 | 0.1124 | 1.0000 | 1.0000 | 292.2px | 17.7° | 0.276 | 47.0° |
| 10 | tee-11 | basket-7 | 0.0218 | 0.1124 | 1.0000 | 1.0000 | 292.2px | 17.7° | 0.441 | 70.7° |

All 6 top rows are the same physically-wrong tee (`tee-12`, hole 4's pad)
against 6 different baskets — not one lucky pair, the whole top of the list.
(`simplePath`/`basketIdentity`/`recoveredPrior`/`zfit` = 1.0000 throughout, omitted.)

## (b) badge-5's candidate pool — there is no H5 tee to find

badge-5 (721,1078) has **no visible tee of its own** in `assignment.tees`
(pad occluded by a basket sprite). Its 252-pair pool is built entirely from
the *other* 17 tees; the three reaching its rank window — `tee-12`
(708,1394.5, hole 4's pad, 317px away), `tee-3` (882.5,850.4, 279px away),
`tee-11` (829.1,1348.8, 292px away) — are every one wrong. The real question
isn't "which is right" (none is) but why the best wrong answer (0.19) reads
confident instead of uniformly bad: `tee-12`'s `teeOrientation` sits at
0.66, not near 0, while `tee-3`/`tee-11` (also wrong, similarly plausible)
get crushed to 0.09–0.11.

## (c) badge-8 (H4) — true pairing, top 5 of 252

| rk | tee | basket | score | teeOrient | badgeFrac | collin | dist(tee→badge) | axis∠badge |
|---|---|---|---|---|---|---|---|---|
| 1 | tee-12 | basket-6 | **0.3660** | 0.9893 | 1.0000 | 1.0000 | 53.0px | 1.2° |
| 2 | tee-12 | basket-8 | 0.3553 | 0.9893 | 1.0000 | 1.0000 | 53.0px | 1.2° |
| 3 | tee-3 | basket-16 | 0.2472 | 0.9868 | 1.0000 | 1.0000 | 518.8px | 1.4° |
| 4 | tee-12 | basket-2 | 0.2130 | 0.9893 | 0.8705 | 1.0001 | 53.0px | 1.2° |
| 5 | tee-12 | basket-7 | 0.1717 | 0.9893 | 1.0000 | 1.0000 | 53.0px | 1.2° |

`tee-12` really is 53.0px from badge-8 (question's "52px", rounding aside),
axis `1.7464rad` missing badge-8's true bearing by only **1.2°** — the
correct pairing, physically and by score.

## (d) badge-4 (H10) — the 745px tee-13 pairing, and why it scores ~0

`tee-13` sits at (349.8,1477.5), `angleRad=0` (degenerate/flat-read axis),
744.6px from badge-4 (965,1058), 34.2° off axis. All 18 basket rows score ~0:

| basket | score | teeOrient | badgeFrac | collin |
|---|---|---|---|---|
| basket-0 (best badgeFrac) | 0.0000 | 0.0003 | 0.5900 | 1.0000 |
| basket-4 | 0.0000 | 0.0003 | 0.0200 | 1.1972 |
| basket-17 | 0.0000 | 0.0003 | 0.0001 | 1.0000 |
| (15 more) | ≤0.0000 | 0.0003 | ≤0.59 | ~1.0 |

Best tee-13 row ranks **30th of 252** under badge-4. `teeOrientation`=0.0003
regardless of basket — at 34.2° against `teeOrientationSigma=12`,
`exp(-(34.2/12)²)` collapses to essentially zero: `teeOrientation` working
exactly as designed, crushing a genuinely wrong tee no matter the basket —
the contrast that makes (a)'s `tee-12` conspicuous.

Reference geometry (`.tipXPx/.tipYPx` for baskets): `tee-12`=(708.0,1394.5)
axis=1.7464rad, `tee-3`=(882.5,850.4) axis=1.8685rad, `tee-11`=(829.1,1348.8)
axis=1.4999rad, `tee-13`=(349.8,1477.5) axis=0; badge-5=(721,1078),
badge-8=(718,1343), badge-4=(965,1058); basket-1=(721,755), basket-6=(709,1173).

## Verdict

**The factor that fails to discriminate is `teeOrientation`, because its
sigma (12°) is too wide relative to the real angular gap between `tee-12`'s
true target and its false one.** `tee-12`'s stored axis threads a line
passing near *both* badge-8 (1.2° off, the true hole-4 aim) and badge-5
(7.8° off), since hole-4's and hole-5's badges happen to sit close to a
common bearing from that tee. A 12° sigma barely distinguishes "1.2° off"
from "7.8° off" (`exp(-(1.2/12)²)=0.99` vs `exp(-(7.8/12)²)=0.66`) — a 6.6°
real gap costs only 33 points of factor, nowhere near the crush `tee-13`
takes at 34.2° (0.0003). Contrast badge-5's other candidates `tee-3`/`tee-11`
(also wrong, similar distance) whose larger axis errors (18.4°, 17.7°) sit
past the sigma's discrimination radius and correctly flatten to 0.09–0.11.
`tee-12` alone escapes because its axis geometry happens to sit closer to
badge-5's bearing than the others' — a geometric accident, not a special case
in the scorer.

**`collinearity` compounds the escape.** It's a *bonus*, not a penalty
(`1 + 0.6·exp(...)`, floor 1.0, ceiling 1.6): the winning row draws
collin∠=1.1° (basket-1 lies almost exactly along the tee-12→badge-5 ray),
earning a 1.44× multiplier atop the under-punished orientation — the 44%
separating rank 1 (0.1895) from the next tee-12 row without that lucky
basket alignment (row 3, 0.1497, same tee/badge/orientation, no bonus).

**`badgeFraction` is neutral here** — saturated at 1.0000 on the winning row
(`fraction`=0.496 inside `target 0.36 ± tolerance 0.19` = [0.17, 0.55]):
not the culprit, not the fix.

**Net effect:** `teeOrientation`'s 12° sigma cannot tell "axis is dead-on"
from "axis passes near a *different* badge along a similar bearing," and
`collinearity`'s bonus then rewards whichever basket completes that
coincidental line — turning a pool that should read "uniformly bad, no real
H5 tee here" into a confident rank-1 at 0.19, which is what let recovery
skip past badge-5's true occlusion instead of flagging it.
