# CHSPT-79 — Source landmark fusion/provenance → Annotate Course

## What CHSPT-51 already solved

CHSPT-51's `sourceSpaceDetection.ts` detects in each unwarped source and maps each `CompositeObservation` through that source's existing `SourceTransform`. This ticket does **not** create another transform path.

## New contract

`SourceLandmarkHandoff` adds only the information the generic transformed observation lacks:

- semantic identity (`kind` + stable landmark id);
- an explicit expected-landmark set, so absence is meaningful;
- exact composite identity, so evidence cannot be accidentally paired with another stitch;
- every contributing source observation, including the original source-space candidate and detector score.

`resolveSourceLandmarkHandoff` then produces either:

- a provenance-preserving fused composite landmark; or
- an explicit per-landmark fallback request (`missing-source-observation` or `source-disagreement`).

Overlapping source observations are fused only when they agree geometrically. Conflicting observations abstain; they are never averaged into a plausible-looking wrong basket.

## Basket invariant

A blanket composite basket detector may be skipped only when the handoff explicitly declares the expected basket set and **every expected basket is resolved from source evidence**. Seeing one source basket is not enough to suppress the detector for the rest of the course. A missing/occluded basket remains an explicit fallback item.

This is the evidence contract Annotate Course should consume. The current historical composite detector remains a fallback implementation, not the primary source of truth.
