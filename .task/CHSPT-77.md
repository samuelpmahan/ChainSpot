# CHSPT-77 — Minimal correspondences and arbitrary-layout semantic pose graph

## Goal
Measure semantic landmark edges as a cheap supplier to the existing arbitrary-layout pose-graph architecture, and establish the minimum landmark evidence required to trust translation or identify similarity/affine transforms.

## Required behavior
- Reuse CHSPT-75 source landmarks and CHSPT-76 pairwise voter unchanged.
- Build all-pairs semantic edge probes for arbitrary N sources and weight accepted edges by independent inliers, family diversity, RMS residual, and runner-up ambiguity.
- Reuse poseGraph.ts's strongest-seed + maximum-weight Prim topology shape rather than inventing a second production graph.
- Report graph connectivity, accepted semantic edges, spanning-tree placement edges, source transforms, and pairwise cases that remain candidates for generic pixel matching.
- Empirically distinguish 1 / 2 / 3+ correspondence evidence and fit the simplest transform first, escalating only when residual requires it.

## Non-goals
- No mutation of buildPoseGraph, cvMatch, stitchPipeline, rendering, or production stitch behavior.
- No OpenCV lifecycle work beyond comparison to the current matcher/pose-graph baseline.
- No Annotate Course handoff.

## Known context
- poseGraph.ts already owns all-pairs topology, strongest aggregate seed, maximum-weight spanning tree, selected-edge escalation, fusion, and abstention. Semantic work is an edge supplier/confidence experiment around that architecture.
- The continuous research branch remains based on prestaging/demo @ ba59447ac20dd6b680d627c37a561638956d7c3d by explicit task instruction.
- CHSPT-76 defaults to two independent inliers, so rejected one-inlier pair probes are expected semantic abstentions rather than detector failures.

## Acceptance
- Arbitrary-N semantic graph construction with explicit connected/disconnected outcome and per-edge confidence diagnostics.
- Measured evidence contract: one point is a translation hypothesis only; two separated points verify translation and identify similarity; three non-collinear points identify affine.
- Simplest-family fitting stays at translation whenever translation residual is already acceptable.
- Disconnected or ambiguous semantic evidence is surfaced as requiring generic pixel evidence for placement; connected semantic graphs do not need pixel matching merely to repeat the same translation work.
- Runtime scaling is measured separately from raster localization.

## Proof Plan
- Unit-test connected and disconnected arbitrary-layout graphs using the same semantic voter as CHSPT-76.
- Unit-test one-point translation hypothesis, two-point translation verification/similarity escalation, and three-point affine escalation on synthetic correspondences with known transforms.
- Run all-pairs graph construction on the same detector-backed real UDisc crop fixture from CHSPT-75/76; compare semantic topology/transforms against exact crop truth.
- Construct a real-raster one-shared-landmark case and prove semantic abstention rather than a confident false placement.
- Measure point-graph runtime across N=2/4/8/16/24 synthetic translated-source batches to expose the expected all-pairs O(N^2) scaling independently from localization cost.
