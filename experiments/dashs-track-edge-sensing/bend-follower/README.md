# Bend follower evidence renderer

`render.py` materializes compact, source-backed evidence views from a saved trace JSON or NPZ. It does not run sensing, sample pixels, read annotation/target files, select a winner, or draw alternate paths.

```bash
python3 render.py path/to/trace.json --source path/to/source.jpg --out output
```

Outputs are `early-h18-source.jpg` (H18 crop with the selected primary centerline, paired edges, and bend dots), `all18-graph.jpg` (full source with the selected primary graph), `focused-failures.jpg` (failure rows and bend dots), `alternate-summary.json`, and `render-manifest.json`. Geometry keys are tolerant of `centerline`/`centerLine`, `leftEdge`/`left_edge`, `rightEdge`/`right_edge`, `bendDots`/`bends`, and `edgePairs`; candidate lists may be under `candidates`, `solutions`, `paths`, or `tracks`. NPZ arrays with those names are accepted too.

The renderer preserves trace coordinates in source pixels. `render-manifest.json` records the source hash, crop box, winner identity, failure count, and explicit `annotationReads: 0` / `pixelSampling: 0` evidence.
