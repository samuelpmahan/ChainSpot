# LAB embodied tooling v0

Base: `1141835668d039856b65c73116ef0be097d6010e`
Branches: `codex/lab-scope-v0` (dogfood floor), `codex/lab-ui-hardening` (current hardening)

## Intent

Make LAB usable as an embodied CV toolkit with distinct motions:

- `set` — persistent local course/path/variable/preset context.
- `tutorial` — dependency-free first visual loop.
- `ui` — local clickable human workbench over LAB.
- `scope` — stateless inspection.
- `search` — stateful investigation, trails, pins, Pages.
- `traverse` — spatial movement over Search state using Scope rendering/presentation semantics.
- `sweep` — canonical raster intake and the only algorithm execution path.

`lab --help` is the discoverable agent front door. `lab ui` is the human front door. The production/demo frontend is not required to inspect or exercise the CV algorithm.

## Cold discovery / context

- `lab --help`, recursive command help, `lab set`, and `lab tutorial` work with no `node_modules` / `tsx` installed.
- `lab setup` is the single explicit bootstrap command for TypeScript-backed operations.
- Runtime dependency failure says `Run: ./lab setup`; no agent should need to discover `scripts/chainspot-lab` implementation paths.
- Default corpus root is sibling `../chainspot-corpus`.
- Course selection resolves explicit manifests under `scripts/chainspot-lab/courses/` into `chainspot-corpus/dev/...`.
- Canonical course name, aliases, generated initials, and unique prefixes are accepted; ambiguity fails loudly.
- `lab set DT` resolves DashsTrack.
- LAB context persists locally under ignored `.lab/config.json` by default and may be overridden by `LAB_CONFIG` / `LAB_HOME`.
- Arbitrary vars and corpus path may be persisted. Current context may be saved/loaded as local named presets.
- CLI and UI read the same persisted course context; the workbench may auto-open that configured course.

## Tutorial / single-hole learning

The minimal learning sequence is:

```bash
./lab set DT
./lab scope h1
./lab scope h1 --truth
```

- `scope hN` uses only an explicit course-manifest viewport. It must not read Annotation truth to discover the hole.
- Manifest hole viewports are declared as `sourceBox` coordinates. Sweep sanitizes first; the viewport is translated through the recorded single-source StripChrome offset before entering canonical Scope coordinates.
- `scope hN --truth` explicitly uses Annotation tee/bends/basket geometry and is labeled/logged `TRUTH-TAINT`.
- Truth assistance never occurs implicitly when a manifest viewport is missing; blind `hN` fails instead.
- DashsTrack currently owns tutorial-ready blind viewports for all 18 holes. Other course manifests may exist before their hole viewport tables are populated.
- Canonical `hN` command argv, including view flags, is written to the LAB command audit.
- Truth-tainted entries persist in that audit. When `LAB_TEST_RUN=1` or `LAB_BLIND_TEST=1`, a truth-assisted command fails immediately and any later operation reusing a truth-tainted command log also fails. Independent tests use a fresh `LAB_COMMAND_LOG`.

## Raster contract

Raw raster input is not a downstream mode:

```text
raw capture(s)
  -> Sweep StripChrome
  -> Sweep AutoStitch
  -> canonical raster
  -> Scope / Search / Traverse / algorithm
```

StripChrome is required sanitation, not presentation. Scope's later AutoCrop is presentation/intelligence over the canonical raster.

`scope full` means whole canonical raster after StripChrome/AutoStitch and before Scope AutoCrop. It must never expose pre-StripChrome pixels.

## LAB UI

- `lab ui` starts a local-only Node/TS workbench on `127.0.0.1` and opens a browser by default.
- The UI is tooling, not a replacement implementation of the algorithm or production app.
- No additional Python/control layer and no arbitrary eval/shell surface.
- Canonical raster opening uses the same Sweep intake seam as CLI.
- Persisted `lab set` course context is exposed through the local UI API and used as the initial raster/annotation selection.
- Scope clicks/boxes/full call the shared Scope operation.
- Search UI mutates the same append-only Search state used by CLI and preserves the same visual-interaction/TempPin aging semantics.
- Traverse UI uses the shared movement/anchor semantics and same Search traversal state as CLI. Existing traversals can be resumed.
- Sweep UI calls the same `runSweepOperation` executor used by `lab sweep`; the browser never executes detector code itself.
- The workbench displays the canonical raster, Search Pages/trails/pins, Traverse handles, Search event log, Scope artifacts, Sweep op/gate receipts, and generated artifacts.
- Search/Traverse always expose the Page receiving the next mutation.
- A retained target Page is explicit and generic. The UI must not hard-code a course-specific Page name or silently decide what evidence is final.

## Scope

- Default visual grammar is Context -> Local -> Forensic Wide/Mid/Tight.
- Context defaults to an 800 canonical-px regional crop and 800 output.
- Local contains active geometry plus 100 total px width and 100 total px height.
- Context/Local use natural resampling and coordinate grid by default; `--no-grid` disables it.
- Forensics use tunable source spans, nearest-neighbor, no grid, and a fine non-occluding hairline target.
- All major panel sizes are tunable and labeled in artifacts/sidecars.
- `scope full` is a one-panel whole-canonical view, aspect preserved.
- Scope supports configured `hN`, point, box, mark, dots, one-shot path, manifest/contact-sheet, and explicit truth-assisted hole framing.
- Scope owns no persistent Search state.

## Search

- Search owns persistent investigation state as boring JSON under LAB artifacts.
- Stateful trails support start/add/back/branch/show/revisit/log/list.
- `back` removes visible evidence while preserving historical evidence and monotonic numbering.
- Pins default to `ring-dot`; `crosshair` and `diamond` are experimental presentation styles.
- TempPin TTL is deterministic and visibly actionable; keep/release/style are logged.
- Search Pages are named overlay namespaces on the same canonical raster, allowing scratch/notes/final surfaces without duplicating image data.
- Trails/pins belong to Pages. Branching can promote visible geometry into a different Page.
- Page names and retained/promoted semantics remain user-controlled and dogfoodable; no specific Page name is privileged in the state model.

## Traverse

- Traverse state lives in Search.
- Each CLI Traverse render shows current position `0` plus six numbered neighboring previews; the UI projects the same six movement handles over the canonical map.
- Default discrete travel radius is 75 canonical px.
- Hex handles are conveniences, not constraints.
- Cartesian movement: `--xy DX,DY`.
- Polar movement: `--polar DISTANCE,ANGLE` with image-coordinate convention 0° right, 90° down, 180° left, 270° up.
- UI arbitrary map clicks use the same Cartesian target semantics rather than a new movement model.
- Backtracking uses Search trail semantics, preserving hidden historical movement.
- Assisted starts accept `Tn` and `Bn` from Annotation truth.
- `Nn` is accepted only when Annotation explicitly carries `numberBadge`/`badge`; never guess it and never execute a detector outside Sweep.

## Package / execution

- `scripts/chainspot-lab` is private npm package `@chainspot/lab`.
- Root `./lab` and `lab.cmd` launch the same Node dispatcher.
- No Python control layer.
- Node uses `--import tsx`, avoiding the sandbox-hostile tsx CLI IPC path.
- LAB setup bootstraps/builds local `@chainspot/alg`.
- One-shot commands are the canonical protocol. Interactive, `.lab` script, and UI layers must compile to the same underlying operation semantics rather than invent hidden state.
- No arbitrary shell/eval escape.
- `sweep` remains the only LAB operation that executes the algorithm plan; CLI and UI call the same Sweep operation module.

## Proof plan

- A copied cold launcher with no node_modules proves root/recursive help, `set DT`, and `tutorial` work dependency-free.
- A truth-tainted command log proves a later `LAB_TEST_RUN=1` execution fails before TS dependency resolution.
- Root help exposes context/tutorial/UI/Scope/Search/Traverse/Sweep/knowledge/orient/scripting.
- StripChrome synthetic proof removes phone UI before downstream use and does not invent single-image horizontal crop.
- Scope template proof covers 800 Context, +100 Local, tunable forensic triplet, grids, and explicit full canonical view.
- Single-hole proof covers manifest-only blind viewport, source->canonical translation, and explicit truth-tainted assisted view.
- Pixel-level forensic proof keeps the exact anchor source pixel uncovered.
- Search proof covers monotonic backtracking, Page isolation/promotion, TempPin lifecycle/style, and v1 state migration.
- Traverse proof covers shared hex/Cartesian/polar/absolute target math, Search-backed backtracking, and seven-view artifact structure.
- UI dogfood proves a human can select a course once, open the configured raster, keep a working Page messy, explicitly retain/promote evidence, resume traversal, Scope arbitrary evidence, and run/browse Sweep without the demo frontend.
- Full repo/unit and real-raster dogfood must be run in an environment with repository/network/dependencies before promotion; do not claim those passed from a connector-only environment.
