# AlexClark endpoint truth reveal v1

## Experiment

- A: visual-only Sol, `47fd2e97cbaaf40e6288693d716fa0dd3df73245`.
- B: measurement-assisted Sol, `41bd2df385304d4ce2ba686297b41a3ce6bd49b3`.
- M: raw badge, basket-sprite, and tee candidate measurements; no basket/tee ownership output.
- CORPUS_TRUTH: bent-subset endpoints for H6/H13/H16; ChainSpot project endpoints for the 15 straight holes; registered badge boxes for 16 badges.
- ORACLE_OBSERVATION: none.
- Canonical frame: 1290 x 2082; source-to-crop transform `(x,y) -> (x,y-2)`.

## Result

| stage | A | B | M |
|---|---|---|---|
| badge identity | 18/18 | 18/18 | 16/18 recall; 16/16 decoded identity |
| badge position | median 2.019, P90 8.638, max 77.026 (16 refs) | median 0.843, P90 1.78, max 1.83 | median 0.843, P90 1.78, max 1.83 |
| basket identity | 18/18 | 18/18 | 18/18; 20 candidates |
| basket ownership | 15/18 | 15/18 | not produced |
| basket position | median 11.886, P90 22.052, max 47.011 | median 4.357, P90 8.49, max 11.402 | median 4.357, P90 8.49, max 11.402 |
| tee identity | 13/18 | 16/18 | 17/18; 25 candidates |
| tee ownership | 13/13 | 15/16 | not produced |
| tee position | median 9.055, P90 23.479, max 49.092 | median 4.621, P90 6.96, max 14.318 | median 4.82, P90 6.938, max 13.822 |

Missing endpoints remain unresolved and are not assigned artificial distance penalties. Basket/tee position statistics are object-local errors after candidate matching; ownership is reported separately.

## A to B changes

- Improved: 31
- Regressed: 2
- Neutral: 15
- Truth-disputed: 1

| stage | improved | regressed | neutral | truth-disputed |
|---|---:|---:|---:|---:|
| badge | 8 | 0 | 8 | 0 |
| basket | 13 | 1 | 3 | 0 |
| tee | 10 | 1 | 4 | 1 |

Every changed endpoint and its causal machine evidence is retained in `endpoint-comparison.json`.

## Key ownership result

A and B both assign the same wrong basket cycle: H8 points to the H17 basket, H16 points to the H8 basket, and H17 points to the H16 basket. Matched-filter instrumentation improved localization of those three sprites but did not improve ownership.

B also assigns the measured H16 tee to H12. This increases tee candidate coverage but is a wrong ownership change: A left H12 unresolved; B became confidently wrong relative to CORPUS_TRUTH.

## Oracle review queue

Review threshold is only a prioritization rule: ownership disagreement, unresolved B/M identity, or endpoint difference greater than 10 px. It is not a pass/fail threshold.

| hole | object | corpus | A | B | M | reason | artifact |
|---|---|---:|---:|---:|---:|---|---|
| H1 | basket | (773,1325) | (770,1337) | (770,1322) | (770,1322) | position disagreement max=12.369px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H01-basket.png` |
| H1 | tee | (621,1599) | (615,1587) | (616,1595) | (616.4,1595) | position disagreement max=13.416px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H01-tee.png` |
| H2 | tee | (636,1287) | (633,1238) | (633,1288) | (633,1288.1) | position disagreement max=49.092px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H02-tee.png` |
| H3 | basket | (296,2000) | (295,2047) | (295,2008) | (295,2008) | position disagreement max=47.011px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H03-basket.png` |
| H3 | tee | (366,1740) | (364,1724) | (363,1743) | (362.6,1743.4) | position disagreement max=16.125px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H03-tee.png` |
| H4 | basket | (607,1944) | (607,1965) | (610,1953) | (610,1953) | position disagreement max=21px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H04-basket.png` |
| H4 | tee | (373,2053) | (369,2078) | (369,2058) | (368.5,2057.8) | position disagreement max=25.318px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H04-tee.png` |
| H5 | basket | (763,1894) | (760,1905) | (760,1905) | (760,1905) | position disagreement max=11.402px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H05-basket.png` |
| H5 | tee | (486,1886) | (472,1881) | (472,1889) | (472.4,1888.5) | position disagreement max=14.866px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H05-tee.png` |
| H6 | badge | (580,1778) | (578,1765) | (579.6,1777.5) | (579.6,1777.5) | position disagreement max=13.153px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H06-badge.png` |
| H6 | basket | (432,1584.2) | (429,1566) | (429,1586) | (429,1586) | position disagreement max=18.446px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H06-basket.png` |
| H7 | basket | (512,1165) | (513,1148) | (513,1170) | (513,1170) | position disagreement max=17.029px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H07-basket.png` |
| H8 | basket | (526,570) | (485,864) | (485,870) | (523,576) | ownership disagreement; position disagreement max=302.789px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H08-basket.png` |
| H8 | tee | (449,865) | missing | missing | (446.5,862.8) | A unresolved; B unresolved | `lab-artifacts/AlexClark/truth-reveal-v1/review/H08-tee.png` |
| H9 | basket | (355,369) | (353,389) | (353,373) | (353,373) | position disagreement max=20.1px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H09-basket.png` |
| H12 | tee | (459,232) | missing | (604,436) | missing | A unresolved; ownership disagreement; M missing | `lab-artifacts/AlexClark/truth-reveal-v1/review/H12-tee.png` |
| H13 | basket | (1017.5,285.9) | (1015,299) | (1015,288) | (1015,288) | position disagreement max=13.336px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H13-basket.png` |
| H13 | tee | (738,70.2) | missing | (733,68) | (732.8,67.7) | A unresolved | `lab-artifacts/AlexClark/truth-reveal-v1/review/H13-tee.png` |
| H16 | basket | (864.5,792.5) | (523,578) | (523,576) | (864,795) | ownership disagreement; position disagreement max=404.345px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H16-basket.png` |
| H16 | tee | (603.7,435) | missing | missing | (603.6,436.1) | A unresolved; B unresolved | `lab-artifacts/AlexClark/truth-reveal-v1/review/H16-tee.png` |
| H17 | badge | (576,788) | (578,711) | (574.3,787.5) | (574.3,787.5) | position disagreement max=77.026px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H17-badge.png` |
| H17 | basket | (491,871) | (864,768) | (864,795) | (485,870) | ownership disagreement; position disagreement max=386.96px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H17-basket.png` |
| H17 | tee | (681,704) | missing | (675,700) | (675.1,700) | A unresolved | `lab-artifacts/AlexClark/truth-reveal-v1/review/H17-tee.png` |
| H18 | basket | (582,1197) | (578,1180) | (579,1193) | (579,1193) | position disagreement max=17.464px | `lab-artifacts/AlexClark/truth-reveal-v1/review/H18-basket.png` |

## Truth contamination audit

- A and B are immutable ancestors of this reveal.
- Reveal boundary recorded at 2026-08-21T09:42:29-05:00; first projected truth read at 2026-08-21T14:43:15.282Z.
- Bent `left`/`right` geometry was not printed, scored, or rendered.
- No validation or NorthPark resources were opened.
- Post-reveal products make no retrospective blind claim.
