# Badge-Local Ribbon Evidence — Dev72 Checkpoint

Status: LAB evidence only. The reusable four-lane tracker and deterministic badge transit live in `src/lib/nuthing/fourLaneRibbon.ts`; the segmentation/material experiments below are not production behavior.

## Scope

Study the renderer immediately around an already-decoded number badge after Tee->Badge ownership is frozen.

For each Dev72 badge:

- `Wb` = detected badge width (48 px for almost every observed badge; one Lenard badge measured 50 px).
- Study disk = radius `Wb` around badge center.
- Evaluation ribbon truth = pixels within `corridorWidthPx / 2` of that hole's annotated centerline.
- Pixels inside the opaque badge bbox are UNKNOWN / excluded from training and evaluation, never negative ribbon evidence.
- No basket identity or post-badge ownership is supplied to the local segmentation experiments.

Dev72 = DashsTrack, HeritagePark, Lenard, TowneLake, 18 holes each / 72 badges total.

## Four-lane tracker checkpoint

Four equal lanes span `4W/3`; lane width is `W/3` and centers are:

`[-W/2, -W/6, +W/6, +W/2]`

The two outer lane centers ride the expected rails. Occlusion semantics:

- two visible rails -> paired evidence (`min(left,right)`),
- exactly one visible rail -> one-sided evidence,
- zero visible rails -> UNKNOWN, not a miss.

Known starting badge traversal is deterministic from the frozen Tee->Badge pose. No heading optimization, lateral recentering, or lookahead steering is allowed while traversing the known opaque badge; see the four-lane unit regression.

Measured Dev72 basket-first behavior at a 45 px terminal radius:

| tracker | correct first basket | wrong first basket | unresolved |
|---|---:|---:|---:|
| V1 four-lane | 61/72 | 1 | 10 |
| unconstrained lateral-recenter V2 | 62/72 | 5 | 5 |
| recenter experiment + deterministic badge lock | 68/72 | 2 | 2 |

The recenter experiment is **not promoted**. It proves local heading+lateral recovery can rescue cases such as DashsTrack H4, but without explicit rail identity it can jump to a nearby same-width ribbon family.

## Badge-disk segmentation: image appearance

Leave-one-course-out (LOCO): each held-out course is predicted only by a model trained on the other three Dev72 courses. Badge-relative `(x,y,radius)` features were removed; the image model uses RGB/gray/local-contrast/gradient-style appearance only.

Representative LOCO image-only result:

- macro precision ~= 0.75
- macro recall ~= 0.91
- macro F1 ~= 0.82
- macro IoU ~= 0.695

The signal is genuinely visual, not merely a learned "ribbon crosses the center of the badge" prior.

## Rail channels

Existing rail sensing samples expected inside/outside paint lift at the known course width. A scalar `max over orientation` rail score is almost useless because it discards the important variable: which direction the alleged rails run.

LOCO feature ablation (same badge disks / same labels):

| features | macro IoU | macro F1 | Lenard IoU |
|---|---:|---:|---:|
| image | 0.6946 | 0.8181 | 0.6015 |
| image + scalar paired/one-sided strengths | 0.6936 | 0.8173 | 0.5993 |
| image + paired oriented vector | 0.7144 | 0.8320 | 0.6263 |
| image + one-sided oriented vector + visible side | 0.7077 | 0.8272 | 0.6149 |
| image + both oriented rail vectors | 0.7318 | 0.8439 | 0.6481 |
| image + all oriented fields | 0.7359 | 0.8465 | 0.6478 |

Best small tree-grid result (63 leaves, L2=2):

- macro precision = 0.793
- macro recall = 0.918
- macro F1 = 0.848
- macro IoU = 0.7382
- Lenard IoU = 0.6528

Per-hole versus its matched image-only baseline: 47/72 improved by >0.02 IoU, 4/72 regressed by >0.02, median delta ~= +0.033.

The useful axial heading representation uses `cos(2*dHeading)` / `sin(2*dHeading)` (and strength-weighted variants) so a rail direction wraps modulo 180 degrees. `dHeading` is measured relative to the frozen Tee->Badge incoming heading.

Key negative result: **rail strength without orientation is not a useful family signal**. Roads/tree boundaries/etc. often have some orientation that produces a high width-spaced edge response.

## Direct course-local material map

A separate experiment deliberately avoided the cross-course classifier.

For each held-out hole, use the other 17 frozen Tee->Badge halves on the SAME course to collect:

- known inside pixels: safely between the rails,
- known outside pixels: safely beyond the rails,
- a gap around the rail/antialias boundary.

Then classify the held-out `radius=Wb` disk only by inside-likelihood versus outside-likelihood.

| direct material model | macro IoU | precision | recall |
|---|---:|---:|---:|
| gray only | 0.570 | 0.608 | 0.898 |
| gray + chroma histogram | **0.671** | **0.735** | **0.882** |
| diagonal RGB/gray/chroma Gaussian | 0.611 | 0.675 | 0.863 |

Gray+chroma IoU by course:

- DashsTrack: 0.735
- HeritagePark: 0.669
- Lenard: 0.546
- TowneLake: 0.733

Interpretation: course-local ribbon material is extremely learnable and nearly reaches the generic cross-course image model by itself. Lenard is the clearest material-only falsifier because pavement/background can share the same gray/chroma family.

## Rail run continuity is still missing

The current four-lane rail sensor averages a small number of tangent samples over a short span. It does **not** yet require a contiguous `minRequiredRun` of material-correct edge evidence.

This is an explicit next experiment, not a landed behavior:

`railHit(x) = correct edge polarity AND course-local ribbon material`

Then measure the longest contiguous tangent run and require a minimum run length. Paired and one-sided rails should be evaluated separately. Hidden rail pixels remain neutral.

## Next experiment: outside -> inside composite residual

Raw greyness can confuse ribbon with pavement. A stronger renderer-specific signal should learn the transformation caused by the translucent overlay itself.

From frozen Tee->Badge rails, collect paired samples across a known rail:

`B = outside/background RGB`

`C = corresponding inside/ribbon-rendered RGB`

Study a global seed plus per-course adaptation for the transform, e.g. a constrained alpha-composite family or a directly learned `B -> C` residual. At a proposed rail run, ask whether observed inside pixels match the expected renderer transformation of their local outside pixels.

This should be evaluated over contiguous lengths, not isolated pixels, to suppress texture coincidences.

## Runtime discipline

Keep experimental compute bursts <= 40 seconds. Prewarm/JIT reusable local sensors before corpus sweeps when applicable.
