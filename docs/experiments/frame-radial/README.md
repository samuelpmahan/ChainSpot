# Frame + RadialRender Experiment Substrate — Patch Ladder

Branch: `task/frame-radial-experiment-substrate`
Base: `experiment/object-perimeters-v1`

## Why this branch exists
Two workers should be able to start cold, apply the same small conceptual steps, stop at any checkpoint, and independently challenge the next step without reconstructing the research from chat.

Apply patches in order. Read the matching `EXPECT.md` **before** applying each patch and verify its checkpoint **before** moving on.

## Research context in one page

1. Object-perimeter V1 established exact connected-component custody: base objects own only their own measured pixels; overlap/recovery may fail loudly rather than falling back to a detector bbox.
2. On Dashs, post-G4 clean acquisition reproduced the expected 18 badges / 16 clean baskets / 15 clean tees, with two basket failures at overlaps.
3. A recovered rear basket could be approximately reconstructed by subtracting the known foreground basket from fused evidence. The residual disagreement exposed pixels that black+white connected-component ownership would never have told pathfinding to ignore.
4. Across 77 clean baskets from 6 courses, alignment by the stable 42×66 inner body/boundary produced a sharp canonical basket. Binary black+white ownership is ~2147 px median; a first influence estimate suggested roughly ~232 additional repeatable basket-affected fringe pixels. The earlier 59 px number was only one Dashs overlap-disagreement subset and must not be mistaken for the whole fringe.
5. We do **not** want to overfit a perfect sprite explanation. A conservative base model plus understandable adaptation is preferred.
6. The emerging research primitive is a `Frame`: a named, composable way to re-express evidence before comparison. Examples include semantic origin, true-north orientation, incoming-evidence orientation, raw RGB, luminance, exact-color relation, and course residual.
7. Critical human constraint: if an error collapses under one frame but survives another, that must remain understandable textually and/or visually. The experiment should produce explanatory structure, not require an LLM to invent a story afterward.
8. `RadialRender` is the first shared human projection primitive: TrueNorth and angled influence should be two views over the same radial base.

## Do not overconstrain
This branch is a skeleton checkpoint. The goal is not to decide the final Frame ontology, PCA API, loss algebra, SmartGridSearch strategy, or VisualRender layout. Make the seams explicit and falsifiable; let experiments earn the next abstractions.

## Desired parallel-work pattern
- Both workers apply 0001 and verify the base.
- Both apply 0002 and critique the Frame seam independently.
- Both apply 0003 and critique the RadialRender seam independently.
- Divergence after a checkpoint is welcome; report what assumption caused it.
- Preserve rich observables before reducing them to winners/scalars.

## Human-readable success test
A future result should be able to say something like:

> Spatial normalization barely changed the error. Course-residual normalization removed most of it. Incoming-direction alignment removed most of what remained.

…and show the same story visually without requiring the owner to understand PCA internals.
