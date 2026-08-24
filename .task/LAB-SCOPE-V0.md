# LAB scope v0

Base: `1141835668d039856b65c73116ef0be097d6010e`
Branch: `codex/lab-scope-v0`

## Intent

Make LAB usable as an embodied CV toolkit. `LAB` is the toolkit namespace; `scope` is one visual operation. `lab --help` is the discoverable front door.

## Authorized scope

- `scripts/chainspot-lab` is a private npm package: `@chainspot/lab`, with a `lab` bin.
- Root `./lab` and `lab.cmd` are thin launchers into that package.
- The npm CLI owns one-shot dispatch, the interactive `lab>` shell, help, history, completion, and `run-script`.
- The CLI exposes no arbitrary shell/eval escape; all substantive commands dispatch to the existing LAB TypeScript/Node operations.
- Root `lab --help` exposes the real LAB surface.
- Add `lab scope` with a default nearest-neighbor `1 -> 1 -> 3` visual grammar: one context view, one local view, then three progressively tighter forensic views.
- For path/dot/hole work, all three forensic views are centered on the previous point; for a direct point/mark they stay centered on that requested point.
- The three forensic views remain overlay-free; overlays stay on context/local views only.
- Support point, bbox, named mark, numbered dot-to-dot geometry, and named search paths.
- Search paths are stateful across CLI invocations: start, add, back, branch, show, revisit, log, list.
- `path back` removes the last point from VISIBLE evidence while preserving the historical point and append-only operation log; later additions keep advancing point numbers.
- `path branch` snapshots only the currently visible trail, not backed-out historical clutter.
- Add TempPins: temporary named visual anchors with TTL measured in subsequent successful scope renders, plus `pin here`, `keep`, `release`, and `list`.
- TempPin expiry/release removes visible evidence but stays in the append-only search log. `keep` promotes a TempPin to persistent visible evidence.
- Persist this small interaction state as boring JSON under LAB artifacts; do not create a database/session framework.
- Preserve a tiny scope-template seam that demonstrates extensibility without a plugin framework.
- Add manifest batching and contact-sheet output.
- Manifest annotation is optional. No annotation means BLIND; blind cases must not derive hole truth.
- Add usable single-hole framing when an explicit annotation is supplied.
- Keep a TODO file for later single-hole/performance optimization; do not optimize v0.
- Reuse the sweep raster intake seam. `scope` must not become a second detector/algorithm execution path.
- `sweep` remains the only LAB command that executes the algorithm against raster input.
- Preserve existing `orient 3fd72` behavior on both launchers.

## Non-goals

- No detector changes.
- No ABFeature changes.
- No browser `/lab` UI work.
- No persistent search database/session framework beyond one generated JSON state artifact.
- No generalized annotation framework.
- No crop-first or single-hole algorithm optimization.
- No Python CLI dependency.
- No arbitrary shell or JavaScript eval inside LAB.

## Proof plan

- `./lab --help` and `lab.cmd --help` traverse the same npm dispatcher and expose `scope`, `compile`, `sweep`, knowledge tools, orient, and `run-script`.
- Running `./lab` opens the same dispatcher interactively at `lab>`.
- A command issued one-shot, interactively, or from `run-script` reaches the same command registry.
- Scope manifest parser proves annotation is optional and path resolution is manifest-relative.
- Default template proves the `1 -> 1 -> 3` sequence is nearest-neighbor: 320px context, 320px local, then 160px forensic views sourced from 96px, 48px, and 24px crops.
- A three-point path proves all forensic crop centers equal the previous point, while context/local retain whole-request framing.
- Blind manifests can point/box/mark/dots/path but `hole` requires an explicit annotation.
- Mechanical trail proof: start -> add -> add -> add -> back -> add renders labels `1 -> 2 -> 3 -> 5`, while point 4 remains revisitable/logged but invisible.
- Branch proof: branch after back copies only active visible points.
- TempPin proof: temp pin survives exactly N subsequent successful renders, disappears on expiry/release, remains logged, and survives indefinitely after `keep`.
- Generated scope PNGs carry JSON sidecars with source rectangles, active pins, and `BLIND`/`TRUTH_AVAILABLE` mode.
