# Object Perimeters V1 — Component Assembly Probe

Pinned on `experiment/object-perimeters-v1` from `frozen108/posterior-tee-recovery`.

## Contract

V1 does not infer, dilate, fit, or redraw object masks.

- Badge outside is bright/white: accepted bright badge-family component is the outer component; merge the contained dark plate component and bright glyph components.
- Tee outside is bright/white: accepted intact tee-family frame component is the outer component.
- Basket outside is dark/black: accepted 42×66 bright body component merges with the smallest enclosing dark component only when that dark component belongs to the intact modal shell component family.
- Overlap/recovery ambiguity is a named V1 failure. Do not split a fused connected component or synthesize missing perimeter pixels in V1.
- Canonical bbox is the union of the owned connected components. Canonical perimeter is the connected perimeter of the designated outer component.

## Local six-course probe

Source: frozen Dev6-106 run artifacts already emitted by LAB (bright/dark masks, bright component set, tee candidate set, run receipt/VisualRender). The probe did **not** rerun HSV thresholding or detector candidate discovery.

Every local command was hard-capped at 55s; the full six-course component assembly + VisualRender run completed in about 11s.

| Course | Badges assembled | Badges fail | Baskets assembled | Baskets fail | Intact tees assembled | Tee overlap/recovery fail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AlexClark | 16 | 2 | 15 | 3 | 13 | 4 |
| DashsTrack | 18 | 0 | 16 | 2 | 15 | 3 |
| HeritagePark | 14 | 4 | 7 | 11 | 14 | 3 |
| Lenard | 16 | 2 | 12 | 6 | 17 | 1 |
| NorthPark | 16 | 2 | 13 | 5 | 16 | 2 |
| TowneLake | 18 | 0 | 14 | 4 | 17 | 1 |

The useful breakage is overwhelmingly where expected:

1. **Recovered badges**: dark-plate recovery has no trustworthy intact outer white CC. V1 refuses it.
2. **Recovered/occluded tees**: no intact outer white CC. V1 refuses it.
3. **Baskets expose the interesting component-fusion problem**: the 42×66 white body often survives while its black shell CC is fused into C1/C2 furniture or basemap darkness. The first naive pass proved why refusal matters by claiming huge unrelated dark regions as Basket. V1 now accepts only the exact modal intact shell component family and makes every fused/nonmodal shell a visible failure.

The intact basket shell family emerged directly from the components as margins `[left=2, top=3, right=2, bottom=3]` around the 42×66 bright body (46×72 outer dark component). This is used as an exact family identity in V1, not a tolerance band.

## What V2 is allowed to solve

Only the explicit failed cases above. In particular, V2 may split/attribute a fused component using object/occlusion evidence. It must not weaken V1 by teaching clean objects to accept arbitrary nearby pixels.
