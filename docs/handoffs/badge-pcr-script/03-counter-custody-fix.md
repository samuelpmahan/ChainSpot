# PCR 3 — give the missing dark counters custody

The previous checkpoint showed that the dark counter components were already present in the live dark-component evidence but were omitted from the physical badge ownership.

This experimental sidecar changes only that custody decision:

- start from the same badge-stage masks, labels, components, and digit boxes;
- retain the live `assembleBadgeV1()` result unchanged as the default branch;
- identify contained dark components that fall inside the already-read digit boxes, excluding the plate component itself;
- add those observed dark components to the experimental badge ownership;
- materialize and subtract again.

No truth labels are used to find the components. The digit boxes come from the live inference path. The default branch is not mutated.

On a normal 1..18 course, the newly owned dark components appear on badges `4,6,8,9,10,14,16,18`, matching the visible counters of `0/4/6/8/9`.

The intended visual effect is simple: the small black loops that survived PCR 2 disappear from the experimental subtraction while all previously owned pixels remain unchanged.
