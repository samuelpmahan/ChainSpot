# NuThing P1 Python ↔ TypeScript parity report

Python reference: `scripts/nuthing-p1-canonical.py` (traces via `scripts/nuthing/p1_trace.py`). TypeScript port: `src/lib/nuthing/p1.ts` (traces via `scripts/nuthing/run-p1.ts`). Both sides consumed bit-identical RGBA dumps; comparison is structural (components matched by bbox+area+centroid, not label id).

| image | bright | dark | badges | ranked | max score Δ | py s | ts s | verdict |
|---|---|---|---|---|---|---|---|---|
| AlexClark-full | 303 | 2931 | 16 | 249 | 2.77e-8 | 2.62 | 1.51 | PASS |
| DashsTrack-full | 141 | 705 | 18 | 105 | 3.66e-8 | 1.07 | 0.48 | PASS |
| FountainHills-1 | 854 | 9424 | 10 | 805 | 2.58e-8 | 7.82 | 4.60 | PASS |
| FountainHills-2 | 539 | 12667 | 13 | 467 | 2.63e-8 | 5.14 | 3.14 | PASS |
| FountainHills-full | 544 | 6249 | 20 | 504 | 4.78e-4 | 5.29 | 2.67 | PASS |
| FountainHills-lazy | 1060 | 8460 | 16 | 979 | 2.98e-8 | 9.43 | 5.99 | PASS |
| HeritagePark-full | 1165 | 5214 | 14 | 1111 | 4.38e-8 | 10.98 | 4.63 | PASS |
| Lenard-1 | 363 | 635 | 7 | 311 | 1.68e-8 | 2.61 | 2.07 | PASS |
| Lenard-2 | 388 | 546 | 7 | 340 | 2.58e-8 | 2.88 | 2.18 | PASS |
| Lenard-3 | 969 | 1554 | 4 | 927 | 3.60e-8 | 8.19 | 4.26 | PASS |
| Lenard-4 | 414 | 1247 | 6 | 365 | 4.38e-8 | 3.29 | 2.41 | PASS |
| Lenard-5 | 627 | 1310 | 7 | 573 | 2.98e-8 | 5.10 | 3.13 | PASS |
| Lenard-full | 921 | 2126 | 16 | 840 | 2.99e-8 | 7.31 | 3.89 | PASS |
| NorthPark-full | 503 | 1723 | 16 | 445 | 9.77e-4 | 3.74 | 2.96 | PASS |
| TowneLake-full | 368 | 1960 | 18 | 302 | 2.03e-8 | 2.65 | 2.09 | PASS |

## Tolerated non-semantic differences

- **Score agreement:** every component must score within 2e-6 of the baseline (float32 reduction noise; numpy vectorized float32 exp differs from `Math.fround(Math.exp(...))` by ≤1 ulp).
- **Tie permutations:** identical rendered glyphs tie exactly; their relative order follows component enumeration order (OpenCV block-based labeling vs raster order), which is an implementation detail on both sides.
- **Best-shift arg-max:** when several of the 25 shifts score equal to ~1e-13, the reported (dx,dy) may differ while the score agrees.
- **Unstable-axis components:** `np.cov` runs on BLAS whose summation order is not reproducible outside that build. The ~1e-13 covariance noise only becomes visible for components whose PCA axis is undefined (near-circular) or whose canonical projection is grossly clipped (major×scale ≫ 96). These are itemized per image below; scores may differ up to 1e-2 for them and the surviving ranking must still match.

# Per-image notes

## AlexClark-full
- TIE PRIMARY boundary tie at rank 16/17 (score=0.93377136997202)
- warn: ranked[65] best shift: py=(0,4) ts=(-2,4) label 99 score=0.3311334636775027
- warn: ranked[76] best shift: py=(0,4) ts=(0,2) label 114 score=0.21307667961834062
- warn: ranked[84] best shift: py=(-2,2) ts=(-2,0) label 107 score=0.18204504061842505
- warn: ranked[92] best shift: py=(-2,-4) ts=(0,-4) label 266 score=0.13911473961109777
- warn: ranked[178] best shift: py=(4,-2) ts=(4,0) label 118 score=0.0002590008015112475
- warn: 12 rank positions permuted within exact/near score-tie windows

## DashsTrack-full
- warn: ranked[71] best shift: py=(0,-4) ts=(-2,-4) label 104 score=0.000005619581466823001
- warn: ranked[74] best shift: py=(-2,-4) ts=(2,-4) label 115 score=8.936919482503899e-7
- warn: ranked[90] best shift: py=(-4,-4) ts=(0,-4) label 86 score=7.265198044784863e-8
- warn: ranked[104] best shift: py=(-4,-4) ts=(-2,-4) label 88 score=6.011178938513314e-8

## FountainHills-1
- TIE PRIMARY boundary tie at rank 10/11 (score=0.93377136997202)
- warn: ranked[204] best shift: py=(2,4) ts=(4,4) label 57 score=0.3499359955830763
- warn: ranked[218] best shift: py=(0,4) ts=(0,2) label 407 score=0.2568616600763669
- warn: ranked[219] best shift: py=(4,-2) ts=(4,-4) label 548 score=0.2568616600763669
- warn: ranked[220] best shift: py=(2,2) ts=(2,0) label 654 score=0.2568616600763669
- warn: ranked[235] best shift: py=(2,-4) ts=(0,-4) label 278 score=0.2136445773373569
- warn: ranked[273] best shift: py=(4,4) ts=(4,2) label 229 score=0.15890303600663483
- warn: ranked[288] best shift: py=(-2,-4) ts=(0,-4) label 946 score=0.13911473961109777
- warn: ranked[357] best shift: py=(2,-2) ts=(2,-4) label 340 score=0.11503315242246541
- warn: ranked[368] best shift: py=(-4,0) ts=(-4,2) label 334 score=0.10197551362894797
- warn: ranked[380] best shift: py=(2,-4) ts=(4,-4) label 417 score=0.0957133953954756
- warn: ranked[394] best shift: py=(-2,4) ts=(0,4) label 92 score=0.07923371217043483
- warn: ranked[498] best shift: py=(4,-4) ts=(4,-2) label 129 score=0.008116137647744279
- warn: ranked[513] best shift: py=(-4,-2) ts=(-4,0) label 459 score=0.0054652540340423906
- warn: ranked[707] best shift: py=(2,-4) ts=(4,-4) label 245 score=0.000002898011049059247
- warn: ranked[746] best shift: py=(-4,-2) ts=(-4,-4) label 510 score=1.556936624931622e-7
- warn: 62 rank positions permuted within exact/near score-tie windows

## FountainHills-2
- TIE PRIMARY boundary tie at rank 13/14 (score=0.93377136997202)
- warn: ranked[100] best shift: py=(0,2) ts=(0,0) label 159 score=0.2568616600763669
- warn: ranked[101] best shift: py=(-4,-4) ts=(-2,-4) label 116 score=0.254533028674222
- warn: ranked[143] best shift: py=(-4,4) ts=(-2,4) label 759 score=0.15241357755810406
- warn: ranked[147] best shift: py=(4,2) ts=(4,0) label 634 score=0.1409811625937341
- warn: ranked[150] best shift: py=(-2,-4) ts=(0,-4) label 583 score=0.13911473961109777
- warn: ranked[183] best shift: py=(-4,2) ts=(-4,0) label 357 score=0.11503315242246541
- warn: ranked[184] best shift: py=(-2,4) ts=(-2,2) label 371 score=0.11503315242246541
- warn: ranked[274] best shift: py=(4,2) ts=(4,4) label 404 score=0.0054652540340423906
- warn: ranked[438] best shift: py=(4,-4) ts=(2,-4) label 796 score=1.368384507671267e-8
- warn: 20 rank positions permuted within exact/near score-tie windows

## FountainHills-full
- warn: UNSTABLE-AXIS label 5 (near-circular): py score=0.15327571957812186 ts score=0.1527978199990644

## FountainHills-lazy
- TIE PRIMARY boundary tie at rank 16/17 (score=0.93377136997202)
- warn: ranked[225] best shift: py=(2,4) ts=(4,4) label 315 score=0.3499359955830763
- warn: ranked[226] best shift: py=(2,4) ts=(4,4) label 1259 score=0.3499359955830763
- warn: ranked[234] best shift: py=(2,0) ts=(2,-2) label 1390 score=0.25752057505999215
- warn: ranked[252] best shift: py=(2,-4) ts=(0,-4) label 294 score=0.2136445773373569
- warn: ranked[261] best shift: py=(-2,4) ts=(0,4) label 689 score=0.21257597410590834
- warn: ranked[315] best shift: py=(-4,4) ts=(-2,4) label 889 score=0.15241357755810406
- warn: ranked[338] best shift: py=(-2,4) ts=(0,4) label 645 score=0.13945292242549173
- warn: ranked[339] best shift: py=(-2,-4) ts=(0,-4) label 780 score=0.13911473961109777
- warn: ranked[340] best shift: py=(-2,-4) ts=(0,-4) label 829 score=0.13911473961109777
- warn: ranked[360] best shift: py=(2,-4) ts=(0,-4) label 170 score=0.12787837637209395
- warn: ranked[383] best shift: py=(-2,4) ts=(0,4) label 716 score=0.11879320331321098
- warn: ranked[416] best shift: py=(-2,0) ts=(-2,-2) label 389 score=0.11503315242246541
- warn: ranked[418] best shift: py=(0,2) ts=(0,0) label 1180 score=0.11503315242246541
- warn: ranked[440] best shift: py=(-2,4) ts=(0,4) label 391 score=0.09732468920437556
- warn: ranked[463] best shift: py=(4,4) ts=(2,4) label 636 score=0.07925986923951248
- warn: ranked[465] best shift: py=(4,2) ts=(4,0) label 1345 score=0.07225337814699147
- warn: ranked[510] best shift: py=(4,-2) ts=(4,-4) label 552 score=0.04254725339518014
- warn: ranked[545] best shift: py=(4,-2) ts=(4,-4) label 1218 score=0.024778002716607257
- warn: ranked[708] best shift: py=(4,4) ts=(4,2) label 1409 score=0.00036756635279396255
- warn: ranked[734] best shift: py=(-4,2) ts=(-2,4) label 750 score=0.00018603510191045293
- warn: ranked[955] best shift: py=(-4,4) ts=(-2,4) label 1247 score=4.4777664431056905e-17
- warn: 69 rank positions permuted within exact/near score-tie windows

## HeritagePark-full
- TIE PRIMARY boundary tie at rank 14/15 (score=0.93377136997202)
- warn: ranked[404] best shift: py=(2,4) ts=(4,4) label 280 score=0.3499359955830763
- warn: ranked[405] best shift: py=(2,4) ts=(4,4) label 775 score=0.3499359955830763
- warn: ranked[406] best shift: py=(2,4) ts=(4,4) label 975 score=0.3499359955830763
- warn: ranked[407] best shift: py=(2,4) ts=(4,4) label 1120 score=0.3499359955830763
- warn: ranked[408] best shift: py=(2,4) ts=(4,4) label 1123 score=0.3499359955830763
- warn: ranked[409] best shift: py=(2,4) ts=(4,4) label 1124 score=0.3499359955830763
- warn: ranked[410] best shift: py=(2,4) ts=(4,4) label 1281 score=0.3499359955830763
- warn: ranked[411] best shift: py=(2,4) ts=(4,4) label 1419 score=0.3499359955830763
- warn: ranked[412] best shift: py=(2,4) ts=(4,4) label 1523 score=0.3499359955830763
- warn: ranked[414] best shift: py=(2,-2) ts=(0,-2) label 436 score=0.3311334636775027
- warn: ranked[427] best shift: py=(4,-4) ts=(2,-4) label 852 score=0.2749474502406494
- warn: ranked[454] best shift: py=(-2,4) ts=(-2,2) label 398 score=0.21307667961834062
- warn: ranked[455] best shift: py=(2,0) ts=(2,-2) label 1005 score=0.21307667961834062
- warn: ranked[465] best shift: py=(-4,4) ts=(-4,2) label 689 score=0.19939070151954652
- warn: ranked[467] best shift: py=(-4,4) ts=(-4,2) label 1194 score=0.19939070151954652
- warn: ranked[475] best shift: py=(2,-2) ts=(2,0) label 258 score=0.19569605165874338
- warn: ranked[485] best shift: py=(4,0) ts=(2,0) label 659 score=0.1845042181118375
- warn: ranked[512] best shift: py=(-2,-4) ts=(0,-4) label 581 score=0.13911473961109777
- warn: ranked[513] best shift: py=(-2,-4) ts=(0,-4) label 1381 score=0.13911473961109777
- warn: ranked[517] best shift: py=(2,4) ts=(4,4) label 727 score=0.13351950160231932
- warn: ranked[526] best shift: py=(-4,0) ts=(-4,-2) label 942 score=0.12084845488351054
- warn: ranked[566] best shift: py=(-2,2) ts=(-2,0) label 1271 score=0.11503315242246541
- warn: ranked[735] best shift: py=(-4,-2) ts=(-4,0) label 1478 score=0.009236116130321617
- warn: ranked[1011] best shift: py=(-4,-2) ts=(-4,-4) label 1221 score=0.000003553605016935585
- warn: ranked[1035] best shift: py=(4,4) ts=(4,-4) label 289 score=9.674315913399988e-7
- warn: ranked[1099] best shift: py=(2,-4) ts=(4,-4) label 1066 score=4.72119322307417e-15
- warn: 69 rank positions permuted within exact/near score-tie windows

## Lenard-1
- TIE PRIMARY boundary tie at rank 7/8 (score=0.93377136997202)
- warn: 3 seed positions permuted within exact distance ties
- warn: ranked[83] best shift: py=(-2,-2) ts=(-2,-4) label 91 score=0.21307667961834062
- warn: ranked[105] best shift: py=(-2,-4) ts=(0,-4) label 279 score=0.13911473961109777
- warn: ranked[125] best shift: py=(2,4) ts=(2,2) label 363 score=0.11503315242246541
- warn: ranked[126] best shift: py=(0,-2) ts=(0,-4) label 389 score=0.11503315242246541
- warn: ranked[131] best shift: py=(2,4) ts=(4,4) label 416 score=0.09571339434346095
- warn: ranked[144] best shift: py=(-2,4) ts=(-4,4) label 276 score=0.05514460704763127
- warn: ranked[285] best shift: py=(-4,0) ts=(-4,-2) label 41 score=1.4538772135678528e-7
- warn: 14 rank positions permuted within exact/near score-tie windows

## Lenard-2
- TIE PRIMARY boundary tie at rank 7/8 (score=0.93377136997202)
- warn: ranked[60] best shift: py=(2,4) ts=(4,4) label 377 score=0.3499359955830763
- warn: ranked[61] best shift: py=(2,4) ts=(4,4) label 391 score=0.3499359955830763
- warn: ranked[85] best shift: py=(-2,2) ts=(-2,0) label 260 score=0.18204504061842505
- warn: ranked[93] best shift: py=(0,-4) ts=(-2,-4) label 196 score=0.14245155416113173
- warn: ranked[94] best shift: py=(-2,4) ts=(0,4) label 399 score=0.13945292242549173
- warn: ranked[97] best shift: py=(-2,-4) ts=(0,-4) label 253 score=0.13911473961109777
- warn: ranked[124] best shift: py=(0,4) ts=(2,4) label 262 score=0.10699263617513022
- warn: ranked[126] best shift: py=(-4,-4) ts=(-2,-4) label 451 score=0.10682547709798725
- warn: ranked[141] best shift: py=(4,4) ts=(4,2) label 35 score=0.06340027349941431
- warn: 10 rank positions permuted within exact/near score-tie windows

## Lenard-3
- TIE PRIMARY boundary tie at rank 4/5 (score=0.93377136997202)
- warn: 2 seed positions permuted within exact distance ties
- warn: ranked[197] best shift: py=(2,4) ts=(4,4) label 589 score=0.3499359955830763
- warn: ranked[265] best shift: py=(-2,-4) ts=(0,-4) label 1002 score=0.17753638592847706
- warn: ranked[274] best shift: py=(0,2) ts=(-2,2) label 426 score=0.16077350885836628
- warn: ranked[305] best shift: py=(-2,-4) ts=(0,-4) label 296 score=0.13911473961109777
- warn: ranked[317] best shift: py=(-2,-2) ts=(-4,-2) label 755 score=0.12787837637209395
- warn: ranked[322] best shift: py=(4,0) ts=(4,-2) label 809 score=0.1266921933804261
- warn: ranked[323] best shift: py=(4,0) ts=(4,-2) label 907 score=0.1266921933804261
- warn: ranked[324] best shift: py=(0,-2) ts=(0,-4) label 957 score=0.1266921933804261
- warn: ranked[325] best shift: py=(4,2) ts=(4,0) label 1021 score=0.1266921933804261
- warn: ranked[326] best shift: py=(-4,0) ts=(-4,-2) label 1040 score=0.1266921933804261
- warn: ranked[333] best shift: py=(4,0) ts=(4,-2) label 707 score=0.11879320331321098
- warn: ranked[389] best shift: py=(-4,0) ts=(-4,-2) label 634 score=0.11503315242246541
- warn: ranked[390] best shift: py=(-2,4) ts=(-2,2) label 795 score=0.11503315242246541
- warn: ranked[391] best shift: py=(-4,-2) ts=(-4,-4) label 1160 score=0.11503315242246541
- warn: ranked[473] best shift: py=(4,4) ts=(4,2) label 35 score=0.06340027349941431
- warn: ranked[575] best shift: py=(-4,4) ts=(-4,2) label 352 score=0.007238403491745464
- warn: ranked[652] best shift: py=(4,2) ts=(4,0) label 595 score=0.0002590008015112475
- warn: ranked[870] best shift: py=(-4,0) ts=(-4,-2) label 41 score=1.4538772135678528e-7
- warn: 67 rank positions permuted within exact/near score-tie windows

## Lenard-4
- TIE PRIMARY boundary tie at rank 6/7 (score=0.93377136997202)
- warn: ranked[108] best shift: py=(0,0) ts=(0,-2) label 175 score=0.1409811625937341
- warn: ranked[134] best shift: py=(-4,2) ts=(-4,0) label 469 score=0.11503315242246541
- warn: ranked[153] best shift: py=(4,4) ts=(4,2) label 35 score=0.06340027349941431
- warn: ranked[154] best shift: py=(0,-4) ts=(-2,-4) label 360 score=0.052300219953161024
- warn: ranked[244] best shift: py=(-2,4) ts=(-4,4) label 194 score=0.00004297849207545711
- warn: ranked[300] best shift: py=(-4,2) ts=(-4,0) label 269 score=0.000002116922193332201
- warn: ranked[336] best shift: py=(-4,0) ts=(-4,-2) label 41 score=1.4538772135678528e-7
- warn: 10 rank positions permuted within exact/near score-tie windows

## Lenard-5
- TIE PRIMARY boundary tie at rank 7/8 (score=0.93377136997202)
- warn: ranked[113] best shift: py=(2,4) ts=(4,4) label 410 score=0.3499359955830763
- warn: ranked[129] best shift: py=(-2,0) ts=(-2,2) label 442 score=0.23186199157591042
- warn: ranked[143] best shift: py=(4,0) ts=(4,-2) label 215 score=0.21307667961834062
- warn: ranked[160] best shift: py=(0,0) ts=(0,-2) label 154 score=0.18204504061842505
- warn: ranked[161] best shift: py=(-2,2) ts=(-2,0) label 619 score=0.18204504061842505
- warn: ranked[173] best shift: py=(0,2) ts=(0,0) label 717 score=0.15890303600663483
- warn: ranked[174] best shift: py=(-4,4) ts=(-4,2) label 750 score=0.15890303600663483
- warn: ranked[180] best shift: py=(-2,0) ts=(-2,-2) label 663 score=0.1409811625937341
- warn: ranked[186] best shift: py=(-2,-4) ts=(0,-4) label 311 score=0.13911473961109777
- warn: ranked[215] best shift: py=(4,4) ts=(4,2) label 613 score=0.11503315242246541
- warn: ranked[225] best shift: py=(0,2) ts=(-2,2) label 556 score=0.1061578994839873
- warn: ranked[234] best shift: py=(-4,0) ts=(-4,2) label 393 score=0.09571339434346095
- warn: ranked[238] best shift: py=(2,-4) ts=(4,-4) label 204 score=0.08669737696284337
- warn: ranked[263] best shift: py=(4,4) ts=(4,2) label 35 score=0.06340027349941431
- warn: ranked[266] best shift: py=(4,0) ts=(4,-2) label 629 score=0.05647987525087401
- warn: ranked[271] best shift: py=(0,-4) ts=(-2,-4) label 458 score=0.052300219953161024
- warn: ranked[276] best shift: py=(4,0) ts=(4,4) label 695 score=0.048094127204002884
- warn: ranked[387] best shift: py=(4,2) ts=(4,0) label 673 score=0.0001858211680000385
- warn: ranked[523] best shift: py=(-4,0) ts=(-4,-2) label 41 score=1.4538772135678528e-7
- warn: 21 rank positions permuted within exact/near score-tie windows

## Lenard-full
- TIE PRIMARY boundary tie at rank 16/17 (score=0.93377136997202)
- warn: ranked[224] best shift: py=(2,-4) ts=(2,-2) label 923 score=0.5235697288617611
- warn: ranked[227] best shift: py=(2,4) ts=(4,4) label 166 score=0.3499359955830763
- warn: ranked[228] best shift: py=(2,4) ts=(4,4) label 495 score=0.3499359955830763
- warn: ranked[229] best shift: py=(2,4) ts=(4,4) label 1246 score=0.3499359955830763
- warn: ranked[307] best shift: py=(-2,4) ts=(-4,4) label 1103 score=0.15058192405795096
- warn: ranked[310] best shift: py=(0,4) ts=(-2,4) label 709 score=0.14245155416113173
- warn: ranked[315] best shift: py=(-2,-4) ts=(0,-4) label 159 score=0.13911473961109777
- warn: ranked[339] best shift: py=(2,-4) ts=(4,-4) label 516 score=0.11879320125051977
- warn: ranked[381] best shift: py=(-4,2) ts=(-4,0) label 469 score=0.08669737696284337
- warn: ranked[414] best shift: py=(4,4) ts=(4,2) label 35 score=0.06340027349941431
- warn: ranked[415] best shift: py=(4,2) ts=(4,0) label 210 score=0.06340027349941431
- warn: ranked[486] best shift: py=(4,2) ts=(4,4) label 385 score=0.009236116130321617
- warn: ranked[498] best shift: py=(-4,-2) ts=(-4,0) label 864 score=0.006531989371850728
- warn: ranked[505] best shift: py=(-4,-4) ts=(-4,-2) label 182 score=0.005052678937019467
- warn: ranked[573] best shift: py=(4,-2) ts=(4,-4) label 1195 score=0.0002163914330777343
- warn: ranked[727] best shift: py=(4,2) ts=(4,4) label 262 score=0.000004006820037804885
- warn: ranked[797] best shift: py=(-4,0) ts=(-4,-2) label 41 score=1.4538772135678528e-7
- warn: ranked[798] best shift: py=(-4,0) ts=(-4,-2) label 449 score=1.4538772135678528e-7
- warn: 33 rank positions permuted within exact/near score-tie windows

## NorthPark-full
- TIE PRIMARY boundary tie at rank 16/17 (score=0.93377136997202)
- warn: ranked[87] best shift: py=(2,4) ts=(4,4) label 340 score=0.3499359955830763
- warn: ranked[88] best shift: py=(2,4) ts=(4,4) label 480 score=0.3499359955830763
- warn: ranked[121] best shift: py=(0,-4) ts=(2,-4) label 418 score=0.16388620242012375
- warn: ranked[126] best shift: py=(0,0) ts=(0,-2) label 169 score=0.15890303600663483
- warn: ranked[131] best shift: py=(0,0) ts=(0,-2) label 491 score=0.1409811625937341
- warn: ranked[135] best shift: py=(-2,-4) ts=(0,-4) label 281 score=0.13911473961109777
- warn: ranked[136] best shift: py=(-2,-4) ts=(0,-4) label 372 score=0.13911473961109777
- warn: ranked[145] best shift: py=(4,0) ts=(4,-2) label 166 score=0.1266921933804261
- warn: ranked[168] best shift: py=(2,0) ts=(0,0) label 586 score=0.1061578994839873
- warn: ranked[205] best shift: py=(2,-4) ts=(4,-4) label 106 score=0.044111549402554955
- warn: ranked[284] best shift: py=(4,0) ts=(4,4) label 71 score=0.0004309231699172492
- warn: 8 rank positions permuted within exact/near score-tie windows
- warn: UNSTABLE-AXIS label 72 (window-clipped): py score=0.11601021862454279 ts score=0.11503315242246541

## TowneLake-full
- TIE PRIMARY boundary tie at rank 18/19 (score=0.93377136997202)
- warn: ranked[68] best shift: py=(2,-4) ts=(0,-4) label 70 score=0.2136445773373569
- warn: ranked[79] best shift: py=(-2,4) ts=(-2,2) label 123 score=0.18204504061842505
- warn: ranked[83] best shift: py=(-2,-4) ts=(0,-4) label 297 score=0.13911473961109777
- warn: ranked[84] best shift: py=(-2,-4) ts=(0,-4) label 401 score=0.13911473961109777
- warn: ranked[165] best shift: py=(4,-2) ts=(4,-4) label 201 score=0.0002163914330777343
- warn: ranked[174] best shift: py=(-4,4) ts=(-4,-2) label 382 score=0.00007428894455449143
- warn: 4 rank positions permuted within exact/near score-tie windows


**Overall: PASS** (15 images)