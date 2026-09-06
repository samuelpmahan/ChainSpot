# ternary-edge

Experimental, fixed-heading **sensing** diagnostic. It never steers or tracks a path, consumes no bends, basket locations, or C2 circle; three saved Tee seeds (H3/H5/H12) are annotation-assisted, and leaves baseline behavior unchanged. `run.py` samples raw RGB tangent arrays once for each position, stores the common profile in `output/trace.json`, and applies two methods to that same data:

- **A: middle similarity.** The center reference is either a live RGB median in the central 11-pixel band or the frozen first exposed central reference at or beyond 30 px on the same ray (pre-drop ablation). Each profile reader uses samples on both sides. Similarity is `d(sample, terrainReference) - d(sample, ribbonReference)` in RGB distance units. The material classifier compares the reader pair with the reference colors; raw variation is retained; values are evidence margins, never calibrated probabilities.
- **B: transverse fit.** Over an observation window, it tries ordered movable transition offsets `(a,b)`, computes the RGB mean inside and on the two flanks, and minimizes within-region squared RGB residual. A solution that touches the window is expanded once; weak contrast, a uniform profile, a terrain-gradient-shaped profile, clipping after expansion, or missing samples produces `UNKNOWN` with a reason. Its fitted offsets are measured outputs, not a 40/50px prior.

A material state has two readings around each reader: interior+interior => `RIBBON`; terrain+terrain => `TERRAIN`; mixed => `EDGE` with polarity; unresolved/missing => `UNKNOWN`. Method B uses its fit only to classify those same expected reader locations. Raw RGB and contrast remain in the trace.

Run the complete named experiment from its directory:

```sh
./exp/ternary-edge/run.sh
```

It executes both sensing methods through the production ABFeature gateway, writes `output/gateway/trace.json`, `gateway-receipt.json`, `overlay.png`, and `receipt.txt`. Focused checks:

```sh
python3 -m unittest discover -s lib -p 'test_*.py'
```

`run_gateway.cjs` uses the archived production `compileABFeatureSet` / `executeABFeatureSet` gateway to prove descriptor gating and exact slot custody. Its operation invokes the Python sensing producer during gateway execution and records the resulting trace. The producer receives the saved raster and seeds; the wrapper is a Node diagnostic adapter. OFF has zero operations; ON has one receipt operation.

Validation also invokes the three plain-function renderer tests explicitly; unittest discovery alone runs the seven method tests. The root inspection figures and checks are in ../ternary-review.
