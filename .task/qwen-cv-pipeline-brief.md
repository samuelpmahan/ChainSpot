# ChainSpot CV pipeline review brief

You are reviewing a browser-first disc-golf mapping pipeline using text evidence only. You cannot inspect the source images. Do not invent visual observations. Treat the facts below as the complete evidence set and clearly distinguish facts, inferences, and proposals.

## Product objective

ChainSpot turns UDisc screenshots into editable semantic course and played-round data. The immediate MVP is deliberately narrow: one real played-round screenshot must produce one correct, editable throw route for one hole. The route consists of a known hole identity, tee, ordered landing points/throws, and basket, and must enter the existing production round model. Automatic output is always a proposal. The operator must be able to correct hole assignment, landing coordinates, and shot order without restarting.

Final broadcast graphic design is a separate later gate. A valid PNG is not proof of product success, and this review must not expand into graphics design.

## Input and coordinate pipeline

1. A user supplies course screenshots. Inputs may be a single overview or multiple overlapping/rotated captures. Phone/app chrome may be present.
2. Crop/stitch produces a course-source raster. Exact source lineage records original captures plus crop/affine transforms so the annotation raster can be reconstructed and verified by SHA.
3. Repeated UDisc UI sprites are preferably detected in each unwarped source raster, then transformed/merged into composite coordinates. If detection must happen in composite space, the finite contributing source transforms constrain plausible sprite pose. Arbitrary angle/scale searches are discouraged when provenance provides pose.
4. Course annotation establishes hole number/badge, tee, basket, corridor width, and zero or more ordered corridor bends. The operator can add/correct geometry manually.
5. A separate thrown-round screenshot is preserved as a distinct semantic input and carried with the completed course into Create Graphics. It never replaces the clean course source.
6. The operator registers played-round pixels to clean-course pixels with stationary landmark correspondences. Similarity needs two usable pairs; affine needs three non-collinear pairs. Disabled/removed pairs are immediately excluded. Residuals and a live played-to-clean preview expose bad registration. The operator explicitly confirms a usable registration, which remains correctable.
7. Existing clean-course-to-target alignment can compose with played-to-clean for a target proof, but extraction semantics remain in clean-course/source pixel space.

## Current course CV philosophy

- CV accelerates annotation; it is not a gatekeeper.
- Tee, basket, corridor, and other low-confidence/missing results must be manually recoverable, including zero-detection cases.
- Manual edits must not be overwritten by later automatic results.
- Detector evidence/confidence stays in proposal/review state. Once accepted into the production artifact, geometry is authoritative and does not carry a `source=cv` or confidence field.
- Course truth distinguishes semantic endpoint location from pixel evidence: `visible`, `no-visual-evidence`, and `ambiguous`. A semantically known but visually absent endpoint is excluded from raw detector recall rather than counted as a false negative or rewarded as a hallucinated detection.
- Known basket difficulty is separating tiny real glyphs from title text, number fragments, map controls, watermark text, and terrain components without course-specific masks/coordinates.
- Diagnostics must preserve the exact evidence responsible for accepting or rejecting candidates.

## Evaluation contract

- Split unit is course + selected layout + capture artifact; holes or variants from one acquisition never cross splits.
- Development set: Dash's Track, Alex Clark, Heritage, North Park.
- Iterative validation and sealed release sets span Texas, Pacific Northwest, Arizona, and Colorado; 18-27 holes; open, forest, desert, elevation, and dense layouts.
- Capture conditions intentionally vary instead of enforcing one laboratory recipe.
- Sealed pixels/truth stay outside normal development checkout.
- Every scored raster must be reproducible from original captures and provenance.

## Played-round detector already demonstrated

The played screenshot contains UDisc landing-droplet pins. Production code ports an existing real-round experiment:

1. Decode the original held screenshot at full resolution.
2. Convert RGBA -> RGB -> HSV in OpenCV.
3. Threshold stable saturated UDisc marker blue.
4. Run connected components.
5. Filter for vertically elongated pin-like components using coarse size bounds plus resolution-relative bounds.
6. Find a dominant recurring component-area cluster to reject small inconsistent UI fragments.
7. Treat the semantic landing as the bottom-most pin tip, averaging the bottom two rows for stability, not the component centroid.
8. Classify the interior glyph as C1, C2, or off-fairway by Dice overlap against one bundled canonical mask per class. `glyphConfidence` is a shape similarity score, not a calibrated probability.
9. Components plausibly representing two merged/overlapping droplets are not split. They become `DeferredOverlapRegion` records with bounds/area/reason.

On the available real-round fixture, the production browser path reproduced four landing proposals and zero deferred overlaps. This proves one fixture, not generalization.

## Semantic proposal path

- Each detected tip is transformed played -> clean through the confirmed registration.
- Hole suggestion computes distance from the clean point to each annotated hole corridor centerline and only suggests a hole inside a corridor-width-derived bound.
- The detector does not infer chronology. Shot order is explicit review data.
- Acceptance calls the existing production `addShot`/`reorderShot` path. Accepted shots become ordinary editable `OrderedShot` values.
- Browser proof accepted two proposals, reassigned/reordered them, and edited a landing coordinate.

## Confirmed implementation defects found during review

These are pipeline implementation bugs, not evidence against the detector concept:

1. A confirmed played-to-clean transform can survive opening/replacing the clean source. The stored `cleanImageId` is not enforced at the review mount, so old-round evidence could be mapped into a new project's holes.
2. Multiple proposals for one hole snapshot the same default order. Sequential acceptance can reverse chronology.
3. Acceptance/editing lacks bounds validation and catches no production `setHoles` error. An out-of-bounds transformed point or manual value can throw without useful UI feedback; clearing a numeric field becomes zero.
4. Deferred overlaps are currently shown only as a count, with no recovery action.
5. If a proposal's hole id becomes stale, `addShot` can no-op while the UI removes the proposal, silently losing evidence.

## Renderer/compositing research (supporting evidence, not production CV)

An experiment ticket models UDisc's renderer explicitly:

- Hard sport priors: C1 is 10 m from basket, C2 is 20 m, so world radii are exactly 2:1 before rasterization error.
- Map geometry scales continuously with zoom; basket and number sprites are approximately screen-space; strokes are closer to screen-space; dash rendering may reset discretely by zoom bucket.
- Candidate layers include satellite raster, C2/C1 fills and boundaries, corridor fills/strokes, tee, basket, badges, and paths.
- Standard source-over alpha compositing is the initial hypothesis.
- Tunable colors, alpha, stroke/dash properties, sprite sizes, priors, tolerances, layer order, and residual weights belong in explicit config with provenance, not magic numbers.
- The research loop proposes a falsifiable renderer hypothesis, renders expected pixels, inspects residuals/overlaps, and keeps or rejects the change.
- This research must not become a prerequisite for the MVP played-round path unless evidence shows it materially improves extraction.

## Known cautionary evidence

- A played-round overview with chrome, blue droplets, and a purple path once caused the generic course detector to find 1/1 visible number but 0/18 tees and 0/18 baskets. This showed that re-running clean-course recognition on a played screenshot was the wrong dependency; known course geometry plus explicit registration is now the intended path.
- One canonical glyph template per landing class and fixed HSV/shape thresholds are demonstrated only on current fixtures. They are not calibrated across the representative corpus.
- Full-resolution main-thread OpenCV can become a responsiveness/memory risk.
- Registration error, detector localization error, and semantic assignment error are currently different stages but need independently measurable error budgets.

## Your assignment

Give an evidence-based architecture review, not a rewrite proposal.

1. State whether the overall separation is sound: provenance/registration -> pixel observations -> semantic proposals -> editable authoritative state.
2. Identify the five most important hidden assumptions or coupling risks, ranked by expected MVP impact. Separate detector risks from workflow/state risks.
3. Define the smallest useful error budget and metrics for registration, localization, classification, hole assignment, ordering, and final semantic correctness.
4. Propose the next three falsifying experiments using existing fixtures/corpus rules. Each experiment must state hypothesis, fixture/split, metric, pass/fail threshold, and what decision changes based on the result.
5. Say which parts should remain explicit heuristics/configuration for the MVP and which, if any, justify learned models later.
6. Evaluate whether renderer-forensics should feed the played-round extractor now, later, or not at all, and name the exact evidence that would change your answer.
7. Recommend a productionization order limited to the next 2-4 implementation steps. Manual recovery and editable semantics are non-negotiable.

Be direct. Flag insufficient evidence. Do not recommend indefinite CV research, GPS/native integrations, or broadcast-graphics design.
