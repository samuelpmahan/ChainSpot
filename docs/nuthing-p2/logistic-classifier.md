# Logistic regression digit classifier

Tiny interpretable multinomial logistic regression for NuThing P2 hole-number
digit recognition: `P(d = k) = softmax(W x + b)`, where `x` is the 768-dim
(24x32) binary pixel vector of a normalized digit mask
(`src/lib/nuthing/digits/normalize.ts`) and `k` ranges over the ten digit
classes `'0'..'9'`. Browser inference is exactly one 10x768 matrix multiply,
a bias add, and a softmax.

Implementation: `src/lib/nuthing/digits/logistic.ts` (pure TS, no
dependencies). Training driver: `scripts/nuthing/train-logistic.ts`.
Coefficient visualizations: `scripts/nuthing/visualize-logistic.ts`. Unit
tests: `tests/unit/nuthingLogistic.test.ts`.

This document does not report heldout accuracy — the shared evaluator
(`scripts/nuthing/eval-digits.ts`) is the single place that number comes
from, so every classifier is compared on equal footing there.

## Feature representation

One 0/1 feature per pixel of the canonical 24x32 normalized mask (768
features), plus a bias term per class. No hand-engineered features — this
keeps `W` directly, spatially visualizable: `W[k][j]` is "how much pixel `j`,
at its 24x32 spatial position, pushes evidence toward digit `k`."

## Training procedure (deterministic, no RNG)

Full-batch gradient descent on the L2-regularized weighted multinomial
softmax cross-entropy loss:

```
L(W, b) = (1 / sum(weight)) * sum_i weight_i * CE(softmax(W x_i + b), y_i)
          + (lambda / 2) * ||W||_2^2
```

- **Initialization**: `W` and `b` start at exactly zero.
- **Learning rate schedule** (fixed, inverse-time decay):
  `lr_t = LEARNING_RATE_INITIAL / (1 + LEARNING_RATE_DECAY * t)`, with
  `LEARNING_RATE_INITIAL = 3.0`, `LEARNING_RATE_DECAY = 0.004`.
- **Iterations**: `DEFAULT_ITERATIONS = 800` (fixed; chosen empirically as
  the point past which weighted training cross-entropy stops improving by
  more than 1e-5 per 100 iterations, across every lambda in the grid below).
- **Regularization**: L2 on `W` only — `b` is never regularized.
- **No RNG anywhere** in the module or the training script: every sample
  contributes to every full-batch update (no minibatching or shuffling), so
  there is no ordering nondeterminism either. `tests/unit/nuthingLogistic.test.ts`
  asserts two independent training calls on identical input produce
  bit-identical `W` and `b`.

### Class weighting

The labeled train split is heavily imbalanced (class `'1'` is 82 of 194
samples — ~42%). Every sample is weighted by `1 / classCount[label]`,
rescaled so the weights average 1 across the training set
(`classBalanceWeights()` in `logistic.ts`). This makes every digit class
contribute equally to the gradient regardless of how often it appears. For
the real+synthetic variant, weights are recomputed over the **combined**
set so the balancing accounts for however the class's samples split
between real and synthetic provenance (`buildTrainSamples()` in
`train-logistic.ts`).

## Lambda selection: leave-one-image-out (LOIO) cross-validation

Lambda is chosen once, by LOIO CV over the **labeled train split only**
(never heldout, never synthetic), then reused for both final variants so
they're comparable classifiers rather than a lambda sweep vs. a fixed
value. Grouping is by image (11 distinct images across 194 train samples,
4–27 samples each) — every fold excludes **all** samples belonging to one
held-out image, not just one sample, so a badge's other digits can't leak
into its own fold.

Grid: `1e-4, 1e-3, 1e-2, 1e-1` (as specified). Tie-break: highest LOIO
accuracy wins; ties are broken toward the **larger** lambda (stronger
regularization — simpler, more spatially-smooth `W` — preferred when it
costs nothing in cross-validated accuracy).

| lambda | LOIO accuracy | folds |
|---|---|---|
| 1e-4 | 100.00% | 11 |
| 1e-3 | 100.00% | 11 |
| 1e-2 | 100.00% | 11 |
| 1e-1 | 93.30% | 11 |

**Chosen lambda: `0.01`** (largest of the three tied-at-100% values).

Three points on the grid tying at 100% LOIO accuracy is a real property of
this corpus, not a bug in the CV: UDisc renders every digit from a fixed
bitmap font at a fixed size, so the same digit crop recurs near-identically
across different source images/courses. With 768 spatially-rich features
and only ~176 samples per fold, a linear model has more than enough
capacity to reconstruct an almost-exact match to a held-out image's digits
from the other 10 images' near-duplicate examples — that's a genuine
property of the train corpus's low bitmap diversity, not a leak (each fold
still excludes every sample belonging to the held-out image). It also means
this train-side LOIO number should **not** be read as a heldout-accuracy
prediction: Fountain Hills (`split == "heldout"`) may differ in camera
angle, resolution, or JPEG compression in ways this train corpus doesn't
exercise — which is exactly what the shared evaluator's heldout score
exists to check, separately from this document.

## Model artifacts

Both variants are trained with the same `lambda = 0.01`, `iters = 800`.

| variant | trained on | model file | file size |
|---|---|---|---|
| 1 (real) | 194 labeled train samples | `resources/nuthing-p2/digits/models/logistic.json` | 151,330 bytes |
| 2 (real+synth) | 194 real + 2,500 synthetic | `resources/nuthing-p2/digits/models/logistic-synth.json` | 162,061 bytes |

**Parameter count**: `10 classes * 768 features + 10 biases = 7,690` scalar
parameters. As packed 32-bit floats that's `7,690 * 4 bytes ≈ 30 KB` — the
"~30KB" figure this experiment targeted. The committed model files are
serialized as ordinary JSON with full float64 precision (no rounding, to
preserve exact reproducibility), which averages ~19–20 characters per
number in text form; that's why the on-disk JSON is ~150–160 KB rather than
~30 KB. A production build could trivially shrink this ~5x by rounding to
6 significant digits or packing `W`/`b` into a base64 `Float32Array`
without changing a single prediction.

## Runtime

Warm median inference (after a 50-call JIT warmup, timed per-sample over
all 283 dataset samples, `performance.now()`, Node/tsx):

- Variant 1 (real): **~0.0114 ms/sample**
- Variant 2 (real+synth): **~0.0113 ms/sample**

Both are effectively identical, as expected — inference cost is the same
10x768 matrix multiply regardless of what data trained it. At this rate a
whole 18-hole badge (up to ~3 digits/hole, 18 holes) is on the order of
0.6 ms of classifier time in the browser.

Training wall time (this machine, `tsx`, includes the 44-run LOIO grid
search): variant 1 ~4.1s; variant 2 (2,694 samples) ~55s.

## Spatial-coefficient commentary

See `docs/nuthing-p2/logistic-coefficients.md` for the full ASCII maps (all
10 classes) and `resources/nuthing-p2/digits/logistic-coefficients.png` for
the color-coded grid (red = negative weight, green = positive weight,
intensity = `|w|` normalized per class). All coordinates below are
`(x, y)` in the 24-wide x 32-tall normalized mask, `y` increasing downward.

- **'3' vs '8'** (the strongest single opposing pair in the grid): the
  largest-magnitude differences are at `x=11-12, y=12-13` — the vertical
  midline around mid-height. `W['3']` is strongly positive there while
  `W['8']` is strongly negative: a `'3'` is open on the left through the
  middle (no stroke connects its two lobes), while an `'8'` has ink there
  from the stroke joining its top and bottom loops. Ink in that one
  mid-column cell is close to a single discriminating bit between the two.

- **'1' vs '7'**: `'1'`'s positive region includes `x=6-7, y=5` (upper
  area) and a strong band at `x=12, y=27-30` — the exact bottom-center
  column. `'7'`'s stroke, by contrast, is diagonal near the bottom (it
  angles left as it descends), so it vacates that bottom-center column;
  `W['1']` picks that column up as strong positive evidence specifically
  because `'7'` reliably leaves it empty at the very bottom of the glyph.

- **'0' vs '8'**: differences concentrate at `x=6-7, y=12` and `x=6-7,
  y=17-19` — the left side at upper-middle and lower-middle height, both
  favoring `'8'`. An `'8'`'s left stroke is present at both loop
  midpoints; a `'0'`'s single oval has a comparatively thinner/lighter left
  edge at those same rows in this font, so presence of ink there is more
  informative for `'8'` than the fact of *any* closed loop (which both
  share) is for `'0'`.

- **'5' vs '6'**: differences concentrate at `x=17, y=12-13` (mid-right)
  and `x=19-20, y=3-5` (upper-right), both favoring `'6'`. A `'6'`'s upper
  stroke curls further right and its lower loop's right edge sits further
  right than a `'5'`'s; ink in that right-of-center band at upper and
  middle height is what tips the classifier toward `'6'`.

These are exactly the kind of "these cells made it think 3 instead of 8"
answers the coefficient maps are meant to give a human debugging a specific
misread — walk to the corresponding tile in
`logistic-coefficients.png`/`.md`, find the predicted digit's positive
(green) region, and check whether the actual mask has ink there.
