# S1 badge right-side residue drilldown

Branch checkpoint: `lab/pxc-root-mounts` after grouped same-number overlap.

## Question

After muting glyph/number regions and rounded corners, the grouped overlap still showed a vertical red strip on the inner-right side of badges 10, 12, 13, 14, 15, 16, and 17. This drilldown traced that overlap back to each actual source badge instead of inferring from the averaged projection.

## Result

The right-side feature is not an overlap artifact. On every visible contributing badge it is one connected residual component exactly **1 x 24 px** in the source raster.

Its location is nearly invariant in badge-local coordinates:

- y = `top + 9`
- height = `24`
- x = `right edge - 2` or `right edge - 3`
- width = `1`

The component is defined using the same projection semantics as the muted overlap:

1. start with the row-filled outer bright border footprint;
2. subtract current Badge-owned pixels;
3. mute pixels within 2 px of glyph material;
4. mute the rounded-corner neighborhoods;
5. keep residual components touching the surviving outer-border pixels;
6. classify the component by nearest badge side.

This produced a right-side component for the following actual source instances.

| Number | Visible contributing courses | Common local bbox |
| --- | --- | --- |
| 10 | AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake | `[53,9,1,24]` |
| 12 | AlexClark, DashsTrack, NorthPark, TowneLake | `[51,9,1,24]` |
| 13 | AlexClark, DashsTrack, Lenard, NorthPark, TowneLake | `[51,9,1,24]` |
| 14 | AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake | `[53,9,1,24]` |
| 15 | AlexClark, DashsTrack, Lenard, NorthPark, TowneLake | `[51,9,1,24]` |
| 16 | AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake | `[52,9,1,24]` |
| 17 | AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake | `[51,9,1,24]` |

Numbers 1-9, 11, and 18 did not produce this right-border-touching component under the same filtering.

## Actual image locations

### 10

- AlexClark `[437,422,1,24]`
- DashsTrack `[220,1539,1,24]`
- Heritage `[991,1047,1,24]`
- Lenard `[715,536,1,24]`
- NorthPark `[244,713,1,24]`
- TowneLake `[648,416,1,24]`

### 12

- AlexClark `[560,145,1,24]`
- DashsTrack `[399,1628,1,24]`
- NorthPark `[547,745,1,24]`
- TowneLake `[594,910,1,24]`

Heritage and Lenard are dark-plate-recovery instances and therefore do not contribute visible outer-border evidence to this projection.

### 13

- AlexClark `[845,91,1,24]`
- DashsTrack `[596,1519,1,24]`
- Lenard `[238,1367,1,24]`
- NorthPark `[902,962,1,24]`
- TowneLake `[283,1041,1,24]`

Heritage is a dark-plate-recovery instance.

### 14

- AlexClark `[852,187,1,24]`
- DashsTrack `[729,1410,1,24]`
- Heritage `[1039,1489,1,24]`
- Lenard `[250,1544,1,24]`
- NorthPark `[727,955,1,24]`
- TowneLake `[328,1099,1,24]`

### 15

- AlexClark `[710,213,1,24]`
- DashsTrack `[930,1261,1,24]`
- Lenard `[231,1843,1,24]`
- NorthPark `[701,1024,1,24]`
- TowneLake `[312,1309,1,24]`

Heritage is a dark-plate-recovery instance.

### 16

- AlexClark `[674,558,1,24]`
- DashsTrack `[1165,950,1,24]`
- Heritage `[970,1579,1,24]`
- Lenard `[318,1655,1,24]`
- NorthPark `[922,1152,1,24]`
- TowneLake `[471,1634,1,24]`

### 17

- AlexClark `[600,774,1,24]`
- DashsTrack `[989,906,1,24]`
- Heritage `[581,1616,1,24]`
- Lenard `[389,1625,1,24]`
- NorthPark `[974,1232,1,24]`
- TowneLake `[956,1655,1,24]`

## Interpretation

The grouped bar is therefore a real repeated geometry, not a blur caused by averaging multiple badges. The exact `1x24` shape and near-identical local placement strongly indicate a deterministic ownership gap at the inner-right transition between the row-filled outer-border footprint and the currently assembled Badge material.

This is still an investigation result. It does **not** promote those pixels into Badge ownership or change S1 behavior.
