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
- Add `lab scope` with a default multiscale nearest-neighbor inspection view.
- Support point, bbox, named mark, numbered dot-to-dot geometry, and named numbered search paths.
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
- No persistent search database/session framework.
- No generalized annotation framework.
- No crop-first or single-hole algorithm optimization.
- No Python CLI dependency.
- No arbitrary shell or JavaScript eval inside LAB.

## Proof plan

- `./lab --help` and `lab.cmd --help` traverse the same npm dispatcher and expose `scope`, `compile`, `sweep`, knowledge tools, orient, and `run-script`.
- Running `./lab` opens the same dispatcher interactively at `lab>`.
- A command issued one-shot, interactively, or from `run-script` reaches the same command registry.
- Scope manifest parser proves annotation is optional and path resolution is manifest-relative.
- Default template proves context/local/pixels are all nearest-neighbor and ordered coarse→fine.
- Blind manifests can point/box/mark/dots/path but `hole` requires an explicit annotation.
- Generated scope PNGs carry JSON sidecars with source rectangles and `BLIND`/`TRUTH_AVAILABLE` mode.
