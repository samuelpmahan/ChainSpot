# Badge render-first checkpoint

This is an emergency checkpoint of the badge refinement / render-first experiment. It intentionally preserves the causal state without promoting scratch machinery into LAB or engine architecture.

## Branch provenance

This branch starts from `task/frame-radial-experiment-handoff` at `139fcb9d0043dc02b075f4ecca3b397173462696`.

The badge work was developed outside LAB/ABFeature hierarchy as scratch prototypes against the object-perimeter code and annotated course corpus. Generated PNG receipts are artifacts and should not be treated as source.

## Concrete badge findings

1. Exact V1 badge ownership left visually structured residue after owned pixels were removed from the original RGB crop.
2. Badge construction was systematically under-owning dark connected components inside glyph counters/holes. Prototype-side ownership expansion consistently found and removed those components for `0/4/6/8/9` across all five tested courses. On a normal 1..18 course the affected badges are `4,6,8,9,10,14,16,18`.
3. Course-local progressive sheets separated:
   - a digit-muted frame lane;
   - normalized per-digit overlap;
   - per-number instances with a right-rail/anomaly lane.
4. Frame residue is strongly stable at the rounded corners/rim across courses.
5. Digit residue is strongly repeatable.
6. Right-rail residue varies by course/instance. It is deliberately still unexplained; current evidence does not justify calling it a digit effect, frame effect, or compositor effect.

## Residual-digit proof

A deliberately dumb detector was fit using **only leftover RGB** after:

- exact badge-owned pixels were neutralized;
- dark glyph-hole components were also neutralized;
- each digit crop was resized into one canonical normalization bbox.

Five courses: DashsTrack, Heritage, TowneLake, AlexClark, Lenard.

- samples: 135 digit occurrences
- canonical bbox: 22x29
- detector: leave-one-out nearest mean residual template
- accuracy: **130/135 = 96.3%**
- `0`: 5/5
- `1`: 50/55
- `2..8`: 10/10 each
- `9`: 5/5

All five errors were `1 -> 4`, and every one came from badge `11` (one per course).

That establishes that the leftovers preserve real digit identity rather than arbitrary visual noise. It also exposed an important normalization lesson: the canonical bbox is a coordinate frame, not an assertion that every pixel inside it should count as evidence. The `11` failures are consistent with neighboring-digit stragglers contaminating the normalized `1` crop.

### Earned overlap upgrade

Separate **alignment support** from **evidence support**:

- canonical bbox = common coordinates;
- support/mute map = pixels trusted for comparison;
- unstable / neighboring stragglers remain visible but should not automatically contribute to template distance.

This is an empirical upgrade to the overlap primitive, not an architecture decree.

## Current render-first working theory

The useful progressive badge sketch is approximately:

`observed badge ~= shared frame + variable digit + local/rail context + unexplained residual`

The important property is not that these nouns are final ontology. The useful property is the progression:

- show the whole;
- show candidate shared structure;
- show variable structure;
- show every contributing instance;
- keep anomalous instances visible;
- show what remains unexplained.

The CLI receipt should describe exactly the evidence visible in the render. Render and text should be projections of the same trace so disagreement can be machine-tested.

## Next requested experiment: real `fork.compare`

Use the badge case as a second concrete test of the render-first ABFeature/FeatureSet idea, after basket fringe/PCA/backwalk.

The smallest real comparison is:

- **default/live branch:** current badge composer / current ownership definition;
- **experimental sidecar:** residual-aware badge composer demonstrated by this checkpoint (dark digit holes + explicit frame/digit/residual decomposition, with support-aware normalization next).

Both must begin from the same named badge-stage input/checkpoint. The default stays immutable and continues downstream normally. The experimental branch is LAB-only / sidecar behavior. They compare; they do not auto-merge, select a winner, or mutate the pin.

Comparison measures should come from evidence the badge work already trusts:

- reconstruction/unexplained residual;
- support consistency;
- known digit truth only as evaluation, never inference;
- timing.

The progressive FeatureSet render should naturally read:

`shared input -> live/default decomposition | experimental decomposition -> paired outputs -> differences -> residuals`

No generic engine should be built by fiat. If the existing execution seams do not make this a genuinely small local spike, stop and write a Mise identifying the exact seam instead.

## Primitive that has actually earned reuse so far

The badge work has earned **comparison from a shared checkpoint**. In the proposed vocabulary this is approximately `fork(...).compare(...)`.

`then(...)` is ordinary existing flow and does not need a new abstraction merely for this experiment. `pin(...)` is a requirement of the surrounding execution model, but this badge spike should not invent a pinning subsystem.

The next implementation should therefore try the smallest concrete fork+compare sidecar first and let use decide whether the combinator deserves engine-level custody.

## Scratch scripts/results to preserve in the handoff bundle

Current local scratch set (not yet claimed by LAB):

- `badgeLeftoverContactSheet.mjs`
- `badgeCourseOverlap.mjs`
- `badgeGoodSheet.mjs`
- `badgeResidualDigitDetector.mjs`

Expected reproductions include:

- per-course leftover contact sheets;
- per-course good sheets (frame / digit / number+rail lanes);
- five-course residual digit detector receipt with 130/135 result;
- JSON receipts matching generated renders.

A receiving agent should get these scripts plus the annotated-image inputs or paths, reproduce them, then implement or reject the local `fork.compare` spike based on the actual live seams.
