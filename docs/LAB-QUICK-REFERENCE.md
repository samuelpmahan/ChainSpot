# ChainSpot LAB quick reference for agents

LAB is the inspection and execution surface around the real ChainSpot engine. It is not a second CV implementation.

## The mental model

```text
raw image(s) -> StripChrome -> AutoStitch -> canonical raster
                                     |-> Scope / Search / Traverse
                                     `-> Sweep -> engine trace + renders + receipts
```

- `scope`, `search`, and `traverse` inspect pixels and geometry. They do **not** run detectors.
- `sweep` is the only LAB command that executes an algorithm plan.
- Coordinates used downstream are canonical coordinates. Read each artifact's `.png.json` sidecar before translating back to a source image.
- Detection/localization and ownership are separate conclusions. Never turn `ownership: UNKNOWN` into a detection miss.

## Start here

```bash
./lab --help
./lab help here              # read-only context + safe next commands
./lab help scope path        # exact leaf help
./lab help --all             # exhaustive reference
./lab set courses
./lab set DT                 # DashsTrack
./lab set                    # show persisted context
./lab scope h1               # blind course viewport
```

Run `./lab setup` only when a fresh checkout lacks LAB dependencies. Use Linux/WSL Node and Git paths.

## Inspect without running the engine

```bash
./lab scope h3
./lab scope IMAGE 735,711
./lab scope IMAGE 703,679,64,64
./lab scope mark IMAGE candidate 735,711
./lab scope dots IMAGE corners 718,691 759,704 750,734 709,722
./lab scope path IMAGE perimeter 718,691 759,704 750,734 709,722 718,691
./lab scope full IMAGE
```

The default render is Context -> Local -> Forensic Wide/Mid/Tight. Useful tuning:

```bash
--context 240 --local-extra-w 40 --local-extra-h 40
--fw 96 --fm 48 --ft 24 --forensic-out 320 --no-grid
```

`scope hN` uses the configured blind viewport. `scope hN --truth` is explicitly truth-assisted, logs `TRUTH-TAINT`, and is forbidden in blind/test runs. Never add `--truth` merely because a blind view is inconvenient.

## Remember or navigate an investigation

Use Search when evidence must persist across views; use Traverse when you want controlled spatial movement.

```bash
./lab search start IMAGE trail 735,711 --page scratch
./lab search add trail 760,700
./lab search pin suspect 735,711 --style diamond --page scratch
./lab search keep suspect
./lab search page show scratch IMAGE

./lab traverse start IMAGE walk 735,711 --page scratch
./lab traverse go walk 2
./lab traverse go walk --xy 40,-25
./lab traverse go walk --polar 110,330
./lab traverse back walk
```

Search state is persistent. For a disposable or agent-isolated session, prefix every command with:

```bash
LAB_SEARCH_STATE=artifacts/my-investigation/search-state.json
```

Image-coordinate headings are `0 deg` right, `90 deg` down, `180 deg` left, `270 deg` up.

## Run the real engine

```bash
./lab compile CONFIG.json
./lab sweep --through G3 CONFIG.json IMAGE [TRUTH.json]
```

- `compile` inspects the plan; it does not execute raster work.
- `--through` currently accepts only `G1`, `G2`, or `G3`. The canonical engine order continues with `G4` Endpoint Recovery, `G5` Straight Test, `G6` Assignment, and `G7` Bend Refinement; `shared-set` is infrastructure, not a scheduled gate. There is currently no `--stop-after`.
- A positional JSON after inputs is evaluation truth, not detector input.
- An official scoreboard requires verified truth in the canonical execution frame. Dimensions-only or unmapped truth is skipped with an explicit reason.
- Repeating the same config/input normally reuses the same artifact directory, so copy evidence you need to preserve before another run.

For a corpus census, use the batch command. It expands selectors into manifest-backed cases and invokes the real Sweep once per case:

```bash
./lab sweep batch CONFIG.json dev                 # defaults to G3
./lab sweep batch --through G3 CONFIG.json demo
./lab sweep batch --through G3 CONFIG.json all
./lab sweep batch --through G3 CONFIG.json Dashs TheRec
LAB_BLIND_TEST=1 ./lab sweep batch --through G3 packages/alg/src/detectors/threeFactor/configs/default.json dev demo
```

`--through` is optional for batch and defaults to `G3`; only `G1`, `G2`, and `G3` are valid. `dev`, `demo`, and `all` are selector groups; individual course names and unambiguous aliases are also accepted, and omitting selectors means `dev`. Multiple selectors are combined without duplicate courses. The REC's `TheRec-L.PNG` and `TheRec-R.PNG` captures are one `stitched` multi-input case that runs StripChrome → AutoStitch; `clean-full` and `thrown-full` are separate single-input cases. Batch never loads Annotation truth implicitly, continues after a case failure, exits nonzero if any case fails, and prints deterministic per-case `START` and `DONE`/`FAIL` progress before the final aggregate. A normal single-image `./lab sweep` is unchanged.

Each case writes normal Sweep evidence below `artifacts/sweep/<config>/batches/<course>/<case>/`. The batch root also receives compact `summary.txt` and machine-readable `summary.json` aggregate receipts; these generated artifacts are run evidence and are not source files to commit.

The aggregate schema is stable and ordered: course, case, inputs, badges, baskets, raw rings, pre-family tees, visible tees, visible deficit, operations/runtime, conformance drift, and status. Metric provenance is printed in `summary.txt` and repeated per successful row in `summary.json`: badge/basket counts are accepted drawables from their named trace units; raw rings are accepted plus rejected `tees` drawables; pre-family tees are accepted `tees` drawables after G3 exclusion; visible tees are accepted `teeFamily` drawables; visible deficit is `max(0, badges - visible tees)`; operations are engine receipt count; runtime is the sum of receipt `durationMs`; conformance drift counts receipts whose actual consumes/produces omit a declared slot. `durationMs` is deliberately volatile and should be compared only as a run measurement.

Read the engine-produced receipt and render together. A useful receipt answers: what object was considered, where it is in original and canonical frames, measurements, verdict/reason, detected/expected counts, FP/FN when truth exists, and unowned detections separately.

## Pixel-work tips and traps

- Treat bright and dark masks plus both connected-component maps as shared evidence; optimize duplicate labeling, not "black first" versus "white first."
- Keep detector-local geometry (`whiteBbox`, ring interior, search margin) separate from the semantic sprite perimeter consumed downstream.
- A crop or stitch does not invalidate known geometry. Apply the recorded transform before rejecting coordinates.
- Today, `path`, `dots`, and annotation-hole forensic panels anchor on the second-to-last point; verify the sidecar instead of assuming the final point is the forensic target.
- A rendered mask is already canonical evidence. Feeding it back into `scope` may run StripChrome again; inspect the new sidecar insets and translate (`x' = x - left`, `y' = y - top`) or inspect the original course raster instead.
- Rejected candidates must remain visible with their rejection reason. A clean-looking render with silent drops is not proof.
- The browser workbench is `./lab ui` (default `127.0.0.1:4317`). It should consume the same operation results as CLI, never rerun detector math in the renderer.

When confused, run the nearest command's `--help`, choose the smallest representative crop, make one hypothesis visible, and only then run the smallest necessary Sweep gate.
