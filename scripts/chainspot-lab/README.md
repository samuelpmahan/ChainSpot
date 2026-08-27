# ChainSpot LAB

LAB is ChainSpot's embodied CV toolkit. It is tooling around the algorithm, not a second algorithm implementation.

The package lives at `scripts/chainspot-lab` as private npm package `@chainspot/lab`. Repository-root `./lab` and `lab.cmd` launch that same npm/Node dispatcher. No Python control layer is involved.

## Cold start

A fresh checkout is discoverable before dependencies exist:

```bash
./lab --help
./lab set --help
./lab tutorial
./lab scope --help
./lab search --help
./lab traverse --help
./lab ui --help
./lab sweep --help
```

Those paths are implemented in the dependency-free JavaScript launcher and do not resolve `tsx` or LAB package dependencies.

When you are ready to execute TypeScript-backed LAB operations:

```bash
./lab setup
```

`lab setup` runs `npm install` inside the private LAB package. Its postinstall bootstraps/builds the local `@chainspot/alg` workspace. A cold execution attempt that needs TypeScript fails loudly with `Run: ./lab setup` rather than requiring the user/agent to know an implementation directory.

## Tutorial: one course, one hole

LAB assumes `chainspot-corpus` is a sibling of `ChainSpot` by default.

```text
workspace/
  ChainSpot/
  chainspot-corpus/
```

The smallest teaching loop is:

```bash
./lab set DT
./lab scope h1
./lab scope h1 --truth
```

`DT` resolves to the explicit `DashsTrack` course manifest. Initials, aliases, and unique prefixes remain accepted until they become ambiguous; ambiguity fails loudly rather than guessing.

`scope h1` is blind with respect to Annotation truth. It uses only the course manifest's source-frame viewport for Hole 1, then translates that viewport through Sweep's recorded StripChrome offset into canonical coordinates.

`scope h1 --truth` is intentionally assisted. It uses exact Annotation tee/bends/basket geometry, records a `TRUTH-TAINT` command entry, and is for learning rather than certification. When `LAB_TEST_RUN=1` or `LAB_BLIND_TEST=1`, a truth-assisted command fails immediately. A later test run reusing a command log that already contains truth taint also fails; use a fresh `LAB_COMMAND_LOG` for an independent test.

The dependency-free tutorial prints this contract:

```bash
./lab tutorial
```

DashsTrack currently carries the complete 18-hole blind viewport table used by this tutorial. Other course manifests may be selected already, but `scope hN` fails explicitly when that course does not yet define a blind viewport; LAB never falls back to Annotation truth implicitly.

## Persisted context: `lab set`

`lab set` is local LAB context, not shell state. By default it persists under ignored `.lab/config.json`, so CLI, REPL, and UI can recover it after restart.

```bash
./lab set                     # show current context
./lab set DT                  # course -> DashsTrack
./lab set courses             # known course manifests
./lab set corpus ../my-corpus # override sibling corpus root
./lab set page scratch        # arbitrary persisted variable
./lab set unset page
```

Reusable presets are local too:

```bash
./lab set save dashs-learning
./lab set load dashs-learning
./lab set @dashs-learning
```

Known course manifests live under `scripts/chainspot-lab/courses/` and point into `chainspot-corpus/dev/...`. They are explicit data, not hidden filename heuristics.

## Raster contract

```text
raw capture(s)
  -> Sweep StripChrome
  -> Sweep AutoStitch
  -> canonical raster
  -> Scope / Search / Traverse / algorithm
```

StripChrome is required input sanitation. Pre-StripChrome pixels are not a supported downstream representation.

`scope full` means the entire **canonical** raster after StripChrome/AutoStitch and before Scope's task-aware AutoCrop. It is not a raw-capture escape hatch.

## LAB UI — human algorithm workbench

For a human-facing workbench:

```bash
./lab ui
```

`lab ui` binds to `127.0.0.1:4317` and opens the browser. Use `--port N` or `--no-open` when useful. It adds no new frontend/runtime dependency: the server is Node/TS and the browser shell is local JS/CSS.

The UI and CLI call the same LAB operation modules. The UI is not the demo app and does not shell out to the CLI. If `lab set` has selected a course, the workbench inherits that persisted context and opens the configured course raster automatically when available.

The first slice supports:

- opening any local raster by path and canonicalizing it through Sweep intake;
- optional Annotation truth for assisted inspection/Traverse starts;
- clicking a canonical raster for Scope point inspection;
- dragging a Scope box and opening `scope full`;
- tuning Context/Local/forensic spans and grid visibility;
- creating/switching Search Pages with an explicit `WRITING TO:` destination;
- clicking trails and pins directly on the canonical map;
- keeping/releasing pins;
- choosing any Page as the retained target, ghosting it under a working Page, and explicitly branching visible trail evidence into it;
- starting Traverse from a clicked point or `Tn` / `Nn` / `Bn` annotation anchor;
- Traverse by numbered hex neighbor, arbitrary map click, Cartesian delta, or polar distance/heading;
- resuming existing saved traversals from the same Search state used by CLI;
- the same append-only Search event log used by CLI;
- choosing an algorithm config, running the real Sweep operation, seeing the op/gate timeline, and browsing generated LAB artifacts.

The workbench intentionally makes mutation consequences obvious. Scope is stateless; Search/Traverse show the Page the next click/move will modify; Sweep leaves Search state alone.

## Scope — inspect

```bash
./lab scope h1
./lab scope h1 --truth
./lab scope IMAGE 880,429
./lab scope IMAGE x,y,w,h
./lab scope full IMAGE
./lab scope --hole 7 IMAGE annotation.json
./lab scope --help
```

Default Scope presentation is `Context -> Local -> Forensic Wide/Mid/Tight`:

- Context: 800 canonical px by default, natural resampling, coordinate grid.
- Local: active geometry +100 total px width and +100 total px height, natural resampling, coordinate grid.
- Forensics: tunable source spans, nearest-neighbor, non-occluding hairline target, no grid/pins/trails over evidence.

`--no-grid`, Context/Local sizing, and all three forensic spans are tunable from CLI or UI.

## Search — remember/explore

Search owns state. Scope does not.

```bash
./lab search start IMAGE h7 1143,1105
./lab search add h7 1050,1120
./lab search back h7
./lab search revisit h7 4
./lab search branch h7 h7-clean --page final
```

Search Pages are named overlay workspaces over the same canonical map. A `scratch` Page can remain messy while `notes`, `final`, or any chosen Page retains useful evidence.

```bash
./lab search page new final IMAGE
./lab search page new scratch IMAGE
./lab search page use scratch IMAGE
./lab search page show final IMAGE
```

Pages are visibility/mutation namespaces, not raster copies. Pins default to a thin `ring-dot`; `crosshair` and `diamond` are experimental styles. TempPins have deterministic render-count TTL, can be kept/styled/released, and never enter forensic panels.

## Traverse — move

Traverse stores movement as Search trail state and renders its navigation surface through Scope.

```bash
./lab traverse start IMAGE walk 700,900
./lab traverse go walk 2
./lab traverse go walk --xy 40,-25
./lab traverse go walk --polar 110,330
./lab traverse back walk
```

Each render shows current position `0` plus six numbered neighboring previews. Hex handles are conveniences, not constraints: Cartesian/polar movement can go to any valid canonical coordinate. The UI also permits arbitrary destination clicks.

Image-coordinate polar convention:

```text
0° right   90° down   180° left   270° up
```

Assisted starts may use explicit Annotation anchors:

```bash
./lab traverse start IMAGE h7 --annotation annotation.json --start T7
./lab traverse start IMAGE h7 --annotation annotation.json --start B7
./lab traverse start IMAGE h7 --annotation annotation.json --start N7
```

`Tn` and `Bn` use tee/basket truth. `Nn` is accepted only when Annotation explicitly owns a `numberBadge`/`badge` coordinate; Traverse never guesses one or secretly executes a detector.

## Sweep — execute

```bash
./lab compile CONFIG.json
./lab sweep CONFIG.json IMAGE.png [TRUTH.json]
./lab sweep batch CONFIG.json dev
./lab sweep batch --through G3 CONFIG.json demo
./lab sweep batch --through G3 CONFIG.json all
LAB_BLIND_TEST=1 ./lab sweep batch --through G3 packages/alg/src/detectors/threeFactor/configs/default.json dev demo
```

`compile` is inspection-only. `sweep` remains the only LAB operation that executes the algorithm plan against raster input. `lab sweep` and the Sweep tab in `lab ui` both call `sweep/operation.ts`; there is no frontend algorithm implementation.

Batch defaults to `--through G3`; `G1`, `G2`, and `G3` are the valid cutoffs. It expands `dev`, `demo`, `all`, individual course names, and unambiguous course aliases into manifest-backed cases; omitted selectors mean `dev`, and multiple selectors are deduplicated. It calls the same Sweep operation once per case. The REC's `TheRec-L.PNG` and `TheRec-R.PNG` captures are grouped into one `stitched` StripChrome → AutoStitch multi-input case; `clean-full` and `thrown-full` are separate single-input cases. Batch prints a deterministic `START` and `DONE`/`FAIL` line for every case, then the stable aggregate. It continues after failures and exits nonzero if any case failed. It never loads Annotation truth implicitly. A normal single-image Sweep remains unchanged.

Each case writes normal Sweep evidence below `artifacts/sweep/<config>/batches/<course>/<case>/`; the batch root receives compact `summary.txt` and machine-readable `summary.json` receipts. These are generated run evidence, not source files to commit. The ordered aggregate fields are course/case/inputs, badges, baskets, raw rings, pre-family tees, visible tees, visible deficit, operation count, runtime, conformance drift, and status. Provenance appears in both receipts: badge/basket counts are accepted drawables from their named trace units; raw rings are accepted plus rejected `tees` drawables; pre-family tees are accepted `tees` drawables after G3 exclusion; visible tees are accepted `teeFamily` drawables; visible deficit is `max(0, badges - visible tees)`; operations are engine receipt count; runtime is summed receipt `durationMs`; conformance drift counts receipts whose actual consumes/produces omit a declared slot. `durationMs` is volatile by design.

## KNOW / PROVENANCE

```bash
./lab invariants
./lab detectors
./lab gates
./lab cases
./lab orient 3fd72 [--verbose]
```

## One protocol

`lab --help` is the discoverable front door for agents and `lab ui` is the clickable front door for humans. Recursive help, `set`, and `tutorial` remain usable on a completely cold checkout. One-shot commands remain the canonical protocol; interactive `lab>`, `.lab` scripts, and the local UI are convenience layers over LAB state/operation code. LAB exposes no arbitrary shell, Python, or JavaScript eval escape.
