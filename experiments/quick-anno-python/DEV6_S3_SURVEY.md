# S3 across Dev6 — what the family vote is actually doing

The S3 checkpoint reported three Apple Maps chrome glyphs accepted as Tee
objects on Dash's Track. That was a one-course claim. Running the same
investigation across all six Dev6 courses turns it into a different and
sharper one.

`packages/alg/src/stages/` holds S0-S3 and no S4, so breadth is the only
direction the transfer pattern can still go.

## Reproduce

```sh
python -m pip install -e packages/quick_anno_py
npm run build --workspace @chainspot/alg
for c in DashsTrack Lenard TowneLake NorthPark HeritagePark AlexClark; do
  python experiments/quick-anno-python/s3.py \
    "$(ls ../chainspot-corpus/dev/*/${c}-full.* | head -1)"
done
```

Course identity comes from the filename stem, not the directory: the corpus
has `dev/Heritage/HeritagePark-full.png`, and extensions vary in kind and case
(`.jpg`, `.png`, `.PNG`).

## The ledger balances on every course

```text
COURSE          encl  diam elong bMute  cand  meas  unfr voted  tees  teePx
DashsTrack        32     5    27     3    24    20     4     2    18   4884
Lenard            37     5    32     3    29    23     6     6    17   2516
TowneLake         36     7    29     3    26    22     4     5    17   2498
NorthPark         31     5    26     3    23    20     3     4    16   2562
HeritagePark      37     5    32     3    29    18    11     4    14   1799
AlexClark         29     6    23     3    20    17     3     3    14   3111
```

`balanced: true` on all six — every enclosed ring leaves through exactly one
named door. Note `bMute` is **3 on all six courses**; that regularity is
unexplained and is flagged below rather than explained away.

## What the identity crops show

Judged from `s3-tee-crops.png` and `s3-voted-out-crops.png` per course, at
full resolution. Chrome is legible as letterforms — `SAT`, `MAP`, `Maps`,
`aps` — not inferred from position.

| Course | Tee objects | chrome ACCEPTED (false +) | voted out | of which real pads (false −) |
|---|---|---|---|---|
| DashsTrack | 18 | **3** — `SAT`, `aps`, `Map` | 2 | **1** — basket-occluded pad |
| Lenard | 17 | 0 | 6 | 0 — 2 swimming pools, 4 chrome |
| TowneLake | 17 | 0 | 5 | 0 — 2 built terrain, 3 chrome |
| NorthPark | 16 | 0 | 4 | 0 — 1 terrain, 3 chrome |
| HeritagePark | 14 | 0 | 4 | 0 — 2 rooftop/driveway, 2 chrome |
| AlexClark | 14 | **1** — `Map` | 3 | **1** — basket-adjacent pad |

## The actual finding

**Apple Maps chrome produces ring-plus-frame candidates that survive to
`measured` on all six courses.** Every course has `SAT` / `MAP` / `Maps`
glyphs sitting in either its accepted set or its voted-out set. The candidates
are universal; only their fate differs.

**The family size vote is the only thing filtering them, and it is a size
filter standing in for an identity filter.** It has no notion of chrome, of
occluders, or of what a tee is. It asks one question — is this frame's
major/minor/area within log-ratio 1.25/1.25/1.5 of a common family — and
chrome answers it correctly often enough to be excluded on four courses and
incorrectly on two.

Because it is the wrong kind of filter, it errs in **both** directions on the
same two courses:

- **False positives:** 4 chrome glyphs accepted as Tee objects (DashsTrack 3,
  AlexClark 1). On DashsTrack that produces 18 Tee objects on an 18-hole
  course, a number that looks like success and is not.
- **False negatives:** 2 real tee pads rejected (DashsTrack, AlexClark), both
  by the same mechanism — a basket sprite overlaps the pad, the visible area
  shrinks, and the area ratio drops it. DashsTrack's: frame `[409,1748,22,33]`,
  area 171 vs anchor 276 = 1.61 > `AREA_RATIO` 1.5, while its major axis
  (32.2) is *larger* than the anchor's (30.9).

It also does useful work nobody designed it to do: on Lenard it rejected two
**swimming pools**, on HeritagePark two rooftop/driveway rectangles, on
TowneLake and NorthPark built terrain. Bright quadrilaterals are common in
aerial imagery. The size vote is currently the corpus's whole defense against
them.

The two courses where it fails in both directions, DashsTrack and AlexClark,
are the two `.jpg` captures; the four where it holds are `.png`. That
correlation is **noted, not explained** — file format is a proxy for how the
screenshot was captured and cropped, and this survey did not establish the
mechanism. AlexClark is already on record as the course `screenChrome.ts` was
tuned against.

## What this does not say

- It does not say how many holes each course *should* find at S3. Recovery is
  `NOT RUN` at this stage; a count below 18 is expected, not a defect.
- It does not classify which hole loses its tee in the two false-negative
  cases. That needs badge-ray adjudication this lane does not run.
- It does not propose a fix. No threshold was moved, no selector edited,
  nothing registered into `S3_PLAN`. This lane proves the investigation
  pattern; the algorithm is the owner's call.
- The constant `excludedByBadge: 3` across six different courses is a
  regularity with no offered explanation. Six coincidences would be
  surprising; it is recorded as an open question, not smoothed over.

## Why the crops were necessary

Every one of these calls came from the per-object identity crop panels, and
none of them is visible in the course-zoom panels that preceded them. The
full-course views agreed with the receipt on all six courses. A count that
matches expectation is not evidence, and a bounding box is not an identity.
