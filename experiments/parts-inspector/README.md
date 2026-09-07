# S1 Part inspection

The staging `/parts` page seeds PxC with exact saved S0 raster bytes and runs the
existing S1 YAML once. Selection, visibility, isolation, and framing use
`px.view.partsInspector`; those controls do not invoke Calculations.

Run from the repository root:

```sh
CHAINSPOT_BADGE_IMAGE="$PWD/experiments/dashs-track-edge-sensing/restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg" npm run build:staging
node scripts/inspect-s1-parts.mjs
npm run preview
```

Open `/parts` on the preview. The image override supplies the older `/lab/pcr`
page's required corpus input during prerendering. S0 uses its tracked image.

`receipt.json` records the actual Default run: 3 Ticks, 9 Calculations, 952 black
components, 176 white components, 18 candidates, no incomplete assemblies.
`candidate.svg` shows the first candidate with a possible loop; `candidate.png`
is that SVG rasterized at 768 density. Amber is plate material, cyan border,
white digit material, pink possible loop, and gray unselected pixels.
These roles remain provisional bounding-box assignments; no digit recognition
or final Stage 1 Badge/muted/remaining outputs are claimed.

The production staging build passed. Browser interaction remains unverified:
the supervised preview could not resolve this checkout's external dependency
links (`vite: not found`). The rendered candidate is execution evidence, not
a screenshot or proof of the browser controls.

Sam's resolved preference: selecting another result starts with every Part
visible, including Parts shared with a previously viewed result.
