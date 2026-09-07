# S1 badge pixel investigation

Base checkpoint: `56076112878edf4ac167d97c66f9f83082abe2b1`
Investigation handoff: `f7def1b785675f5886395aa6844c0568a1345dd3`

No S1 implementation or configuration is changed by this investigation.

## Verdict

The enclosed `UnaccountedPx` are overwhelmingly threshold-transition pixels at boundaries between already-associated semantic Parts, not unexplained interior material.

A bounded refinement is available without changing plate/digit/border/loop associations:

- preserve the existing thresholded Parts exactly as semantic cores;
- define `interiorTransitionPx = footprint - candidate.pixels`;
- attach those pixels to the Badge candidate as transition ownership rather than mutating any source Part;
- keep the outer one-pixel halo separate pending `{BadgeFootprintDefinition}`; it is a better candidate for `MutedPx` than automatic `BadgePx` because it blends outward into the map.

Do **not** silently promote this refinement. It should be an explicit Calculation/PCR experiment if S1 needs these pixels.

## Reproduction / classification method

The branch-defined masks and assembly were reproduced independently from the exact Dash's Track JPEG using the checked-in rules:

- black: `V <= 45`;
- white: `V >= 210 && OpenCV-compatible S <= 45`;
- 8-connected components, retaining singletons;
- plate geometry from `PrincipleComponentRender.yaml`;
- bbox containment relations from `badge-assembly/index.ts`;
- footprint/exterior flood fill from the investigation handoff.

The independent decoder produced 37,300 assembled candidate pixels and 39,533 footprint pixels, versus the branch handoff's 37,295 and 39,529. That 5-pixel / 4-pixel threshold-boundary difference is consistent with JPEG decoder differences and is intentionally disclosed rather than normalized away. The topology below is from the independent replay; the committed handoff remains authoritative for exact branch counts.

## 1. Enclosed residual classification

Independent replay: 2,233 enclosed residual pixels.

### RGB class

| Class | Pixels | Share |
| --- | ---: | ---: |
| Low-saturation neutral transition, failing both masks | 2,217 | 99.28% |
| Slightly chromatic transition, failing both masks | 16 | 0.72% |
| Still satisfies black threshold | 0 | 0% |
| Still satisfies white threshold | 0 | 0% |

The 16 slightly chromatic pixels are also boundary values: RGB examples include `(36,39,46)`, `(46,49,56)`, `(37,40,49)`, `(45,48,57)`. Their value is just above the dark cutoff and/or their saturation is just above the white saturation cutoff. They are not a separate material family.

Residual value quantiles (`V=max(R,G,B)`):

- min 46
- 25% 83
- median 118
- 75% 174
- 99% 208
- max 209

That is almost exactly the unclassified gap between the dark and bright thresholds.

### Geometry / adjacency

Every one of the 2,233 residual pixels is within one pixel of an already-owned semantic Part.

Using 8-neighbor adjacency:

| Adjacent Parts | Pixels | Share |
| --- | ---: | ---: |
| plate + digit | 1,288 | 57.68% |
| plate + border | 803 | 35.96% |
| digit + loop | 139 | 6.22% |
| digit only | 2 | 0.09% |
| plate only | 1 | 0.04% |

So 2,230 / 2,233 residual pixels sit directly at a boundary between two semantic Parts. This is strong structural evidence for antialias/transition ownership rather than arbitrary missing material.

2,032 / 2,233 (91.0%) lie inside the dark plate bbox. The rest occur in the border/rounded-corner region.

## 2. What the current footprint denominator misses

The current footprint is intentionally closed by the detected white border, so it cannot count pixels immediately *outside* that border.

Inspecting the one-pixel exterior ring adjacent to the border found approximately 3,548 pixels on the independent replay:

| Exterior one-pixel ring class | Pixels | Share |
| --- | ---: | ---: |
| neutral transition | 3,539 | 99.75% |
| chromatic transition | 8 | 0.23% |
| dark threshold | 1 | 0.03% |
| white threshold | 0 | 0% |

The ring is extremely regular (roughly the perimeter-sized ring expected around every badge) and overwhelmingly grayscale. It is therefore visually part of the badge edge/shadow/AA system, but the current measurement excludes it by construction.

This means the existing 94.34845% number answers a narrow question correctly:

> how much of the **border-enclosed footprint** is already represented by thresholded semantic Parts?

It does **not** answer:

> how much of every visually badge-related pixel, including the outward blended edge, is represented?

The latter requires a product/semantic decision for `{BadgeFootprintDefinition}`.

## 3. Bounded ownership refinement

### Safe interior refinement

The least invasive experiment is not to dilate plate/digit/border/loop Parts independently. Independent dilation would create collisions exactly where the evidence says the missing pixels live.

Instead:

```text
semanticCorePx       = union(plate, border, digits, digitLoops)
interiorTransitionPx = footprint - semanticCorePx
candidateBadgePx     = semanticCorePx ∪ interiorTransitionPx
```

Properties:

- deterministic;
- bounded by the already-detected enclosing border;
- preserves every existing Part and relation unchanged;
- cannot swap digit/plate/border identity;
- gives transition pixels explicit provenance instead of pretending a threshold produced them;
- closes the current internal footprint to 100% by definition.

If downstream consumers need semantic sub-Part ownership, keep `interiorTransitionPx` as a separate candidate-owned Part. Do not force tie pixels into one neighbor merely because it is nearest: most are jointly adjacent to two semantic Parts.

### Outer halo

Do not automatically fold the exterior one-pixel ring into `BadgePx` in the same experiment.

Recommended first interpretation:

- enclosed transition => Badge-owned transition material;
- exterior transition => `MutedPx` candidate / edge halo pending human review.

That keeps map/background blending out of strict BadgePx while still allowing S1 subtraction to remove visually badge-related edge pixels if that is useful downstream.

## 4. Tradeoffs / falsifiers

A future registered experiment should be rejected if any of these occur:

- candidate footprints overlap or claim pixels from another badge;
- digit recognition changes because semantic Part identities were mutated;
- plate/border/digit/loop relation counts change;
- exterior halo expansion consumes meaningful map material rather than only the regular badge edge;
- downstream S2+ behavior regresses when transition pixels are subtracted.

The interior refinement is much lower risk than outer expansion because the enclosing border already establishes the ownership boundary.

## 5. Answer to the investigation questions

1. **Classify unaccounted pixels:** yes. They are overwhelmingly one-pixel threshold transitions at semantic Part boundaries; not a new unexplained material class.
2. **Inspect excluded outer edge:** the denominator omits a regular ~1 px neutral halo around the detected border. It is visually badge-related but semantically ambiguous.
3. **Bounded refinement:** yes. Add candidate-owned `interiorTransitionPx` without mutating plate/digit/border/loop Parts. Treat exterior halo separately.
4. **Experiment discipline:** no refinement was promoted here. A future implementation should be a registered Calculation/PCR override with Default retained.
5. **Human review:** the existing `badge-pixel-coverage.png` remains the representative overview. The decisive additional finding is the adjacency table above; the residual is concentrated exactly at plate↔digit, plate↔border, and digit↔loop boundaries.

## Recommendation

Do not block digit recognition on this.

For current S1 progress, the semantic component assembly is already explaining the badge structure very well. Finish digit recognition/final S1 contract first. If downstream residue/subtraction quality makes these pixels matter, the smallest next experiment is `interiorTransitionPx` as an explicit candidate-owned transition Part, with exterior halo kept separate.
