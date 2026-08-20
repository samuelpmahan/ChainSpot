# Semantic bend extraction over frozen hole shapes

## Verdict

**Yes for bend count; only partly for bend location.** The current hole-shape output already contains enough low-frequency geometry to recover useful 0/1/2 semantic bend counts with a very cheap post-process. It does **not** always contain the semantic corner at the right arc-length position, so no tested simplifier can make every bend coordinate production-accurate without changing the substrate.

Recommended probe result: **RDP at 10 px**. It is one parameter, gets the same count result as the more elaborate methods, preserves the detected corridor, and is the easiest rule to explain/review.

## Headline numbers

| method | Dash exact 0/1/2 | Dash false bends on 9 straights | Dash loc median / max | Alex labeled bend count | note |
|---|---:|---:|---:|---:|---|
| existing capsule baseline | 17/18 | 0 | 25.7 / 49.2 px* | 3/3 | misses Dash H4 count |
| **RDP, ε=10 px** | **18/18** | **0** | **27.1 / 85.5 px** | **3/3** | simplest |
| piecewise 0/1/2 + 25 px²/bend | **18/18** | **0** | **25.2 / 85.5 px** | **3/3** | no meaningful location win |
| heading accumulation, 50 px / 10° | **18/18** | **0** | **27.2 / 85.9 px** | **3/3** | same conclusion |

\*Location stats only exist where baseline count is correct, so the capsule baseline's max hides its H4 miss.

AlexClark has only three existing bent-hole gutter labels, not a labeled straight set. All three methods get **3/3 raw bend counts**. One of those three (A2) is separately classified `SHAPE BAD`: the frozen centerline has only 0.739 truth-gutter containment. On the two shape-good Alex holes, exact count is 2/2; a straight-hole false-positive rate cannot honestly be measured from the current Alex fixture.

The count result is not a knife-edge threshold accident. Nearby checks on Dash: RDP 10 and 12 px are 18/18; piecewise penalties 16/25/36/49 px² are all 18/18; heading thresholds 8/10/12° at a 50 px window are all 18/18.

## Count vs location vs corridor fidelity

The three questions separate cleanly:

- **Count:** solved on the current fixtures. RDP/piecewise/heading all recover H18's two bends and produce zero false bends on Dash's nine straight holes.
- **Location:** not solved uniformly. With a diagnostic tolerance of one corridor width (~42 px), RDP is `LOCATION WRONG` on Dash H4 (85.5 px) and H8 (67.5 px). Alex A1 is 48.1 px off; A2 is substrate-bad; A3 is 20.9 px off.
- **Simplified path fidelity:** all RDP simplified paths remain 100% within 21 px of the frozen detected centerline. Against author gutters, the main simplification loss is H8: 0.910 -> 0.838 containment. The other labeled Dash holes are essentially unchanged.

H4 is the most useful failure. The author gutter corner is near `(457, 829)`, but the frozen centerline's only meaningful direction change is near `(444, 744)`, ~85 px upstream. RDP, model selection, and heading accumulation all choose that same neighborhood. This is a **substrate localization limit**, not a bend-classifier threshold problem. The existing capsule rule instead calls H4 straight, which avoids the bad coordinate but loses the true bend count.

## Detection floor

Truth turn angle alone is **not** the floor. H4 is a ~43° true turn yet is the hardest localization case because the turn happens late/over a short run; meanwhile ~17–18° gentle bends survive. Sustained displacement / arc length matters as much as angle.

| course/hole | true approx turn | RDP count detects? | result |
|---|---:|---|---|
| Dash H7 | 17.5° | yes | GOOD |
| Dash H15 | 17.9° | yes | GOOD |
| Dash H18 bend 1 | 21.2° | yes | GOOD |
| Dash H1 | 26.9° | yes | GOOD |
| Alex A3 | 27.1° | yes | GOOD |
| Dash H5 | 42.2° | yes | GOOD |
| Alex A1 | 42.1° | yes | LOCATION WRONG |
| Dash H4 | 43.3° | yes | LOCATION WRONG |
| Dash H8 | 54.3° | yes | LOCATION WRONG |

A more useful floor appears **in the detected geometry itself**: Dash straight holes have only ~0–3° residual vertex turns, while the weakest semantic turn exposed by the frozen shape is ~13° (H4). That gap is why a ~10° heading threshold also works cleanly. This should be re-measured on future courses rather than promoted as a production constant from N=2.

## Truth / failure conventions

- Existing Dash bent gutters are reused directly for H4/5/7/8/14/15/18; unlisted H4-18 holes are straight per that fixture.
- H1/H2 gentle bends and H3 straight come from the older dense golden gutters; the probe derives H1/H2 bend coordinates from those gutters rather than adding new hand labels.
- Existing AlexClark labels cover three bent holes only. No new full-course Alex truth was manufactured.
- `SHAPE BAD`: truth-gutter containment <0.80 before simplification.
- `LOCATION WRONG`: count is correct but any bend is >42 px from truth. These are diagnostic reporting cutoffs, not tuned detector parameters.

## Recommendation

For an annotation assist, the frozen shape is already good enough to emit **semantic bend count + rough bend positions**. Start with RDP at ~10 px and let the editor expose the points for quick correction. Do **not** spend more research time inventing a smarter bend post-processor to fix H4/H8: the three independent methods agree that those location errors are already baked into the detected geometry.

If automatic bend coordinates must be trusted without review, the answer is **not yet**: improve the underlying shape's arc-length localization on those cases first, while keeping this semantic extractor frozen.
