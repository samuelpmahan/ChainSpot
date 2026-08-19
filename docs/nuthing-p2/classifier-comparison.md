# Digit classifier comparison

All classifiers scored by `scripts/nuthing/eval-digits.ts` on the same dataset and splits (train = dev REAL_GROUNDED; heldout = Fountain Hills, truth from evaluation-only manual labels). Badge-level accuracy counts segmentation failures against the badge score; the segmentation ledger itself is docs/nuthing-p2/digit-segmentation.md.

| classifier | trained on | digit acc (train) | digit acc (heldout) | badge acc (train) | badge acc (heldout) | mean margin (heldout) |
|---|---|---|---|---|---|---|
| prototype-colProjection24-euclidean | train-real | 100.0% (194/194) | 96.6% (86/89) | 100.0% (129/129) | 94.8% (55/58) | 0.8420 |
| prototype-colProjection24-euclidean-synth | train-real+synthetic | 80.4% (156/194) | 75.3% (67/89) | 70.5% (91/129) | 62.1% (36/58) | 0.3449 |
| logistic-regression | train-real | 100.0% (194/194) | 100.0% (89/89) | 100.0% (129/129) | 100.0% (58/58) | 0.9890 |
| logistic-regression-synth | train-real+synthetic | 100.0% (194/194) | 100.0% (89/89) | 100.0% (129/129) | 100.0% (58/58) | 0.9962 |

## prototype-colProjection24-euclidean

Model: `resources/nuthing-p2/digits/models/prototype.json`; trained on: train-real.

### train: digit 100.0% (194/194), badge 100.0% (129/129) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (7/7); 1: 100.0% (82/82); 2: 100.0% (11/11); 3: 100.0% (14/14); 4: 100.0% (16/16); 5: 100.0% (11/11); 6: 100.0% (16/16); 7: 100.0% (15/15); 8: 100.0% (15/15); 9: 100.0% (7/7)

### heldout: digit 96.6% (86/89), badge 94.8% (55/58) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (5/5); 1: 100.0% (35/35); 2: 100.0% (8/8); 3: 100.0% (6/6); 4: 100.0% (5/5); 5: 100.0% (6/6); 6: 100.0% (5/5); 7: 100.0% (6/6); 8: 100.0% (7/7); 9: 50.0% (3/6)

Misclassifications:
- `FountainHills-2#badge596#d1`: true 9 → predicted 6 (margin 0.0609)
- `FountainHills-full#badge167#d1`: true 9 → predicted 6 (margin 0.0609)
- `FountainHills-lazy#badge893#d1`: true 9 → predicted 6 (margin 0.0609)
- confusion[9]: 6×3, 9×3

## prototype-colProjection24-euclidean-synth

Model: `resources/nuthing-p2/digits/models/prototype-synth.json`; trained on: train-real, synthetic.

### train: digit 80.4% (156/194), badge 70.5% (91/129) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (7/7); 1: 100.0% (82/82); 2: 100.0% (11/11); 3: 0.0% (0/14); 4: 100.0% (16/16); 5: 18.2% (2/11); 6: 100.0% (16/16); 7: 100.0% (15/15); 8: 0.0% (0/15); 9: 100.0% (7/7)

Misclassifications:
- `AlexClark-full#badge18#d1`: true 3 → predicted 4 (margin 0.1839)
- `AlexClark-full#badge29#d1`: true 5 → predicted 6 (margin 0.0012)
- `AlexClark-full#badge128#d0`: true 8 → predicted 6 (margin 0.0060)
- `AlexClark-full#badge318#d0`: true 3 → predicted 4 (margin 0.1673)
- `DashsTrack-full#badge21#d0`: true 3 → predicted 4 (margin 0.1839)
- `DashsTrack-full#badge31#d1`: true 8 → predicted 5 (margin 0.0083)
- `DashsTrack-full#badge64#d0`: true 8 → predicted 5 (margin 0.0111)
- `DashsTrack-full#badge94#d1`: true 3 → predicted 4 (margin 0.1673)
- `HeritagePark-full#badge751#d0`: true 8 → predicted 6 (margin 0.0051)
- `HeritagePark-full#badge1062#d0`: true 5 → predicted 6 (margin 0.0012)
- `HeritagePark-full#badge1328#d1`: true 8 → predicted 6 (margin 0.0051)
- `HeritagePark-full#badge1346#d0`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-1#badge229#d1`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-1#badge265#d1`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-1#badge316#d1`: true 5 → predicted 6 (margin 0.0012)
- `Lenard-2#badge214#d1`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-2#badge243#d1`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-2#badge293#d1`: true 5 → predicted 6 (margin 0.0012)
- `Lenard-3#badge331#d0`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-4#badge244#d0`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-5#badge325#d0`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-full#badge178#d0`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-full#badge556#d0`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-full#badge809#d1`: true 3 → predicted 4 (margin 0.1839)
- `Lenard-full#badge871#d1`: true 8 → predicted 6 (margin 0.0051)
- `Lenard-full#badge977#d1`: true 5 → predicted 6 (margin 0.0012)
- `NorthPark-full#badge264#d0`: true 8 → predicted 6 (margin 0.0051)
- `NorthPark-full#badge318#d1`: true 3 → predicted 4 (margin 0.1839)
- `NorthPark-full#badge331#d1`: true 5 → predicted 6 (margin 0.0012)
- `NorthPark-full#badge398#d1`: true 8 → predicted 6 (margin 0.0051)
- `NorthPark-full#badge404#d0`: true 5 → predicted 6 (margin 0.0012)
- `NorthPark-full#badge449#d0`: true 3 → predicted 4 (margin 0.1839)
- `TowneLake-full#badge204#d0`: true 8 → predicted 6 (margin 0.0051)
- `TowneLake-full#badge325#d1`: true 3 → predicted 4 (margin 0.1839)
- `TowneLake-full#badge349#d0`: true 5 → predicted 6 (margin 0.0012)
- `TowneLake-full#badge353#d1`: true 8 → predicted 6 (margin 0.0051)
- `TowneLake-full#badge360#d1`: true 5 → predicted 6 (margin 0.0012)
- `TowneLake-full#badge376#d0`: true 3 → predicted 4 (margin 0.1839)
- confusion[3]: 4×14
- confusion[5]: 6×9, 5×2
- confusion[8]: 6×13, 5×2

### heldout: digit 75.3% (67/89), badge 62.1% (36/58) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (5/5); 1: 100.0% (35/35); 2: 100.0% (8/8); 3: 0.0% (0/6); 4: 100.0% (5/5); 5: 0.0% (0/6); 6: 100.0% (5/5); 7: 100.0% (6/6); 8: 0.0% (0/7); 9: 50.0% (3/6)

Misclassifications:
- `FountainHills-1#badge1020#d0`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-1#badge1216#d0`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-1#badge1266#d0`: true 5 → predicted 6 (margin 0.0012)
- `FountainHills-2#badge503#d1`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-2#badge562#d0`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-2#badge567#d1`: true 5 → predicted 6 (margin 0.0012)
- `FountainHills-2#badge596#d1`: true 9 → predicted 5 (margin 0.1160)
- `FountainHills-2#badge599#d1`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-full#badge117#d1`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-full#badge152#d1`: true 5 → predicted 6 (margin 0.0012)
- `FountainHills-full#badge167#d1`: true 9 → predicted 5 (margin 0.1160)
- `FountainHills-full#badge193#d1`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-full#badge250#d0`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-full#badge403#d0`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-full#badge475#d0`: true 5 → predicted 6 (margin 0.0012)
- `FountainHills-lazy#badge577#d1`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-lazy#badge738#d1`: true 5 → predicted 6 (margin 0.0012)
- `FountainHills-lazy#badge787#d0`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-lazy#badge893#d1`: true 9 → predicted 5 (margin 0.1160)
- `FountainHills-lazy#badge902#d1`: true 8 → predicted 6 (margin 0.0051)
- `FountainHills-lazy#badge916#d0`: true 3 → predicted 4 (margin 0.1839)
- `FountainHills-lazy#badge949#d0`: true 5 → predicted 6 (margin 0.0012)
- confusion[3]: 4×6
- confusion[5]: 6×6
- confusion[8]: 6×7
- confusion[9]: 5×3, 9×3

## logistic-regression

Model: `resources/nuthing-p2/digits/models/logistic.json`; trained on: train-real.

### train: digit 100.0% (194/194), badge 100.0% (129/129) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (7/7); 1: 100.0% (82/82); 2: 100.0% (11/11); 3: 100.0% (14/14); 4: 100.0% (16/16); 5: 100.0% (11/11); 6: 100.0% (16/16); 7: 100.0% (15/15); 8: 100.0% (15/15); 9: 100.0% (7/7)

### heldout: digit 100.0% (89/89), badge 100.0% (58/58) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (5/5); 1: 100.0% (35/35); 2: 100.0% (8/8); 3: 100.0% (6/6); 4: 100.0% (5/5); 5: 100.0% (6/6); 6: 100.0% (5/5); 7: 100.0% (6/6); 8: 100.0% (7/7); 9: 100.0% (6/6)

## logistic-regression-synth

Model: `resources/nuthing-p2/digits/models/logistic-synth.json`; trained on: train-real, synthetic.

### train: digit 100.0% (194/194), badge 100.0% (129/129) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (7/7); 1: 100.0% (82/82); 2: 100.0% (11/11); 3: 100.0% (14/14); 4: 100.0% (16/16); 5: 100.0% (11/11); 6: 100.0% (16/16); 7: 100.0% (15/15); 8: 100.0% (15/15); 9: 100.0% (7/7)

### heldout: digit 100.0% (89/89), badge 100.0% (58/58) (0 badge(s) lost to segmentation)

Per class: 0: 100.0% (5/5); 1: 100.0% (35/35); 2: 100.0% (8/8); 3: 100.0% (6/6); 4: 100.0% (5/5); 5: 100.0% (6/6); 6: 100.0% (5/5); 7: 100.0% (6/6); 8: 100.0% (7/7); 9: 100.0% (6/6)
