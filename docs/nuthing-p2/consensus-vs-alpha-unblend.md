# Occluded tee recovery A/B — transparency+consensus vs alpha-unblend

Status: direct behavior-equivalent A/B on the same five local corpus rasters and the same chrome-attributed baseline endpoint pool. Recovery only was changed between arms. AlexClark truth is checked only for the 3 holes currently present in its annotation file.

## Methods

### Transparency + normal-tee consensus

`transparent_consensus_tee_recovery.py`

- Basket bbox remains an association/search footprint.
- Only the basket sprite's actual rendered support (+2 px AA dilation) is treated as occluding.
- Search operates on surviving raw bright fragments.
- Candidate pose must satisfy the masked tee-ring fit.
- At least 80% of fragment pixels must land in canonical positions occupied by at least 50% of clean same-course tees.

### Alpha-unblend v3

`occluded_tee_recovery_v3.py`

- Learns a per-pixel alpha model from the course's basket-sprite instance stack.
- Statistically reconstructs ground pixels under semi-transparent sprite regions.
- Adds reconstructed-bright evidence to raw bright evidence.
- Uses uniqueness, artifact-family, support-aware excusal, and big-furniture vetoes to control reconstruction artifacts.

## Five-raster direct recovery matrix

| course | baseline missing | consensus placements | consensus missing hits | consensus basket-attributed extras | unblend placements | unblend missing hits | unblend basket-attributed extras |
|---|---|---:|---:|---:|---:|---:|---:|
| AlexClark (3 checked) | — | 0 | 0 | 0 | 1 | 0 | 1 |
| DashsTrack | — | 1 | 0 | 1 | 0 | 0 | 0 |
| Heritage | h5,h6,h10 | 1 | **h6** | 0 | 5 | **h5,h6** | 3 |
| Lenard | — | 0 | 0 | 0 | 1 | 0 | 1 |
| TowneLake | — | 0 | 0 | 0 | 0 | 0 | 0 |

Neither arm produced an unexplained free recovery candidate in this chrome-attributed rerun; the extra hypotheses above all sit inside known basket footprints.

## H6 is effectively the same solution

| | transparency+consensus | alpha-unblend |
|---|---:|---:|
| score | **0.871** | 0.841 |
| distance to H6 truth | **11.01 px** | 11.10 px |
| fitted center separation | \multicolumn{2}{c}{**0.16 px**} |
| fitted orientation | 7.5° | 7.5° |
| fragment pixels | 21 | 22 |
| original raw-bright pixels | **21** | **21** |
| reconstruction-only pixels | 0 | **1** |
| >=50%-tee-consensus agreement | **20/21 = 95.2%** | same raw fragment / effectively same pose |

The two methods do not discover independent H6 geometry. They converge on the same orientation and centers only 0.16 px apart. The unblend candidate's 22-pixel support contains the exact 21-pixel raw fragment plus only one reconstruction-only pixel.

That means the decisive H6 fix is not statistical recovery of hidden pixels. It is respecting the renderer: the 42x66 basket **bbox is not an opaque occluder**. Once transparent parts of the sprite stop deleting the raw tee fragment, the surviving evidence is already sufficient to fit H6.

## What alpha-unblend additionally buys

Unblend independently re-finds Heritage h5 at 6.85 px / score 0.822, using 10 raw fragment pixels and **0 reconstruction-only pixels**. This is redundant in the current stack because v2 already recovers h5 substantially more strongly (~6.9 px / 0.914). Neither supplemental method replaces v2's h10 recovery.

So relative to the existing v2 recovery:

- `v2 + consensus` -> h5 + h10 + h6 = 72/72 dev tee availability.
- `v2 + unblend` -> also reaches 72/72, but unblend's only unique required contribution is h6.

## Consensus is doing real suppression work

A transparency-aware ring fit **without** the >=50%-normal-tee consensus gate produced 6 placements in this five-raster run:

- DashsTrack: 2
- Heritage: 3
- Lenard: 1

Adding the consensus gate reduces that to 2 total placements:

- Heritage h6
- one basket-attributed Dashs hypothesis

So the learned normal-tee band is not cosmetic; it removes four geometrically plausible sprite/furniture fits while retaining H6.

## Runtime in the same Python harness

Recovery stage only, same machine/run; these are experimental Python runtimes, not production benchmarks.

| course | consensus | unblend |
|---|---:|---:|
| AlexClark | 301 ms | 5684 ms |
| DashsTrack | 212 ms | 1018 ms |
| Heritage | 280 ms | 10333 ms |
| Lenard | 942 ms | 3911 ms |
| TowneLake | 54 ms | 2025 ms |
| **total** | **1.79 s** | **22.97 s** |

Unblend is ~12.8x slower in this harness.

## Read

For the current evidence, prefer the transparency-aware + normal-tee-consensus recovery as the simpler experimental path:

1. It recovers the only endpoint v2 still misses.
2. It recovers essentially the same H6 pose as unblend.
3. H6 uses 21 real surviving pixels either way; unblend contributes only one additional reconstructed pixel.
4. The consensus prior suppresses several otherwise-plausible furniture fits.
5. It is dramatically cheaper and has fewer basket-attributed hypotheses.

Keep alpha-unblend as a valuable renderer/compositing probe and fallback for a future case where **no usable raw fragment survives**. The present H6 case does not demonstrate that need.
