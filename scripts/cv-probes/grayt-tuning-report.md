# GRayT tuning: leave-one-course-out cross-validation

Scope: `scripts/cv-probes/hole_path_tee_recovery.py` (stage 1: badge-anchored
ribbon-ray fit) + `scripts/cv-probes/ray_template_fusion.py` (stage 2:
world-size pad-template NCC fusion + gate). Driver: `scripts/cv-probes/grayt_tune.py`.
No production code under `src/` was touched.

## TL;DR

- **Only 2 labeled (truth-bearing) courses exist in this repo snapshot** --
  GoldenTeeSet and AlexClarkSet. Per the task's hard rule, LOOCV results
  below are **indicative, not proof**. A third labeled course would meaningfully
  change how much these numbers can be trusted.
- The naive tuning objective ("maximize gate-passes at zero false accepts,
  fit per training course") **does not reliably generalize**: parameters fit
  on GoldenTeeSet alone chose a gate threshold of 0.47, which produced a
  **false accept on AlexClarkSet hole 18** (NCC 0.518, 145.3px off truth) --
  a threshold the current shipped default (0.55) avoids. This is the
  headline finding, reported plainly per the task's instructions rather than
  papered over.
- One change held up as a safe, non-overfit improvement on **both** labeled
  courses without touching the risky gate threshold: widening the stage-1
  closing window 18px -> 24px. Recommended in `best-params.json`.
- 4 user-supplied overlay-only captures (UDisc app screenshots) were run
  through the tuned chain. They gate-pass almost nothing (0-1 of 18 holes
  each) -- explained below, not a tuning failure. One gate-passed candidate
  was caught as inconsistent by the ribbon-evidence check, which is exactly
  what that check is for.

## Search space

**Stage 1** (`Stage1Params`): grid over `evidence_thresh in {0.15, 0.20,
0.25}` x `closing_window_px in {12, 18, 24}` (9 combos). `bearing_sweep_deg`,
`box_mean_window`, `scale`, `evidence_dl`, and the rest were held at their
current defaults -- varying them multiplies runtime for parameters the prior
findings-doc grid search did not flag as high-leverage, so they were left
fixed to keep the search sane, per the task's "keep total runtime sane"
instruction. All are still exposed as CLI flags on the probe itself for
future search.

**Stage 2** (`Stage2Params`): grid over `rim_fraction in {0.09, 0.11, 0.13}`
(3 combos), crossed with every stage-1 combo (27 total). Template bank,
aspect, bearing refinement (±4°), lateral offsets (±3px), and along-ray step
were held at default -- the original findings doc already showed clean
gate separation with these values, and the 27-combo stage-1 x rim_fraction
grid was the priority given the 2-course sample size.

**Gate threshold**: swept over `[0.25, 0.90]` in 0.01 steps for every
stage-1 x stage-2-geometry combo. This sweep is free (NCC scores don't
depend on the threshold), so it's exhaustive rather than gridded.

**Objective**, evaluated only on the training course(s) of each fold, in
strict priority order matching the task spec: (a) zero false accepts (a
gate-pass farther than 12.69px -- the tolerance already used throughout this
codebase -- from truth), (b) maximize gate-passed count, (c) minimize mean
error of passes. A threshold that admits even one false accept on the
training data is excluded outright, never traded for more passes.

Runtime: ~72-146s per 27-combo grid-search call (badge/basket detection is
cached separately via `scripts/detect-course.ts`, ~15-20s/course, paid once).

## LOOCV protocol and honesty bookkeeping

With N=2 labeled courses, "leave-one-course-out" degenerates to: fit on
course A alone, evaluate (with truth) on course B; fit on B alone, evaluate
on A. **Every number in the "TEST" rows below comes from a course whose own
truth never touched the parameter search that produced it.** The "TRAIN
objective" rows are diagnostic only (what the search saw) -- not
generalization evidence. The "in-sample" numbers later in this report (both
courses combined) are **not cross-validated** and are labeled as such
everywhere they appear.

## LOOCV results

| Held-out (TEST) course | Trained on | Gate-passes | False accepts | Mean err of passes | Max err of passes |
|---|---|---|---|---|---|
| GoldenTeeSet | AlexClarkSet only | 14/18 | **0** | 3.78px | 8.1px |
| AlexClarkSet | GoldenTeeSet only | 9/18 | **1** | 21.14px | 145.3px |

Chosen parameters per fold (picked blind to the test course):

| Fold (trained on) | evidence_thresh | closing_window_px | rim_fraction | gate threshold |
|---|---|---|---|---|
| AlexClarkSet | 0.25 | 24.0 | 0.09 | 0.48 |
| GoldenTeeSet | 0.20 | 24.0 | 0.13 | 0.47 |

Same TEST courses evaluated at the **current shipped defaults**
(`evidence_thresh=0.2, closing_window_px=18, rim_fraction=0.11, gate=0.55`),
for comparison:

| Course (defaults) | Gate-passes | False accepts | Mean err of passes | Max err of passes |
|---|---|---|---|---|
| GoldenTeeSet | 14/18 | 0 | 3.75px | 7.2px |
| AlexClarkSet | 7/18 | 0 | 5.73px | 7.6px |

**Reading this honestly:**

- **GoldenTeeSet fold**: tuned and default are statistically indistinguishable
  (14/18 either way, mean error within 0.03px of each other). Fitting on
  AlexClarkSet alone did not find a meaningfully better -- or worse -- config
  for GoldenTeeSet.
- **AlexClarkSet fold**: tuned parameters (fit on GoldenTeeSet alone) do get
  more passes (9 vs 7) but **at the cost of exactly the property the task
  spec says must never be traded away**: one gate-passed recovery lands
  145.3px from truth. The offending hole (AlexClarkSet hole 18) scores NCC
  0.518 -- comfortably above the tuned fold's threshold of 0.47/0.52, but
  just under the current default of 0.55. This hole is the same
  "road/parking confuser" flagged in the original stage-1 findings doc
  (ray-only error 68.9px on this hole); stage 2's template match still finds
  *something* plausible-scoring along that ray, and only the higher default
  gate keeps it out.
- **Conclusion**: the grid search's greedy "fit threshold to maximize
  passes at zero-FA on whatever course you can see" objective is
  **overfit-prone at this sample size** -- it found a threshold that looks
  safe on its one training course and isn't safe on the other. This is the
  finding the task's hard rule asks to surface plainly rather than average
  away: **zero false accepts at a materially lower gate threshold than 0.55
  is not established by this evidence**, and lowering the gate is not
  recommended.

## Chosen parameter set vs. current defaults

Given the above, the recommendation in `best-params.json` is **not** the
raw grid-search argmax (in-sample fit on both courses combined --
`evidence_thresh=0.25, closing_window_px=24, rim_fraction=0.13, gate=0.52`,
23/36 passes, 0 FA in-sample). That configuration's margin is razor-thin:
AlexClarkSet hole 18 scores NCC 0.518, only 0.002 below its chosen gate of
0.52 -- the same fragility that produced a real false accept in the LOOCV
fold above, just barely avoided here because both courses' data informed
the pick. Trusting a 0.002 margin found by fitting on 2 courses to hold on
a third, unseen course is not warranted by this evidence.

Instead, the recommendation keeps the **gate threshold and all stage-2
geometry at their current shipped defaults**, and adopts the one change
that both LOOCV folds *independently* preferred and that improves or
matches **both** labeled courses simultaneously without touching the gate:
widening the stage-1 closing window from 18px to 24px.

| Course | Metric | Current defaults (closing=18) | Recommended (closing=24, gate unchanged) |
|---|---|---|---|
| GoldenTeeSet | gate-passes | 14/18 | 14/18 |
| GoldenTeeSet | false accepts | 0 | 0 |
| GoldenTeeSet | mean err of passes | 3.75px | 3.73px |
| AlexClarkSet | gate-passes | 7/18 | **8/18** |
| AlexClarkSet | false accepts | 0 | 0 |
| AlexClarkSet | mean err of passes | 5.73px | **5.44px** |

Total across both courses: 21/36 -> 22/36 gate-passed, zero false accepts
maintained on both. Both folds' independent single-course grid searches
landed on `closing_window_px=24` -- the top of the searched grid -- which is
a mild signal the true optimum may be even wider; not chased further here
to keep the search bounded, flagged as a natural next step.

**Caveat on this specific number**: because it was chosen by noticing that
*both* folds' independently-blind searches agreed on this one value, and is
then evaluated on both courses, it is technically informed by both courses'
truth in aggregate (unlike the strict per-fold LOOCV numbers above). It is
lower-risk than the raw grid argmax (it doesn't touch the gate, and it's a
single low-dimensional change that helps both courses rather than one
picked to specifically maximize one course's score), but it is **not**
independently blind-tested the way the LOOCV fold numbers are. Treat it as
a reasonable default informed by 2 courses' agreement, not as proven
generalization to a third course.

## Which courses influenced which numbers (explicit)

- **LOOCV "TEST" row for GoldenTeeSet**: parameters chosen using
  AlexClarkSet's truth only. GoldenTeeSet's truth was used exclusively for
  grading, never for fitting. Cross-validated.
- **LOOCV "TEST" row for AlexClarkSet**: parameters chosen using
  GoldenTeeSet's truth only. AlexClarkSet's truth was used exclusively for
  grading. Cross-validated.
- **"Current defaults" rows**: not fit on any course in this repo snapshot
  at all (pre-existing hardcoded constants from prior work) -- included as
  an apples-to-apples baseline, not as a cross-validation claim of their own.
- **Final recommended config's per-course numbers** (the `closing_window_px=24`
  table above) and the **raw grid-search argmax**: both courses' truth
  informed these. **Not cross-validated. Not generalization evidence.**
  Reported for transparency only.
- **Overlay-only courses** (below): no truth exists for these at all. They
  never influenced any parameter choice in this report, in either direction.

## Overlay-only courses

4 UDisc-app-screenshot captures were supplied for this pass (phone
screenshots with status-bar/toolbar chrome, satellite basemap, numbered pin
markers -- `resources/held-out/{NorthPark-ShortTees,HeritagePark-Main,
TowneLake-RedTees-a,TowneLake-RedTees-b}.png`). No truth exists for them;
they were never used to fit parameters. The tuned chain (recommended config
above) was simply run on them for review, using badge + basket positions
from the production detector (`scripts/detect-course.ts`) exactly as at
inference time.

| Course | Gate-passed | Total holes | Consistency violations (of gate-passed) |
|---|---|---|---|
| HeritagePark-Main | 0 | 18 | 0 |
| NorthPark-ShortTees | 1 | 18 | **1** |
| TowneLake-RedTees-a | 0 | 18 | 0 |
| TowneLake-RedTees-b | 0 | 16 (2 holes had no detected basket) | 0 |

**Why gate-passes are near zero here, and why that's expected, not a
regression**: these captures are UDisc app screenshots -- the course is
shown via UDisc's own pin-drop markers on an Apple Maps satellite basemap.
There is no rendered "hollow oval tee-pad" symbol anywhere in these images
(that symbol is specific to ChainSpot's own map style, which is what the
synthetic template in stage 2 models and what both labeled fixtures show).
The diagnostic overlays (`*-diagnostic-overlay.png`) show the chain
correctly finding *nothing* template-shaped along most rays and rejecting
essentially everything -- exactly the conservative behavior the zero-false-
accept gate is supposed to produce on out-of-domain input, rather than
confidently guessing wrong. This is a domain-mismatch observation, not a
generalization failure of the tuned parameters.

**The one gate-pass is instructive**: NorthPark-ShortTees hole 14 passed
the NCC gate (0.67) but was flagged by the **ribbon-evidence consistency
check** -- stage-1 evidence at the recovered point is exactly 0.0, i.e. it
does not sit on any fairway-ribbon-like brightness at all. Visually
(`NorthPark-ShortTees-overlay.png`), the recovered point lands on open
terrain well away from hole 14's actual tee pin. This is precisely the
scenario the two consistency checks exist to catch: an NCC score alone can
be fooled by incidental structure (a driveway corner, a path edge) that
happens to resemble the pad template, and the independent ribbon/badge-aim
checks catch what the gate alone did not. **Recommendation**: on
out-of-domain input, gate-passed recoveries should still be confirmed
against the consistency checks before being trusted, not just against the
NCC gate.

### Consistency checks (definitions)

1. **Ribbon evidence**: is stage-1's opened evidence map (the same signal
   the ribbon-ray fit itself reads) above `evidence_thresh` at the recovered
   tee's pixel location? A gate-passed tee that isn't standing on ribbon-like
   evidence is suspicious regardless of its NCC score.
2. **Badge-aim invariant**: did the chosen ray bearing land away from both
   the stage-1 bearing-sweep boundary (±28°) and the stage-2 bearing-refine
   boundary (±4°)? A recovery that only "works" by saturating the search
   window at its edge is a sign the true local ribbon direction wasn't
   found, not that it was.

Both are implemented in `grayt_tune.consistency_checks()` and run
automatically on every overlay-only course.

## Deliverables

- `hole_path_tee_recovery.py` / `ray_template_fusion.py`: parameterized
  (`Stage1Params` / `Stage2Params` + CLI flags), defaults unchanged,
  verified byte-identical output to the pre-tuning hardcoded versions.
- `grayt_common.py`: course discovery (tunable `.chainspot.zip` vs
  overlay-only bare image) + cached `detect-course.ts` badge/basket
  detection.
- `grayt_tune.py`: the LOOCV search driver used to produce this report.
- `best-params.json`: recommended config (see above), plus the raw
  grid-search argmax for reference (not recommended).
- `hole-path-results/tuning/`: overlays for every course --
  `{course}-tuned-overlay.png` for the 2 labeled courses (truth shown in
  green, recovered in green/red by gate-pass), `{course}-overlay.png` /
  `{course}-diagnostic-overlay.png` for the 4 overlay-only courses (main =
  gate-passed only, diagnostic = every candidate including rejects),
  `grayt-tune-raw-results.json` / `final-chosen-results.json` for full
  per-hole machine-readable detail, `badge-cache/` for the cached detector
  output (keyed by file path/mtime/size, so re-running the search doesn't
  re-pay the ~15-20s/course detector cost).

## Limitations

- **N=2 labeled courses.** This is the dominant limitation of this whole
  exercise -- LOOCV with 2 folds tells you a great deal about whether a
  choice overfits to *one specific course's* idiosyncrasies (and it did,
  for the gate threshold), but very little about whether a choice
  generalizes to a *third, structurally different* course. Every
  "generalizes" claim above should be read as "survived the one adversarial
  test available," not "proven."
- Stage-1 params other than `evidence_thresh`/`closing_window_px`, and
  stage-2 params other than `rim_fraction`, were not grid-searched (held at
  default) to keep runtime bounded at this sample size. They're exposed as
  CLI flags for a future pass with more labeled data.
- The overlay-only courses are a different visual domain (UDisc app
  screenshots) from the labeled fixtures (ChainSpot map captures), so their
  near-zero gate-pass rate, while expected and arguably reassuring
  (zero-false-accept held even out-of-domain), doesn't add cross-validation
  signal for the tuned parameters themselves.

## Addendum: manual vision pass on the 4 overlay-only courses

Follow-up requested by the user: inspect the overlay-only courses "using
your own vision and best judgement," with Sonnet subagents checking the
assessment. This section documents that pass. **It does not change
`best-params.json`** -- see why at the end.

### Method

The production detector (`scripts/detect-course.ts`) self-flags holes
where badge->basket ownership is uncertain (`ambiguous-basket` /
`weak-basket-confidence`). Across the 4 courses, 10 of 72 holes were
flagged: NorthPark-ShortTees {6, 8, 14}, HeritagePark-Main {2},
TowneLake-RedTees-a {2, 13}, TowneLake-RedTees-b {1, 2, 4, 14}. Rather than
re-deriving all 72 holes' truth from scratch, effort focused on these 10 --
exactly where a human/AI visual judgment call adds value over the
algorithm's own (self-admitted) uncertainty.

I personally reviewed NorthPark-ShortTees using zoomed, grid-overlaid crops
(50px grid, labeled every 100px, generated via a small crop helper script)
to read pixel positions against a ruler rather than free-hand estimate.
Three parallel Sonnet subagents then independently did the same for the
other three courses, using the same method, each also spot-checking 3-4
*non*-flagged holes per course as a trustworthiness check on the
detector's self-flagging. I did not show them my NorthPark conclusions
first, so their read is independent.

**Precision caveat**: reading pixel coordinates off a 50px grid by eye is
accurate to roughly ±20-50px (marker icons alone are ~40-60px), far coarser
than the 12.69px tolerance used throughout the rest of this report. This
pass is therefore categorical (is hole N's basket pin A or pin B? is a
pairing plausible or not?), not a source of new precise ground truth --
it does not attempt to produce numbers comparable to the LOOCV table above.

### Findings on the 10 flagged holes

| Course | Hole | Verdict | Note |
|---|---|---|---|
| NorthPark-ShortTees | 6 | **Genuinely ambiguous** | Badge sits in open fairway; no pin within ~400px even on a wide search. The detector's own pick isn't near any pin either. |
| NorthPark-ShortTees | 14 | **Genuinely ambiguous** | Same pattern -- nearest candidate pins are 330-350px away, no confident pick. |
| NorthPark-ShortTees | 8 | Low-confidence guess | Two pins sit in a tight 7/8 cluster; genuinely hard to disambiguate by eye. |
| HeritagePark-Main | 2 | **Retracted -- likely NOT wrong** | See correction below: the subagent's distance-only reasoning missed that the production cost function (distance + polarity penalty) makes the *actual* assignment the true global-cost optimum with near-perfect polarity, while the proposed swap scores worse on both dimensions. |
| TowneLake-RedTees-a | 2 | Confirmed correct | Detector's pick is unambiguously the closest pin; the flag looks like a soft cost-competition signal, not an error. |
| TowneLake-RedTees-a | 13 | Confirmed correct | Closest pin, though the tee->badge->basket geometry is nearly perpendicular (polarity cosine 0.12) -- a genuine oddity worth downstream scrutiny even though the pin choice itself is right. |
| TowneLake-RedTees-b | 1 | Confirmed correct | Closest remaining pin once hole 18's own (closer) pin is correctly excluded. |
| TowneLake-RedTees-b | 2 | **Corrected** | An unclaimed pin sits ~50-60px from badge 2. The detector's pick (708,1602) actually belongs to hole 5 (94px away) -- hijacked because hole 5's *own* tee resolution failed first, excluding hole 5 from the basket-matching pool entirely. |
| TowneLake-RedTees-b | 4 | **Genuinely ambiguous** | Badge isolated in open fairway out to 600px; the detector's pick is closer to holes 5 and 11 than to hole 4. |
| TowneLake-RedTees-b | 14 | **Genuinely ambiguous** | A real tie: one candidate pin is 132px away (the detector's pick, currently assigned), another is 80px away but already claimed by hole 15 -- both are defensible, dense-cluster genuine tie. |

**Net (revised after the correctness check below)**: 3 confirmed correct
despite being flagged, 1 corrected (TowneLake-b hole 2, still holds up), 1
retracted (HeritagePark hole 2 -- see below, the subagent's proposed
"correction" turned out to itself be wrong), 4 genuinely ambiguous (no
confident call possible even under careful inspection), 1 low-confidence
guess.

**Retraction: the HeritagePark hole 2 "correction" does not hold up.** The
subagent that reviewed HeritagePark reasoned from raw pixel distance only
-- it never checked the production ownership algorithm's actual cost
function (distance + an 80px penalty when the tee and basket fall on the
same side of the badge, i.e. `raysPolarityCosine`; see
`src/lib/autoAnnotation/courseGrammar.ts`). Recomputing that cost function
by hand for both holes:

| | hole 2 → pin A (1022,1411) | hole 4 → pin B (905,1453) | total |
|---|---|---|---|
| **Actual (production) assignment** | cost 140.2, polarity **-1.000** | cost 89.3, polarity **-1.000** | **229.5** |
| **Subagent's proposed swap** | cost 113.2, polarity -0.463 | cost 190.3, polarity -0.687 | **303.5** |

The production assignment is the true global-cost optimum under its own
cost function *and* gives near-perfect polarity (tee and basket exactly
opposite the badge) for both holes, while the swap is worse on every
dimension for both holes. The subagent's "hole 2 loses its closer pin to
hole 4" framing was true but not evidence of an error -- global one-to-one
assignment routinely gives a hole its second-best option when that's what
minimizes total cost across all holes simultaneously. This is retracted;
treat that row as **not corrected**.

Worth noting for calibration: the underlying claim "tee → badge → basket
forms a roughly straight line" should not be read as a strong geometric
law -- it degrades on any hole with a bend near the badge, and a check that
found "0/36 violations" against the two labeled fixtures mostly confirms
badges sit close to their tee (true almost by construction of how badges
get placed) rather than validating the straight-line framing in general.
It happens to hold up on these two courses; that is not a proof it holds
on a course with sharper doglegs.

**TowneLake-b hole 2 holds up.** Same cost-function check: the detector's
actual pick costs 536.5 (distance 466px, polarity -0.12 -- barely opposite
at all), the proposed pin costs 90.3 (distance 49px, polarity -0.48). That
gap is far too large to be a global-cost tradeoff with some other hole; the
proposed pin is a real improvement under the algorithm's own logic. Whether
this is an ownership-assignment bug (the candidate existed and was
mis-priced or claimed elsewhere) or the candidate was simply never in the
detected pool at all (an upstream detection gap, not an ownership bug) is
not yet determined.

**A previously-undetected root cause (still holds)**: TowneLake-RedTees-b
holes 5 and 10 lost their true basket to neighboring holes 2 and 9
respectively, not because of proximity ambiguity, but because holes 5 and
10's *own* tee bootstrap failed first, which excludes a hole from the
basket-matching pool entirely -- so its rightful basket becomes fair game
for a neighbor. This is a concrete, reproducible failure mode (tee-
resolution failure cascading into a neighbor's basket mis-assignment)
worth a production fix, though that fix is out of scope here (`src/` was
not touched, per the task's boundary).

### Does correcting the basket anchor rescue the gate-pass rate?

Applying the corrections and re-running the full chain on those holes
(HeritagePark hole 2 kept here for the record even though the "correction"
is retracted above -- and note the NCC got *worse* with the retracted
"correction," which is itself consistent with that basket having been
wrong to swap to):

| Hole | NCC before (detector's basket) | NCC after (proposed basket) |
|---|---|---|
| HeritagePark-Main hole 2 (retracted correction) | 0.457 | 0.289 (worse, consistent with the retraction) |
| TowneLake-RedTees-b hole 2 | 0.443 | 0.440 (unchanged) |

**Neither crosses the 0.55 gate, and one gets worse.** This is itself an
informative result: it confirms the *dominant* explanation for the
near-zero gate-pass rate across these 4 courses is the domain mismatch
already reported above (no rendered tee-pad symbol for the template to
match), not primarily basket mis-assignment. Basket-ownership correction
matters for getting the search corridor's *direction* right, but on this
image domain there is usually nothing pad-shaped for stage 2 to lock onto
regardless of anchor quality -- so it doesn't by itself convert a rejection
into a confident, correct gate-pass.

### Why this doesn't change `best-params.json`

This pass diagnoses a *production basket-detection* issue (ownership
assignment in dense clusters, and a tee-failure-cascade bug) and confirms
the *image-domain-mismatch* explanation for the overlay-only courses'
low pass rate -- neither is a GRayT stage-1/stage-2 parameter question, and
neither comes with pixel-precise, sub-13px truth the way the two labeled
fixtures do (see the precision caveat above). Feeding ±20-50px
hand-corrected anchors into the LOOCV objective would silently lower the
quality bar for every future number in this report without a clear
disclosure boundary, which is exactly what the task's hard rule about
honest truth-provenance is meant to prevent. The value of this pass is the
two concrete findings above (both worth a production follow-up), not a new
parameter recommendation.

## Addendum 2: ribbon-width as a stage-1 discriminator (in progress)

Mid-session design discussion surfaced that the current bearing-seed
(corridor hill-climb fit to a pre-supplied basket, reversed) adds real,
avoidable noise -- mean 8.6°/3.9° error vs. true badge->tee bearing on
Golden/Alex respectively, up to 26.9° on one hole -- and that `RAY_SWEEP_DEG
= 28.0` has no documented derivation and sits suspiciously close to the
minimum width that specific hole needs to pass (single commit, never
tuned since).

Two badge-local, basket-independent replacement ideas were tested and both
performed *worse* than the current approach:
- Full 360° "farthest sustained point-evidence wins" sweep: mean
  80.0°/66.6° bearing error (worse than the corridor-fit baseline) --
  grabs unrelated bright terrain (the same road/parking confuser already
  documented) with no prior to constrain it.
- Full 360° pad-template NCC search in an 80px radius around the badge:
  mean 105.9px/125.7px position error, within13 4/18 and 0/18 -- far
  worse than either stage-1 or stage-2's existing gated results. Free
  rotation search matches incidental noise, not real pads.

A third idea -- **perpendicular ribbon width as a discriminator** -- tested
positive and is a real, quantified signal, not yet implemented:
measuring the evidence map's perpendicular extent (not just point
brightness) every 15px along a ray, real (truth) tee-ward/basket-ward rays
across all 36 labeled holes hold width in the **~24-90px range** (flagged
here for review -- this is the number a width-based filter would be tuned
around, and it should be checked against more courses before being treated
as load-bearing) with a **0.19 mean dropout rate** (fraction of samples
where the ribbon evidence disappears entirely), vs. **0.66** for random
wrong-direction rays (>=30° off both true rays). Width *consistency*
(coefficient of variation) did not discriminate (0.37 vs 0.32-0.34) --
the real signal is "ribbon doesn't disappear," not "constant width" per
se. An implementation of this as a stage-1 ranking/filter mode is in
progress; results will be added here once tested against the same 36-hole
seeding-accuracy check and the full LOOCV protocol above.
