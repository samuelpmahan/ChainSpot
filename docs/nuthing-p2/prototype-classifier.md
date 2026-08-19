# NuThing P2 prototype-matcher digit classifier

Prototype (nearest-class-mean) classifiers over compact spatial-occupancy feature vectors (`src/lib/nuthing/digits/features.ts`), testing the hypothesis that a digit is recognizable largely from *where* its bright (stroke) pixels occur rather than needing the full pixel grid. Classifier: `src/lib/nuthing/digits/prototype.ts` (per-class mean of training vectors, scored by negative Euclidean distance or cosine similarity). Driver: `scripts/nuthing/train-prototype.ts`.

Model selection is by LEAVE-ONE-IMAGE-OUT (LOIO) cross-validation on the 194 labeled `split=="train"` samples ONLY -- an image is the natural correlation unit (every digit on one badge/course shares lighting, camera angle, and font rendering), so folds hold out whole source images (11 distinct images), never individual digits. `split=="heldout"` (Fountain Hills) is never used for selection or training here -- per this doc's scope, only the shared evaluator (`scripts/nuthing/eval-digits.ts`) scores heldout, for the record.

## LOIO selection table (feature set x metric)

| feature set | dims | metric | LOIO accuracy |
| --- | --- | --- | --- |
| topology4 | 4 | cosine | 70.1% (136/194) |
| topology4 | 4 | euclidean | 96.4% (187/194) |
| colProjection24 | 24 | cosine | 100.0% (194/194) |
| colProjection24 **(winner)** | 24 | euclidean | 100.0% (194/194) |
| rowProjection32 | 32 | cosine | 100.0% (194/194) |
| rowProjection32 | 32 | euclidean | 100.0% (194/194) |
| occupancy6x8 | 48 | cosine | 100.0% (194/194) |
| occupancy6x8 | 48 | euclidean | 100.0% (194/194) |
| occupancy8x10 | 80 | cosine | 100.0% (194/194) |
| occupancy8x10 | 80 | euclidean | 100.0% (194/194) |
| multiscale | 240 | cosine | 100.0% (194/194) |
| multiscale | 240 | euclidean | 100.0% (194/194) |
| fullMask768 | 768 | cosine | 100.0% (194/194) |
| fullMask768 | 768 | euclidean | 100.0% (194/194) |

## Winner

**colProjection24 / euclidean**, LOIO accuracy 100.0% (194/194) (dims=24). Selected by highest pooled LOIO accuracy across the 11 held-out image folds; ties broken toward fewer dimensions.

## Model size

24 dimensions x 10 classes = 240 floats per prototype matrix (plus 10 class labels and a metric tag). Serialized JSON: `resources/nuthing-p2/digits/models/prototype.json` and `resources/nuthing-p2/digits/models/prototype-synth.json` (identical shape).

## Runtime

Warm median inference time: **0.00052 ms/sample** (median over 60 timed passes across all 283 dataset samples, after 10 warmup passes, single-threaded Node). Scoring one sample is a 10-prototype euclidean distance comparison over a 24-dim vector -- linear in dims x classes, no search or iteration, so this is representative of steady-state cost.

## Synthetic augmentation

`/workspace/nuthing-work/digits/synthetic-dataset.json` was present (2500 samples) at run time. Second variant trained on train-real (194) + synthetic (2500) samples, same winning feature set / metric. Both variants use the same winning (feature set, metric); the synthetic-augmented variant is a second candidate for the shared evaluator to compare against the train-only variant, not a replacement for it -- this doc does not itself declare a winner between them (see the non-goal note below).

## Why so many feature sets tie at ~100% LOIO

The labeled train split has only 33 distinct mask bitmaps across 194 samples (per-class distinct-mask counts: 0=3, 1=4, 2=1, 3=3, 4=3, 5=3, 6=6, 7=3, 8=4, 9=3). UDisc renders each digit value from a fixed bitmap font at a fixed size, so the same digit crop recurs near-identically across different source images/courses -- e.g. class "2" has just 1 distinct mask across 11 samples on 6 different images. That near-duplication is exactly why LOIO (holding out a whole image) still lets a spatially-rich feature set reconstruct an almost-exact match from the other 10 images' prototypes: the held-out image's digits were effectively already "seen" in pixel-identical or near-identical form elsewhere in train. This is a genuine property of this corpus, not a leak in the LOIO split (each fold still excludes every sample belonging to the held-out image). It does mean near-100% train-side LOIO should NOT be read as a heldout-accuracy prediction -- Fountain Hills (`split=="heldout"`) may differ in camera angle, resolution, or JPEG compression in ways this train corpus's low bitmap diversity does not exercise; that is exactly what the shared evaluator's heldout score is for. `topology4` (position-blind, only 4 dims) is the one feature set that still makes real LOIO errors (96.4% (187/194) euclidean) -- it discards exactly the positional signal the winning feature sets rely on, which is itself evidence that *location* of ink, not just its topology, is carrying the discriminative signal here.

## Notable LOIO confusions (winner)

No misclassifications in LOIO for the winning (feature set, metric).

For contrast, `topology4 / euclidean` (the one feature set with real LOIO errors):

- true 6 -> 9×6
- true 9 -> 6×1

**Note:** heldout (Fountain Hills) accuracy is deliberately NOT reported here. The shared evaluator (`scripts/nuthing/eval-digits.ts`) scores every classifier family against heldout for the record; this doc is the train-side feature study only.
