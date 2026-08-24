# LAB embodied tooling v0

Base: `1141835668d039856b65c73116ef0be097d6010e`
Branch: `codex/lab-scope-v0`

## Intent

Make LAB usable as an embodied CV toolkit with distinct motions:

- `scope` — stateless inspection.
- `search` — stateful investigation, trails, pins, Pages.
- `traverse` — spatial movement over Search state using Scope rendering.
- `sweep` — canonical raster intake and the only algorithm execution path.

`lab --help` is the discoverable front door.

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

## Scope

- Default visual grammar is Context -> Local -> Forensic Wide/Mid/Tight.
- Context defaults to an 800 canonical-px regional crop and 800 output.
- Local contains active geometry plus 100 total px width and 100 total px height.
- Context/Local use natural resampling and coordinate grid by default; `--no-grid` disables it.
- Forensics use tunable source spans, nearest-neighbor, no grid, and a fine non-occluding hairline target.
- All major panel sizes are tunable and labeled in artifacts/sidecars.
- `scope full` is a one-panel whole-canonical view, aspect preserved.
- Scope supports point, box, mark, dots, one-shot path, manifest/contact-sheet, and truth-assisted hole framing.
- Scope owns no persistent search state.

## Search

- Search owns persistent investigation state as boring JSON under LAB artifacts.
- Stateful trails support start/add/back/branch/show/revisit/log/list.
- `back` removes visible evidence while preserving historical evidence and monotonic numbering.
- Pins default to `ring-dot`; `crosshair` and `diamond` are experimental presentation styles.
- TempPin TTL is deterministic and visibly actionable; keep/release/style are logged.
- Search Pages are named overlay namespaces on the same canonical raster, allowing scratch/notes/final surfaces without duplicating image data.
- Trails/pins belong to Pages. Branching can promote visible geometry into a different Page.
- Page display uses the Scope renderer; Search must not own another raster renderer.

## Traverse

- Traverse state lives in Search.
- Each Traverse render shows current position `0` plus six numbered neighboring previews.
- Default discrete travel radius is 75 canonical px.
- Hex handles are conveniences, not constraints.
- Cartesian movement: `--xy DX,DY`.
- Polar movement: `--polar DISTANCE,ANGLE` with image-coordinate convention 0° right, 90° down, 180° left, 270° up.
- Backtracking uses Search trail semantics, preserving hidden historical movement.
- Assisted starts accept `Tn` and `Bn` from annotation truth.
- `Nn` is accepted only when annotation explicitly carries `numberBadge`/`badge`; never guess it and never execute a detector outside Sweep.
- Traverse navigation artifacts use Scope's renderer primitives, not a second renderer.

## Package / execution

- `scripts/chainspot-lab` is private npm package `@chainspot/lab`.
- Root `./lab` and `lab.cmd` launch the same Node dispatcher.
- No Python control layer.
- Node uses `--import tsx`, avoiding the sandbox-hostile tsx CLI IPC path.
- LAB install bootstraps/builds local `@chainspot/alg`.
- Interactive, one-shot, and `.lab` script commands share one registry.
- No arbitrary shell/eval escape.
- `sweep` remains the only command that executes the algorithm plan.

## Proof plan

- Root help exposes Scope, Search, Traverse, Sweep, knowledge tools, orient, and scripting.
- StripChrome synthetic proof removes phone UI before downstream use and does not invent single-image horizontal crop.
- Scope template proof covers 800 Context, +100 Local, tunable forensic triplet, grids, and explicit full canonical view.
- Pixel-level forensic proof keeps the exact anchor source pixel uncovered.
- Search proof covers monotonic backtracking, Page isolation/promotion, TempPin lifecycle/style, and v1 state migration.
- Traverse proof covers hex direction mapping, Cartesian/polar vector convention, Search-backed backtracking, and seven-view artifact structure.
- Assisted truth coordinates are transformed into canonical coordinates after StripChrome, including optional badge anchors.
- Full repo/unit and real-raster dogfood must be run in an environment with repository/network/dependencies before promotion; do not claim those passed from a connector-only environment.
