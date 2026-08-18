# Semantic stitch front-end: CHSPT-75 / CHSPT-76 / CHSPT-77

Research branch baseline: `prestaging/demo @ ba59447ac20dd6b680d627c37a561638956d7c3d` (explicit task exception to the normal no-staging-base workflow rule).

This thread is diagnostic/additive only. It does not change `buildPoseGraph`, `cvMatch`, `stitchPipeline`, or any production stitch caller.

## CHSPT-75 — pure-TS source landmarks

`semanticLandmarks.ts` performs one ordinary JS/TS RGB scan per source, creates bright/dark masks, measures 8-connected components, then chooses badge and basket families with batch-wide repeated-geometry consensus. A source with one matching object can inherit the family scale learned from other sources; a whole batch with only one candidate abstains.

Measured on six real UDisc course rasters supplied with the investigation (21,172,578 total pixels):

- five full-batch runs: 510.30, 526.01, 528.74, 500.44, 454.66 ms; median 510.30 ms;
- robust badge scale: 48 x 36 px, median mask area 1410 px, 99 accepted observations across all 6 sources;
- robust basket scale: 42 x 66 px, median mask area 1746 px, 91 accepted observations across all 6 sources;
- per-source accepted badge/basket counts: source-original 9/9, Towne Lake 18/18, Heritage Park 18/15, Alex Clark 18/15, Lenard 18/16, Dash's Track 18/18;
- on the fully/partially annotated basket controls where exact source coordinates were available, 30/30 annotated baskets had a detected basket center within 40 px. The consistent ~32 px vertical offset is expected because annotation truth is the basket anchor/base while the stitch landmark is the sprite-body center.

Diagnostic overlays were inspected source-by-source. On the fully annotated Dash's Track and The Rec controls there were no unmatched accepted basket observations; the partial Alex Clark annotation only labels three holes, so its remaining detected baskets are not counted as false positives.

Abstention is explicit per family: `no-shape-candidates` or `insufficient-batch-consensus`.

## CHSPT-76 — pairwise translation voting

Four deterministic 1400 x 1400 crops were cut from one real UDisc source raster at exact source offsets:

- NW: (0, 0)
- NE: (844, 0)
- SW: (0, 812)
- SE: (844, 812)

CHSPT-75 was rerun on the crop batch, producing badge/basket counts of 3/4, 4/4, 5/5, and 4/5 respectively. `voteSemanticTranslation` then formed every same-family `pA - pB` vote and clustered them with one-to-one correspondence support.

All six unordered crop pairs recovered exact translation with 0 px x/y error and 0 px inlier RMS:

| Pair | Combined inliers | Families | Result |
| --- | ---: | ---: | --- |
| NW-NE | 4 | 2 | exact |
| NW-SW | 4 | 2 | exact |
| NW-SE | 2 | 2 | exact |
| NE-SW | 2 | 2 | exact |
| NE-SE | 5 | 2 | exact |
| SW-SE | 5 | 2 | exact |

Family ablation is the key result. Badge-only and basket-only each succeed on the four edge-neighbor pairs but each diagonal has only one shared same-family landmark and correctly abstains. Combining the families supplies one badge + one basket on each diagonal, producing two independent same-offset correspondences and an exact accepted transform. Thus family diversity materially increases graph connectivity rather than merely increasing the score of already-obvious edges.

After localization, pairwise point arithmetic is tiny: typically sub-millisecond to about 1 ms per pair in the ad-hoc real-crop harness after warmup.

### Current OpenCV comparison baseline

The repository's independent real-capture oracle records the four TL/TR/BL/BR translations and `realCaptureAcceptance.test.ts` requires the current OpenCV-backed `assignN` result to be within 4 px on each axis. That is the production comparison contract. The semantic experiment above is detector-backed and exact (0 px) on deterministic overlapping crops of a separate real UDisc raster. The exact TL/TR/BL/BR bytes were not available to this execution environment for a same-fixture semantic rerun, so these are two real-image baselines rather than a falsely presented same-fixture head-to-head.

## CHSPT-77 — semantic edges in the existing pose-graph shape

`semanticPoseGraph.ts` is deliberately isolated from production. It builds all pairwise CHSPT-76 probes, scores accepted edges from inlier count + family diversity + RMS + runner-up margin, then uses the same architecture as current `poseGraph.ts`: strongest aggregate seed followed by maximum-weight Prim growth. Rejected pair probes remain visible as generic-pixel candidates; if the accepted semantic graph is disconnected, pixel evidence is required to place the missing tile/subgraph.

On the same four real crops:

- semantic graph: connected;
- accepted semantic edges: 6/6 (complete graph);
- strongest seed: SE (index 3);
- placement tree: SE->NE (5 inliers), SE->SW (5), NE->NW (4);
- recovered transforms, relative to SE: SE (0,0), NE (0,-812), SW (-844,0), NW (-844,-812), all exact;
- generic-pixel placement fallback required: none.

A second real-raster experiment deliberately created a pair whose true overlap contains only one shared physical landmark. Every semantic hypothesis had one inlier; the winner and runner-up tied, and the pair returned `insufficient-independent-support` instead of accepting a repeated-UI coincidence. This is the intended pixel-fallback boundary.

### Minimum evidence contract

Measured real-crop correspondences plus synthetic transform controls support this contract:

| Evidence | What it buys | Selection rule |
| --- | --- | --- |
| 1 correspondence | translation hypothesis only | never a verified semantic edge by itself |
| 2 independent, separated correspondences | verifies translation; similarity becomes identifiable | keep translation if residual is already low; fit similarity only if translation residual requires it |
| 3 non-collinear correspondences | affine becomes identifiable | keep translation/similarity if they already explain the observations; affine only if residual still requires it |
| >3 | residual/outlier leverage + stronger graph weight | simplest adequate family still wins |

On every real crop edge, translation RMS was 0, including edges with 3-5 correspondences, so escalating solely because more points exist would be strictly worse model selection. Synthetic two-point rotation/scale and three-point shear controls prove the similarity and affine escalation paths when residual actually demands them.

### Point-graph runtime scaling

Synthetic translated-source batches with six irregular landmarks per source were used to isolate graph arithmetic from raster localization. Warmed medians:

| N | all pairs | median graph ms | p95 ms |
| ---: | ---: | ---: | ---: |
| 2 | 1 | 0.058 | 0.188 |
| 4 | 6 | 0.319 | 0.486 |
| 8 | 28 | 1.138 | 3.314 |
| 16 | 120 | 2.236 | 4.362 |
| 24 | 276 | 5.358 | 7.107 |

The cost is therefore dominated by the expected O(N^2) pair count, but remains tiny compared with raster localization at the current 24-tile pose-graph ceiling. A cold-ish first four-source detector-backed graph run was 6.28 ms; repeated warmed four-source runs were below 1 ms.

## Recommended production integration contract

Do not replace `poseGraph.ts`. Treat semantic matching as a cheap edge supplier/seed in front of its existing graph:

1. localize badge/basket landmarks while OpenCV is still lazy-loading;
2. build all-pairs semantic translation votes;
3. accept a semantic translation edge only with >=2 independent inliers and a non-competitive runner-up; use family diversity and RMS in its confidence weight;
4. feed those edges into the existing topology/placement architecture;
5. if semantic edges already connect a tile with low residual, generic pixel matching is verification/refinement, not discovery;
6. if a tile/subgraph is disconnected, or only one-inlier/ambiguous hypotheses exist, run generic pixel matching for the missing edge(s);
7. only consider similarity/affine from semantic correspondences when the simpler family's residual requires escalation.

The result is a semantic pose seed, not a parallel stitch system.
