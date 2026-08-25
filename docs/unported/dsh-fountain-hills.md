# dsh-fountain-hills — MiddleOut paired-edge pathfinding probe

## Source

Old lineage only: `C:/Users/tenni/workspace/ChainSpot`, branch `dsh/fountain-hills-pro-20260818`.
Three commits, all **committed** (nothing dirty; the working tree has no leftovers from this work).

| sha | date | subject | files |
|---|---|---|---|
| `382870d` | 2026-08-17 | add MiddleOut paired-edge pathfinding probe | `scripts/cv-probes/middleout/middleout.py` (282 lines) |
| `34538e6` | 2026-08-17 | add MiddleOut dev corpus runner | `scripts/cv-probes/middleout/run_dev_corpus.py` (332 lines) |
| `019089f` | 2026-08-18 | experiment: probe Fountain Hills middle-out failures | `.task/CHSPT-58.md`, `scripts/cv-probes/middleout/run_fountain_hills.py`, `scripts/cv-probes/middleout/fetch_wheels.mjs`, `.gitignore` |

Configured upstream was `origin/experiment/vision-middleout-pathfinding`. **That remote branch no longer
exists** — `git branch -r` has no ref matching `middleout` or `vision-middle`. So all three commits are
unpushed and this local branch is their only copy. Per `.task/CHSPT-58.md` the branch base was `34538e6`,
meaning `382870d` and `34538e6` were themselves never pushed either — the whole probe lineage is orphaned.

Nothing under `src/` was touched. This never entered production. The task file names it explicitly as a
sandboxed experiment with "no push, deploy, Linear/GitHub comments, or any external write."

## What it detects

Three separable pieces:

1. **Badge bodies** (`detect_badges`) — a Python re-implementation of the physical hole-number-badge stage
   from production `holeNumberDetection.ts`. It finds dark blobs, keeps ones with badge-like width/height/
   aspect/solidity, then picks the largest group of blobs that are all roughly the same size as each other
   (a course draws all its hole badges at one size, so the repeated size is the signal). It does not read
   the digit — it only locates the badge body.
2. **Ribbon evidence** (`paired_bandness`) — a per-pixel score for "am I in the middle of a stripe?" A pixel
   scores high when there are two roughly parallel edges on either side of it, separated by a plausible
   fairway-ribbon width, whose color changes across the edge point the same direction on both sides. Plain
   gloss: a ribbon has two banks; if both banks step from the same inside color to the same outside color,
   you are between them. Deliberately makes **no assumption about the ribbon's actual color or alpha**,
   which is the whole point — UDisc composites overlay strokes source-over onto satellite imagery, so the
   rendered color is never constant.
3. **Middle-out routing** (`middleout_path`) — given a tee point, a badge point, and a basket point, it
   routes two *independent* shortest paths outward from the badge: badge→tee and badge→basket, then
   stitches them. The badge sits on the corridor, so starting from the middle avoids committing to one
   long path that has to be right end-to-end. Cost is low where ribbon evidence is high, so the route
   prefers to follow the fairway rather than cut straight.

`run_dev_corpus.py` evaluates this against four annotated 18-hole courses (DashsTrack, Heritage, Lenard,
TowneLake). `run_fountain_hills.py` is the actual CHSPT-58 experiment: run the same machinery against four
unannotated Fountain Hills iPhone captures (1290×2796) and diagnose brightness/scale failures.

## Why it exists

Walk-path / corridor recovery was failing on captures whose overlay colors differ from the tuned corpus.
The stated hypothesis was that fixed-color and fixed-gray assumptions do not survive zoom and brightness
variation, so the probe replaces color matching with a **color-agnostic paired-edge** test. CHSPT-58 then
asked the harsher question: does any of it survive on a course nobody tuned against (Fountain Hills Pro,
20 holes, captured on a phone with iOS chrome top and bottom)?

## Signal and evidence

- **Badges**: BT.601 luma (`0.299R + 0.587G + 0.114B`, floored with `+0.5` to match production's integer
  rounding exactly), thresholded to a dark mask, 8-connected components with stats. Gates on bounding-box
  width, height, aspect, and fill ratio. Then a clustering pass: for each candidate as seed, collect all
  candidates within a log-size tolerance; keep the largest such cluster (ties broken by summed fill).
  Ranked by log-size distance from the cluster median, then fill, then y.
- **Ribbon**: image downscaled by `scale`, mild Gaussian blur, then for each of 12 orientations and each
  of 6 candidate half-widths, four sub-pixel `cv2.remap` shifts sample just-inside and just-outside on both
  banks. The score is `min(|d1|, |d2|) * clamp(cos(d1, d2), 0, 1)` where `d1`, `d2` are the RGB step vectors
  on each bank — magnitude of the *weaker* bank times how parallel the two color transitions are. Max over
  all orientations and widths. Normalized by the 99.5th percentile of nonzero response, gamma 0.7.
- **Routing**: `skimage.graph.route_through_array` (8-connected, geometric) on `1 + 4(1 - support)²`,
  inside a bounding box around the start/goal chord.
- **Fountain Hills scale probe**: `cv2.HoughCircles` on the map viewport, then a brute-force search over
  all candidate pairs for the pair whose radius ratio is closest to 2.0 with the closest-matching centers
  — using the hard prior that UDisc's Circle 1 (10 m) and Circle 2 (20 m) are concentric and exactly 2:1.
  The shared center is taken as the basket and `r1` gives meters-per-pixel.

## Thresholds and constants

Every number below is a dataset-fit estimate. Where the file gives no derivation I say UNKNOWN, loudly.

### `middleout.py` — `detect_badges`

| name | value | how derived | confidence |
|---|---|---|---|
| luma coefficients | 0.299 / 0.587 / 0.114, `floor(x + 0.5)` | BT.601, chosen to bit-match production `holeNumberDetection.ts` rounding | high (intentional mirror) |
| dark mask threshold | `gray <= 50` | copied from production; production's own derivation **UNKNOWN** | low — the probe's own sweep (40/50/60/70) exists precisely because this was suspect |
| width gate | `12 <= w <= 120` | **UNKNOWN** — mirrors production | low |
| height gate | `9 <= h <= 90` | **UNKNOWN** — mirrors production | low |
| aspect gate | `1.12 <= w/h <= 1.75` | **UNKNOWN** — mirrors production | low |
| fill gate | `area / (w*h) >= 0.55` | **UNKNOWN** — mirrors production | low |
| size cluster tolerance | `log(1.2)` (±20% in w and h) | **UNKNOWN** | low |
| `max_candidates` | 18 | assumes an 18-hole course; the four dev-corpus courses are all 18 holes | **known-wrong for Fountain Hills (20 holes)** — see Known failure cases |

### `middleout.py` — `paired_bandness`

| name | value | how derived | confidence |
|---|---|---|---|
| `scale` | 3 source px per evidence px | speed/resolution tradeoff, **UNKNOWN** why 3 | low (probe sweeps 2/3/4) |
| `widths_src` | 24, 32, 40, 48, 56, 64 source px | **UNKNOWN** — fit to dev-corpus zoom levels. The CHSPT-58 plan names this as the primary scale-failure suspect | low |
| `orientations` | 12 (15° steps over 180°) | **UNKNOWN** | low |
| pre-blur sigma | 0.8 px in x and y, 0 across channels | **UNKNOWN** | low |
| bank sampling offset `delta` | `max(1.0, 4.0 / scale)` — i.e. 4 source px | **UNKNOWN** | low |
| cosine epsilon | `1e-6` | numeric guard | high (not a tuned value) |
| normalization percentile | 99.5th of nonzero response | robust max; **UNKNOWN** why 99.5 | low |
| response gamma | `** 0.7` | **UNKNOWN** | low |

### `middleout.py` — cost and routing

| name | value | how derived | confidence |
|---|---|---|---|
| cost curve | `1.0 + 4.0 * (1 - support)²` | **UNKNOWN** — both the 4.0 weight and the square are unexplained | low |
| ROI `margin_fraction` | 0.60 of the straight-line chord | **UNKNOWN** | low |
| ROI margin floor | 30 evidence px (= 90 source px at scale 3) | **UNKNOWN** | low |
| endpoint relief disk radius | 6 evidence px (≈18 source px) | **UNKNOWN** — see the occlusion note below, the *intent* is documented but the size is not | low |
| endpoint relief cost floor | 1.4 (vs. 1.0 at perfect support) | **UNKNOWN** | low |

### `run_dev_corpus.py`

| name | value | how derived | confidence |
|---|---|---|---|
| crop tops | DashsTrack 0, Heritage 426, Lenard 426, TowneLake 528 | measured screenshot-chrome offsets per capture; crop only, no resize | high (these are facts about specific files) |
| badge→hole assignment cost | `path_distance + 0.02 * endpoint_distance` | **UNKNOWN** — the 0.02 is a tiebreak weight with no stated basis | low |
| `within_half_width` denominator | median `corridorWidthPx` / 2 from the annotation | a metric definition, not a tuned threshold | high |
| hard assertion | `len(badges) != 18` raises | assumes 18-hole corpus | see failures |

### `run_fountain_hills.py`

| name | value | how derived | confidence |
|---|---|---|---|
| viewport crop | rows 0.11H to 0.89H | measured iOS chrome bands on 1290×2796 captures | medium (correct for these captures, not general) |
| Hough params | `dp=1.2, minDist=10, param1=80, param2=20, minRadius=8, maxRadius=65` at 0.5 downscale | **UNKNOWN** — hand-tuned, and demonstrably wrong (3 of 4 captures gave false positives) | **very low — do not carry these forward** |
| circle-pair score | `abs(ratio - 2.0) + center_error / r2` | **UNKNOWN** | low |
| synthetic tee | `badge + 0.35 * (badge - basket)` | **fabricated**; the code labels the whole end-to-end block `"negative control only"` | **not a threshold — a placeholder. See failures.** |
| threshold sweep set | 40, 50, 60, 70 (+ 100, 128 for dark-fraction reporting) | one-variable sweep around the production default of 50 | high as a design, no recorded outcome |

## Gate placement

**None.** This never ran inside the G0–G5 pipeline. It lives entirely under `scripts/cv-probes/middleout/`
and is invoked by hand as a standalone Python program. It has no dependency on and no dependent in the
gate graph. Conceptually the piece it targets is corridor/walk-path recovery, which sits downstream of tee,
basket, and badge detection — so a rebuilt version would depend on whatever produces those three anchors.

**Naming collision worth knowing about:** `.task/CHSPT-58.md` numbers its *proof steps* P1–P9. In this
project `P1`, `P3`, `P6` elsewhere mean pipeline *phases* (see CHSPT-70's "wire 0-bend badge-on-chord
shortcut into P3/P6"). CHSPT-58's "P3 — Badge stage" and "P6 — end-to-end run" are proof steps, not phases.
Do not read them as pipeline references.

## Known failure cases

**The experiment's own conclusion is negative.** `run_fountain_hills.py` hard-codes its visual QA verdicts:

- `Fountain Hills-lazy.PNG` — "rejected: road/building texture false positive"
- `FountainHills-1.PNG` — "rejected: road/building texture false positive"
- `FountainHills-2.PNG` — "rejected: road-edge false positive"
- `FountainHills-full.PNG` — "accepted: overlay is centered on a rendered basket and its concentric rings"

and states in its generated interpretation that a near-perfect 2:1 radius ratio **was not sufficient** to
identify a basket, and that "no capture supplied a validated tee endpoint, so all saved paths are negative
controls rather than successful course recovery." One of four. That is the headline result.

**Negative-evidence landmines — flagging these explicitly per the trophy-basket rule:**

1. **The 18-badge cap manufactures false absences.** `detect_badges(max_candidates=18)` truncates the
   ranked list at 18. Fountain Hills Pro has 20 holes. Two holes therefore *cannot* receive a badge, and
   any downstream inspector asking "is there a badge for hole 19?" gets "no" — which is a cap artifact,
   not a detection result. The runner's own findings text says complete endpoint attribution is impossible
   without changing this. Anyone rebuilding must make the cap a function of hole count, or drop it.
2. **`run_dev_corpus.py` raises `RuntimeError` when `len(badges) != 18`.** A hard equality assertion, not
   a gate. It converts any recall shortfall into a crash rather than a measurement, and it silently bakes
   "all courses are 18 holes" into the harness.
3. **The synthetic tee is a fabricated anchor.** `tee = badge + 0.35 * (badge - basket)` invents a tee
   position from two other guesses. The code labels this a negative control, but the resulting overlay
   PNGs look exactly like successful path recoveries. **If those images ever escape their directory they
   are indistinguishable from real results.** They are not real results.
4. **Axis-aligned bounding boxes on non-rectangular sprites.** `detect_badges` gates on the bbox of a
   connected component. Here the `fill >= 0.55` gate happens to protect badge detection — a trophy-shaped
   basket sprite yields a square bbox with low fill and gets rejected. But nothing downstream re-derives
   a tighter shape, so the *stored* geometry for any accepted blob is still a square. Any later "does
   anything overlap this box?" test inherits the exact swallow-the-nearby-tee failure this project already
   knows about. Do not carry the bbox forward as if it were the sprite.

**Occlusion handling — this part was done right and should survive.** `route_leg` floors the cost inside a
small disk at each endpoint, with the docstring reason: "badges, tee frames, and basket sprites can erase
the ribbon-edge signal locally." That is the correct instinct — a sprite sitting on the corridor destroys
edge evidence there, and absence of evidence under a known occluder is not evidence of absence. The
*mechanism* is worth keeping; the radius (6) and floor (1.4) are UNKNOWN and should be re-derived.

**Other failure modes stated but never measured:**
- Brightness: the badge threshold sweep was designed but no outcome numbers survive.
- Scale: the plan says "if the measured corridor width lies outside 24–64 px, that is a documented scale
  failure." No measurement survives to say whether it did.

## What proves it works

**Nothing.** This is the decisive fact about this branch.

- No results directory was ever committed. `019089f` adds `scripts/cv-probes/middleout/fountain-hills-results/`
  to `.gitignore` — the runner writes `metrics.json`, `intake.tsv`, `FINDINGS.md`, and every overlay,
  badge, circle, support-heatmap and path PNG into a **gitignored** directory.
- That directory does not exist on disk. Neither does `.fountain-hills-input/` (also gitignored), so the
  four source captures are gone too. Nor `dev_middleout_output/`. Nor `.wheels/`.
- `run_dev_corpus.py` produces `dev_middleout_metrics.tsv` with median error, p90 error, and
  within-half-width per course. **No such file was ever committed and none exists on disk.** There is no
  recorded number anywhere for how well MiddleOut performed on the annotated corpus.

So: the evaluation machinery is real and reasonable, and zero of its output survives. Every quantitative
claim about this work would be unbacked. There are no evidence images.

`fetch_wheels.mjs` is a sandbox workaround (Node could reach PyPI, pip's TLS was blocked) that pins
cp311/win_amd64 wheels for offline install. It documents a machine, not an algorithm.

## Regeneration notes

**Must get right, if anything here is rebuilt:**

- The color-agnostic framing. `paired_bandness` scores `min(|step_left|, |step_right|) * clamp(cos, 0, 1)`
  — weaker-bank magnitude times bank-agreement. Using the *minimum* is what forces both banks to exist;
  using cosine on the RGB step vector is what avoids assuming the ribbon's rendered color. Those two
  choices are the idea. Everything else in that function is knobs.
- Middle-out from the badge as two independent legs, not one tee→basket path. Badges sit on the corridor,
  and independent legs mean a bad tee anchor cannot corrupt the basket leg.
- Explicit occlusion relief at endpoints where sprites destroy edge evidence.
- The strict separation the task file enforces: annotation bends are used **only** to score results and
  to attach a badge to a hole identity, never fed to the pathfinder. Preserve that discipline or the
  numbers mean nothing.

**Free to change — and should be:**

- Every threshold in the tables above marked UNKNOWN. All of them. None has a recorded derivation and
  none has a recorded outcome, so there is nothing to preserve compatibility with.
- The entire Hough-based circle/basket finder. It was 25% correct on the one dataset it was tried on.
- The 18-badge cap and the `!= 18` assertion. These are bugs dressed as constants.
- `fetch_wheels.mjs` and the `.gitignore` additions (`.dsh-git/`, `dsh-git.cmd`, `.dsh-pro-sessions/`,
  `.scratch-thumbs/`, `.dsh-pro-run*.log`) — machine-local shims for a sandbox that no longer exists.
- Python vs. TypeScript. The task file chose Python specifically to avoid port-equivalence risk against
  the existing probe stack. In the rebuild that reason is gone.

**Also worth carrying forward as prose, so the code need not be:** a near-perfect 2:1 concentric radius
ratio is *not* sufficient evidence of a basket. Roads, road edges, and building outlines in satellite
imagery generate 2:1 Hough pairs. Circle 1 / Circle 2 needs a corroborating signal.

## Verdict

**Partially worth it** — the paired-edge color-agnostic ribbon score, the middle-out two-leg routing, and
the endpoint occlusion relief are three ideas worth keeping, and this document now holds all three; the
Fountain Hills experiment itself is a negative result whose evidence has already been deleted, so the code
(`run_fountain_hills.py`, `fetch_wheels.mjs`, the `.gitignore` shims, every threshold in it) should be
discarded rather than ported.
