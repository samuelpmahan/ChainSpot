# NuThing P2 — final report and recommendation

Experimental branch deliverable. Nothing here is deployed; downstream
NuThing path/ownership work stayed out of scope.

## Recommendation

**Use the multinomial logistic regression (`resources/nuthing-p2/digits/models/logistic.json`)
as the badge digit reader**: `P(d=k) = softmax(Wx + b)` over the canonical
24×32 mask pixels.

- **Accuracy:** 100% held-out digit (89/89) and badge-label (58/58) accuracy
  on Fountain Hills, trained only on dev REAL_GROUNDED digits; 187/187
  end-to-end through the live runtime path across the whole corpus.
  Decisively, it reads **4/4 of the only genuinely novel held-out bitmaps**
  (all '9's) — the prototype family reads 1/4 of those.
- **Size:** 7,690 parameters (~30 KB packed float32); browser inference is
  one 768-dim matrix multiply + softmax, pure TS, no ML runtime
  (`src/lib/nuthing/digits/logistic.ts` + `readBadges.ts`).
- **Speed (warm):** ~0.011 ms/digit; full badge-reading stage
  (glyph → segmentation → normalization → classification) is
  **0.7–3.9 ms per course**, ~25–140× under the 100 ms loose ceiling.
- **Interpretability:** per-class spatial coefficient maps
  (`resources/nuthing-p2/digits/logistic-coefficients.png`,
  `docs/nuthing-p2/logistic-coefficients.md`) and per-prediction evidence
  retention let a failure be read off as "these cells" — see the 9-vs-6
  diagnostic card (`resources/nuthing-p2/digits/failure-card-9v6.png`).

Runner-up: the 240-float `colProjection24` prototype (96.6% held-out) is 30×
smaller but has a structural blind spot — column projections are nearly
invariant to the 9/6 vertical mirror, and all three of its held-out misses
are exactly that bitmap. Favor-simpler-when-comparable does not apply:
accuracy is not comparable on novel bitmaps.

Synthetic augmentation (2,500 deterministic samples) left logistic at 100%
and dragged the prototype to 75.3% (class means move off the real font).
Not needed for the current corpus; retained as tooling for future
robustness work.

## Why this problem turned out small — and the honest caveat

UDisc renders hole badges from **one fixed bitmap font at one fixed scale**
(constant 21 px glyph height corpus-wide; only 33 distinct digit bitmaps in
194 train samples). The falsifier review (`falsifier-review.md`) quantified
the consequence: 85/89 held-out digit masks are byte-identical to some
train mask, and the 58 labeled held-out badge observations are only 20
distinct physical badges. So the held-out result chiefly proves render
stability plus correct localization/segmentation/normalization — with a 4/4
sample of genuine generalization on top. That is exactly the central
hypothesis of the task ("recognizable from where its expected bright pixels
occur"), confirmed; but a UDisc font/scale change would demand re-training,
and accuracy on truly out-of-distribution renders is established on n=4.

## Deliverables ledger

| deliverable | where | status |
|---|---|---|
| Pure TS P1 | `src/lib/nuthing/` | parity-proven on all 15 rasters (`parity-report.md`) |
| CandidatePool\<T\> | `candidatePool.ts` | 0.40 documented as theoretical floor; evidence never erased |
| Parity tests/report | `scripts/nuthing/parity*.ts` | PASS ×15; tolerated diffs itemized |
| Two-pass CULLED/FULL REPLAY | `twoPass.ts`, `two-pass-tees.md` | culled 0.34 s vs replay 1.40 s corpus-wide |
| Grounded badge manifest | `resources/nuthing-p2/badges/` | 188 observations; dual-channel grounding; FH held out |
| Digit segmentation | `digits/segment.ts`, `digit-segmentation.md` | 100% digit-count accuracy both splits |
| Classifier experiments | `prototype-classifier.md`, `logistic-classifier.md`, `classifier-comparison.md` | official comparison via shared evaluator |
| Synthetic augmentation | `synthesize-digits.py` + `normalize-synthetic.ts` | deterministic, sha-stable |
| Learned weights | `resources/nuthing-p2/digits/models/` | retrains reproduce bit-identically |
| Browser-portable inference | `logistic.ts`, `readBadges.ts` | no ML runtime |
| Warm runtime | `warm-runtime.md` | badge reading 0.7–3.9 ms/course; P1 0.4–5.5 s |
| Visual diagnostics | coefficient maps + failure card | rendered |
| Falsifier review | `falsifier-review.md` | all claims reproduce from clean tree |

## Explicit counterexamples and unresolved cases

1. **Prototype 9→6** (three held-out misses, one bitmap): structural
   feature blindness; diagnostic card committed.
2. **Non-digit arrow badge** (`FountainHills-1#badge1509`): badge-family
   false positive; the reader needs a rejection path before production use.
3. **Badge recall**: Heritage finds 14/18 badges; Fountain Hills' four
   rasters find 10/13/16/20. Missing badges — not digit reading — are the
   dominant end-to-end error source. Unaddressed (P1 behavior preserved).
4. **Degenerate modal tee family** on 13/15 images (2 px specks) inverts
   the tee ranking; on AlexClark a true (inferred hole-14) tee survives
   only in `unculled` at rank 242 score 0.000 — a concrete 0.40-floor
   falsification — and several tees are lost upstream of the pool entirely.
   Baseline property, preserved by the port; the first thing to fix if P1
   tee quality or runtime matters.
5. **Annotation coordinate frames**: only DashsTrack's annotation was made
   on its corpus raster; Heritage/Lenard/TowneLake need re-exported
   annotations to become usable truth. AlexClark's holes 1–3 are
   annotation-internal indices for the course's bent holes (associated to
   badges 16/14/6 by corridor-centerline midpoint), not course numbers.
6. **Label provenance**: 174/188 badge labels rest on the single
   manual-visual-read channel (bounded but not corroborated —
   `falsifier-review.md` attack E). Two-channel corroboration exists only
   on DashsTrack (14/14 agreement).
7. **Untested regimes**: >2-digit labels (no 100+ hole courses), other
   device pixel ratios / app versions / fonts, rotated or heavily obscured
   badges. Labels 19 and 20 exist in the corpus and read correctly.

## Addendum: annotation registration (post-report)

The Heritage/Lenard/TowneLake annotations were successfully registered into
the corpus raster frame after all (scale ~1.00, vertical crop dy = 418/429/
530px) by fitting labeled correspondences — hole path midpoints ↔ badges
whose digits read that hole number (`scripts/nuthing/register-annotations.ts`,
`docs/nuthing-p2/annotation-registration.md`). Consequences:

- **Label corroboration** rises from 14/188 to ~51/188 strictly two-channel
  (leave-one-out refits, d<=40px + margin>=40px; Lenard 16/16, TowneLake
  15/15, Heritage 6/14 under the strict gate), with **zero contradictions**
  anywhere — no LOO-nearest badge ever reads a different number than its
  hole.
- **Tee truth coverage** on the three registered courses is the strongest
  P1-tee falsification yet: registered tees are ABSENT from the ranked pool
  for 14/18 (Heritage, +4 CULLED), 17/18 (Lenard, +1 CULLED) and 18/18
  (TowneLake) holes. Outside DashsTrack the tee side of P1 effectively
  loses everything, consistent with the degenerate modal family. (Caveat:
  ABSENT uses the bbox+3px containment rule on ~4px-residual registered
  coordinates; a few could be near-miss containment rather than true
  absence.)

## Addendum 2: P1.5 middle-out endpoint discovery (post-report)

With the parity constraint lifted, the degenerate tee side was replaced by
badge-seeded middle-out ribbon endpoint discovery (src/lib/nuthing/ribbon.ts,
docs/nuthing-p2/middle-out-dev.md): paired-edge ribbon evidence (ported from
scripts/cv-probes/middleout/middleout.py) + geodesic flood from each badge,
fused with the bright-component universe and ranked by the middle-out
principle (badge = path midpoint => the true tee/basket pair has near-equal
along-ribbon geodesic distances). Results:

- Dev truth gate: 69/69 badge-backed truth holes across all five annotated
  dev courses have both tee and basket in the endpoint pool, at 0.89-1.16s
  total per image (badge stage ~100ms + digits ~3ms + field ~0.8s + all
  floods ~0.25s) - under the 2s/image target that gated validation.
- Validation (docs/nuthing-p2/middle-out-validation.md): all 18 rasters of
  BeaverRanch-Gold, ColetoCreek, Seatac and FountainHills process at
  0.92-1.45s; Fountain Hills digits read 58/58 through this live path;
  every numeric badge receives an endpoint pair (no positional truth exists
  there - pairing quality is audited qualitatively via overlay renders).
- Caveats: gate tolerance 10px (the registered truth itself has ~4px
  residuals); one Heritage tee icon is clipped at the capture edge and is
  matched via its partial component; ribbon/cost knobs were tuned on the
  dev truth (documented in the gate script), so validation courses are the
  honest generalization check for localization the same way Fountain Hills
  was for digits.
