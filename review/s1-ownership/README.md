# S1 ownership checkpoint

Entry: packages/alg/src/stages/S1/exp/badge-assembly/stage.ts.
Composition: PrincipleComponentRender.yaml in the same directory.
White recognition: white-recognition.ts. Ownership: ownership.ts.

Reproduce from the repository root after installing dependencies:

```sh
npm run build --workspace @chainspot/alg
node scripts/render-badge-ownership.cjs review/s1-ownership/source.png /tmp/s1-ownership-review
```

source.png is the cropped Dash's Track raster used for the saved receipt and render.
The receipt's source path records its original scratch location; use the checked-in fixture instead.

Observed: 18 numbered badges; 37,295 component pixels; 3,949 additional
UnaccountedButOwned pixels; 2,645,826 remaining; total 2,687,070.
The script asserts a disjoint exhaustive raster partition and full bbox exclusion.
These checks prove accounting, not that every assigned pixel is semantically correct.

Cyan is component material; pink is UnaccountedButOwned; yellow is the border bbox.
The 8px exterior margin is inspection-only. The entire border bbox is excluded;
queryBadgeMutedPixels returns that full footprint, whereas px.badges.muted stores
only the additional pixels outside the global explained-component union.

Refinement must preserve Badge identity, source coordinates, existing constituent
Parts, and visibility of unexplained interior and exterior residue. White recognition
is the continuing default. Inspect actual source colors alongside the overlays.

Earlier experiments: review/s1-digit-experimentation-116c984 at
116c98452c53da57a2599278db1848e2c703ad3f (review/digit-experimentation/README.md).
Earlier pixel investigation: investigate/s1-badge-pixels-5607611 at
f7def1b785675f5886395aa6844c0568a1345dd3.

Still pending before landing: downstream contract-consumer compatibility, browser
PartInspector numbers/ownership display, and removal of positional final-output
assumptions in scripts/inspect-s1-parts.mjs. S1 is not frozen or deployed.
