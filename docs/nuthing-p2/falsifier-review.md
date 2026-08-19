# NuThing P2 falsifier review

Adversarial review of the four headline claims on branch
`claude/nuthing-p2-digit-recognition-zgs4lq`. Method: decode every mask
byte-for-byte, re-derive every reported number from raw artifacts with
independent scripts (not by reading the docs' own arithmetic), and — where
feasible — **re-run the actual training/eval/end-to-end scripts from scratch**
to see whether the checked-in numbers reproduce or were hand-massaged.
Scripts used are under `/workspace/nuthing-work/falsifier/`. No commits were
made; the repo working tree was confirmed clean (`git status --porcelain`
empty) after every retrain.

## Verdicts

### Claim 1 — "Logistic regression achieves 100% digit (89/89) and badge (58/58) accuracy on the Fountain Hills held-out split, trained only on dev REAL_GROUNDED data."

**REFRAMED** (the number is real and reproducible; what it measures is much narrower than "held-out accuracy" implies).

I deleted nothing and re-ran `scripts/nuthing/train-logistic.ts` from scratch against the checked-in `resources/nuthing-p2/digits/digit-dataset.json`. The retrain reproduced `resources/nuthing-p2/digits/models/logistic.json` and `logistic-synth.json` **bit-for-bit identical** to the committed files (`git status --porcelain` was empty afterward — zero diff), and re-running `eval-digits.ts` on the fresh predictions reproduced digit 89/89 and badge 58/58 exactly. Code-read confirms no `split=="heldout"` sample ever enters `loadRealExamples`'s train set, the LOIO lambda grid, or `buildTrainSamples` — the 100% is not computed on data the model saw.

But: I decoded all 283 masks and found the labeled train split has only **33 distinct bitmap images** across 194 samples, and heldout has only **14 distinct bitmaps** across 89 samples (this bitmap-poverty fact is already self-disclosed in `docs/nuthing-p2/logistic-classifier.md` and `prototype-classifier.md`). What those docs do **not** state is the direct train/heldout overlap: **85 of the 89 heldout digit samples (95.5%) are byte-identical to some train-split mask.** Only **4/89 (4.5%)** heldout samples have no exact train twin — and all 4 of those are the digit `'9'`. So "100% held-out accuracy" is, for 95.5% of the test set, really "the model recognized a pixel pattern it was trained on verbatim" (UDisc renders each digit from one fixed bitmap font at fixed scale, so this is expected, not a bug — but it means the held-out split's *informativeness* as a generalization test is concentrated in 4 samples, not 89). On those 4 genuinely novel samples the logistic model still went 4/4 — including the specific novel `'9'` bitmap (Hamming distance 83/768 bits from its nearest train `'9'`) that the prototype model fails on 3/3 times (see Claim 2). That's a real, if thin, generalization result — just not the 89-sample one the headline implies.

### Claim 2 — "The prototype colProjection24 model gets 96.6% held-out; its 3 misses are one 9-vs-6 bitmap."

**SURVIVES exactly as stated, with a sharper reframe underneath.** Full from-scratch retrain of `scripts/nuthing/train-prototype.ts` reproduced `models/prototype.json` bit-identical to the committed file (clean `git status` after) and reproduced heldout digit accuracy 86/89 = 96.6%, badge 55/58 = 94.8%, with all 3 misses being `FountainHills-2#badge596#d1`, `FountainHills-full#badge167#d1`, `FountainHills-lazy#badge893#d1` — confirmed byte-identical to each other (same underlying bitmap, true digit `'9'`, predicted `'6'` all three times, same margin 0.0609 all three times).

The sharper fact: those 3 misses are not merely "one bitmap" — they are **exactly 3 of the 4 genuinely novel (non-train-duplicate) heldout digit samples that exist anywhere in this dataset** (see Claim 1). The 4th novel sample (`FountainHills-1#badge902#d0`, also a `'9'`, Hamming distance only 4/768 from a train `'9'`) it gets right. So restated honestly: **on the 85 duplicate-of-train heldout samples, prototype is 85/85 (100%); on the 4 truly novel samples, it is 1/4 (25%).** The 96.6% headline is arithmetically correct but is overwhelmingly a memorization score with a 4-sample generalization probe buried inside it — and prototype fails 3 of those 4. I rendered both the novel `'9'` bitmap and its nearest train `'9'` as ASCII art (`/workspace/nuthing-work/falsifier/attack_a_dedup.py` output) and visually confirmed both are unambiguous `'9'` shapes (closed top loop, open-bottom tail curving left) — the miss is a genuine classification error by a position-only feature set on an unseen rendering, not a labeling artifact.

### Claim 3 — "End-to-end runtime path reads 187/187 truth-labeled badges correctly; warm badge-reading is 0.7–3.9 ms/course."

**SURVIVES.** I re-ran `scripts/nuthing/read-course.ts` from scratch (fresh P1 localization + glyph extraction + segmentation + normalization + classification against the manifest, no cached readings) against the RGBA corpus at `/workspace/nuthing-work/traces-py` and reproduced **187/187 correct**, zero mismatches, on every one of the 15 images. Denominator check: the bbox-keyed truth join is not silently dropping anything — 188 manifest badges total (129 `REAL_GROUNDED` train + 59 `HELD_OUT`), minus exactly 1 excluded (`FountainHills-1#badge1509`, confirmed in `manual-badge-labels.json` as `NON_DIGIT_ARROW`, correctly unlabeled so `expected === null` and it's skipped), gives 187 = 129 + 58 exactly, and every image's per-image `checked` count in the report equals its manifest grounded/labeled badge count with no shortfall — so no badge silently vanished from the denominator due to a bbox mismatch between the manifest-build run and this run (which would require P1 to be non-deterministic between runs; it evidently isn't here).

Timing: my independent rerun (5 repeats, one warmup, same methodology) got a warm range of 0.62–4.11 ms/course versus the doc's checked-in 0.69–3.86 ms — close but not identical, both ends drifted slightly outside the claimed "0.7–3.9". This is expected: the timed section genuinely does cover glyph extraction + segmentation + normalization + classification as claimed (confirmed by reading `readCourseBadges`/`readBadge`), but the "median of 5 repeats" is a small sample on a shared/virtualized machine, so the exact bounds are somewhat run-dependent — a real but minor robustness caveat, not a break of the claim's substance (single-digit millisecond, well under any real ceiling).

One design fragility worth flagging (not a demonstrated bug): the bbox-key truth join fails **silently** — a badge with no bbox match in the manifest is quietly excluded from both numerator and denominator (`if (expected === null || undefined) continue;`) rather than raising an error. In this run it happened not to matter because localization was fully reproducible, but the check has no assertion that `checked` equals the expected grounded/labeled count per image, so a future P1 change that shifted bboxes by even one pixel would silently shrink 187 rather than fail loudly.

### Claim 4 — "Digit-count segmentation accuracy is 100% on both splits."

**SURVIVES.** Directly recomputed from `digit-dataset.json`'s `badges` array (independent of `build-digit-dataset.ts`'s own printed numbers): 129/129 train badges with a label have `digitCountFound === digitCountExpected`, 58/58 heldout likewise; 0 segmentation failures anywhere in the 188-badge corpus, and all 283 emitted digit samples came from the `cc` (connected-component) path with zero `valley-split` invocations — so the "digits usually don't touch" assumption was never actually exercised under a merge scenario in this corpus. This is accurately scoped in the doc itself as "badges with a label" (i.e., it doesn't and can't score the `UNRESOLVED` badges, which have no expected count to check against) — correctly documented, not overclaimed.

## Near-duplicate / duplicate-observation quantification

### Bitmap-level (per digit class, labeled samples only)

| digit | train n | train distinct bitmaps | heldout n | heldout distinct bitmaps | heldout bitmaps with NO train twin |
|---|---|---|---|---|---|
| 0 | 7 | 3 | 5 | 1 | 0 |
| 1 | 82 | 4 | 35 | 2 | 0 |
| 2 | 11 | 1 | 8 | 1 | 0 |
| 3 | 14 | 3 | 6 | 1 | 0 |
| 4 | 16 | 3 | 5 | 1 | 0 |
| 5 | 11 | 3 | 6 | 1 | 0 |
| 6 | 16 | 6 | 5 | 2 | 0 |
| 7 | 15 | 3 | 6 | 1 | 0 |
| 8 | 15 | 4 | 7 | 1 | 0 |
| 9 | 7 | 3 | 6 | 3 | **2** (→ 4 samples) |
| **total** | **194** | **33** | **89** | **14** | **2 distinct / 4 samples** |

**Heldout samples with a byte-identical train twin: 85/89 (95.5%). Genuinely novel: 4/89 (4.5%), all digit `'9'`.** Zero train bitmaps map to more than one distinct digit label (checked programmatically — rules out an internal label contradiction).

### Physical-badge-observation level (Attack F — not previously documented)

Beyond bitmap duplication, the corpus itself contains **repeat photographs of the same physical badge** via viewport-crop variants of the same course, confirmed by byte-identical digit-mask content across the "different" source images:

| group | badge observations | distinct physical badges | evidence |
|---|---|---|---|
| Lenard-1, -2, -3, -4, -5, -full (train) | 47 | **17** | e.g. hole "1"'s digit mask is byte-identical across `Lenard-1#badge170`, `Lenard-2#badge158`, `Lenard-full#badge769` |
| all other train images (AlexClark, DashsTrack, HeritagePark, NorthPark, TowneLake) | 82 | 82 (1:1, single photo each) | — |
| **train total** | **129** | **99** | |
| FountainHills-1, -2, -full, -lazy (heldout) | 58 (labeled) | **20** | e.g. hole "9"'s digit mask is byte-identical across `FountainHills-1#badge902`, `FountainHills-2#badge541`, `FountainHills-full#badge229` |

This means the "11 distinct images" LOIO grouping in `train-prototype.ts`/`train-logistic.ts` is not 11 independent observations — holding out "Lenard-1" as a fold still leaves `Lenard-2` and `Lenard-full`, which contain byte-identical crops of the *same physical badges*, inside that fold's training data. This compounds (does not cause — the fold-exclusion logic is correctly implemented) the bitmap-poverty caveat the docs already self-disclose: near-100% train-side LOIO is even less informative about true generalization than the "33 distinct bitmaps" framing alone suggests, because some of those 33 bitmaps recur across "different" LOIO images specifically *because* they're the same physical object re-cropped, not because the font independently rendered the same shape twice. This does not touch the heldout evaluation (Fountain Hills vs. dev is a genuine physical-course split), so Claims 1–4 are not broken by it, but it further narrows what "58 heldout badges" and "89 heldout digits" represent: **20 distinct physical badges, each observed 2–4 times** by crop variant, not 58 independent real-world instances.

## Training hygiene (Attack B) — SURVIVES

Code-read of `train-logistic.ts` and `train-prototype.ts` confirms: `loadRealExamples`/`trainLabeled` filter strictly on `split === 'train'`; LOIO lambda selection (`chooseLambda`/`loioAccuracy`) is computed only over that filtered set; synthetic samples get a `'__synthetic__'` pseudo-image so they never enter a LOIO fold and never influence lambda/feature-set selection; the synthetic-augmented variant concatenates `[...realTrain, ...synthetic]` with no heldout reference anywhere in either script (confirmed by grep). Class-balance weighting (`1/classCount[label]`, rescaled) checks out algebraically: raw weights sum to the number of represented classes, the rescale factor `examples.length / sum` brings the mean to exactly 1. `synthesize-digits.py` is a from-scratch font-rendering + classical-augmentation generator (fixed-seed `numpy.random.RandomState`, verified byte-identical across two independent runs per its own doc) with zero reference to any real corpus image or to `FountainHills` — confirmed by grepping the script for those terms (no hits).

## Evaluator correctness (Attack C) — SURVIVES

Independently reimplemented the scoring logic in Python straight from `digit-dataset.json` + `results-logistic.json` (not calling `eval-digits.ts`) and reproduced 89/89 digit and 58/58 badge exactly. Confirmed badge-level scoring requires both `segmentationOk` and an exact concatenated-string match (`if (!badge.segmentationOk) { s.badgeSegFailures++; continue; }` — a seg failure is never counted correct, only added to the denominator and a separate failure ledger). This corpus has zero segmentation failures, so the "counts against badge accuracy" behavior couldn't be observed failing in practice here — verified by code path only, not by a live failing example.

## Label channel risk (Attack E)

Only **14 of 188 badges (7.4%)**, all on `DashsTrack-full`, have two independent grounding channels (sha-verified annotation-association vs. manual-visual read) to cross-check against each other, and the doc's own "14/14 agree" is accurate (confirmed by reading `manifest.json`'s `labelProvenance` field for that image: 14 `annotation-association`, 4 `manual-visual`-only fallback with no conflicting claim to compare against). The remaining **174/188 badges (92.6%) — including literally 100% of the Fountain Hills heldout truth — rest on a single channel**: manual visual reads of raw badge crops by "the orchestrating agent" (`manual-badge-labels.json`'s own `reader` field), i.e., the same process running this experiment, not an independent human or second model.

What would a labeling error do, and what bounds it:

- **A random one-off misread** (e.g. one specific badge crop misread) would, given the corpus's heavy bitmap duplication, either (a) land on a bitmap that also occurs correctly-labeled elsewhere in train — producing an internal label contradiction (same feature vector, two different target classes) that a linear/prototype classifier cannot silently absorb; it would surface as a *training*-side misclassification. I checked this directly: **zero train bitmaps map to more than one distinct digit label** across all 33 distinct train bitmaps. That is strong evidence against any random single-instance mislabel among the duplicated bitmaps (which is most of them). Or (b) land on one of the few singleton bitmaps, where it would be undetectable by this check alone.
- **A systematic/consistent misread** (the "poisoned but consistent" risk named in the task) would not trip the internal-contradiction check, since it's applied uniformly. Two additional checks bound this: (1) no course photo has two badges sharing the same hole number, and every course's label set falls inside the plausible 1–18 disc-golf range — a systematic many-to-one digit confusion (e.g. always reading `X` as `Y`) would very likely produce an in-course duplicate number on an 18-hole course, which does not occur anywhere in the manifest; (2) I directly rendered one representative bitmap per digit class 0–9 as ASCII art from the raw pixel data (bypassing the label field entirely) and visually confirmed every shape is an unambiguous match for its claimed digit, including the disputed novel `'9'` bitmap. This is the strongest available mitigant short of a second independent reader, and it passed on every class checked — but it cannot rule out a shape that is *inherently* ambiguous to any visual reader (a swap between two genuinely similar glyphs, e.g. this exact font's `'6'`/`'9'` pair, which the topology-only `topology4` feature set already confuses in-sample per `prototype-classifier.md`'s own confusion table). That residual risk is real but is now the same risk already flagged by the model's own confusions, not a hidden one.

## What would falsify this next

- **A new UDisc app version or a different device/DPI rendering the badge font differently.** The entire "held-out" evaluation currently tests a font-rendering hypothesis (does the model recognize *this exact bitmap font at this exact scale*), not general handwritten- or photographed-digit robustness — 95.5% of the heldout digits are literal duplicates of train bitmaps. A font/scale change would immediately separate "memorized a fixed glyph table" from "learned digit shape," which this dataset currently cannot distinguish for all but 4 samples.
- **A truly independent second human reader for a meaningful sample of the 174 single-channel-labeled badges** (not just DashsTrack) — the current 7.4% two-channel coverage is thin, and it's the only badges/images not read exclusively by the orchestrating agent.
- **A course badge with >2 digits**, or a merged/touching-digit badge — `valley-split` has zero live invocations in this corpus (`cc` handles all 283 samples), so that code path is completely unexercised by any of the four headline numbers.
- **Different camera angle, lower resolution, or heavier JPEG compression** than any of the 15 corpus captures — every one of them renders the badge digits at the same measured 21px glyph height (`synthetic-augmentation.md`'s own finding), so scale/angle robustness is untested, not just under-tested.
- **A P1 localization change that shifts bounding boxes by even 1px** would silently shrink the `read-course.ts` 187 denominator (the bbox-key truth join has no assertion that nothing was dropped) rather than raise an error — a regression there could quietly inflate the reported accuracy percentage while reading fewer real badges.
- **More heldout `'9'` occurrences of the byte-identical 83-bit-distant bitmap variant**, or any new render of that specific shape, since it is currently the *only* place any classifier has actually been asked to generalize rather than recall, and the prototype classifier already fails it 3/3.
