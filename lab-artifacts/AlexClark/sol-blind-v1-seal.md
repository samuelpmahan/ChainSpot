# AlexClark blind-pass seal

Recorded before visually inspecting the AlexClark cropped raster or grid.

## Allowed input

- `lab-artifacts/AlexClark/AlexClark-cropped.png`
- `lab-artifacts/AlexClark/AlexClark-cropped-grid.png`
- Renderer facts learned from source and from the fully annotated DashsTrack reference.

## Refused inputs until after the blind-pass commit

- `/home/mahansa/workspace/chainspot-corpus/dev/AlexClark/AlexClark-full.annotation.json`
- Any other AlexClark annotation, truth, registration, or ground-truth file.
- `resources/nuthing-p2/registered-annotations.json` and any registered annotation resource that may contain AlexClark.
- `resources/nuthing-p2/badges/crops/AlexClark-*` (filenames were enumerated during inventory; image bytes were not opened).
- AlexClark entries in recovered-tee resources, endpoint caches, pair matrices, assignment snapshots, support fields, or replay caches.
- AlexClark runs and objects in `/home/mahansa/workspace/chainspot-lab-evidence`.
- Previous evaluation reports, overlays, contact sheets, and notes containing AlexClark endpoint, bend, width, ownership, or assignment answers.
- Output from `pair-matrix.ts`, endpoint detectors, badge detectors, bend detectors, corridor-width estimators, assignment/replay commands, and current Lab races when run on AlexClark.

The only AlexClark bytes used for the first pass will be the automatically cropped source raster and the coordinate-grid overlay derived from it.
