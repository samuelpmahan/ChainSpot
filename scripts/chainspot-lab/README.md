# ChainSpot LAB

LAB is ChainSpot's embodied CV toolkit. It is tooling around the algorithm, not a second algorithm implementation.

The package lives at `scripts/chainspot-lab` as private npm package `@chainspot/lab`. Repository-root `./lab` and `lab.cmd` launch that same npm/Node dispatcher. No Python control layer is involved.

## First use

```bash
cd scripts/chainspot-lab
npm install
cd ../..
./lab --help
```

The LAB install bootstraps/builds the local `@chainspot/alg` workspace and the CLI executes TypeScript through Node's `--import tsx` loader rather than the sandbox-hostile `tsx` IPC CLI path.

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

## LOOK operations

### Scope — inspect

```bash
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

`--no-grid`, Context/Local sizing, and all three forensic spans are tunable from the CLI.

### Search — remember/explore

Search owns state. Scope does not.

```bash
./lab search start IMAGE h7 1143,1105
./lab search add h7 1050,1120
./lab search back h7
./lab search revisit h7 4
./lab search branch h7 h7-clean --page final
```

Search Pages are named overlay workspaces over the same canonical map. A `scratch` Page can remain messy while `notes` or `final` retain only useful evidence.

```bash
./lab search page new final IMAGE
./lab search page use final IMAGE
./lab search page show final IMAGE
```

Pins default to a thin `ring-dot`; experimental `crosshair` and `diamond` styles are available. TempPins have deterministic render-count TTL, can be kept, styled, or released, and never enter forensic panels.

### Traverse — move

Traverse stores its movement as Search trail state and renders its navigation surface through Scope.

```bash
./lab traverse start IMAGE walk 700,900
./lab traverse go walk 2
./lab traverse go walk --xy 40,-25
./lab traverse go walk --polar 110,330
./lab traverse back walk
```

Each render shows current position `0` plus six numbered neighboring previews. The numbered hex handles are conveniences, not constraints: Cartesian and polar movement can go to any valid canonical coordinate.

Image-coordinate polar convention:

```text
0° right   90° down   180° left   270° up
```

Assisted starts may use explicit annotation anchors:

```bash
./lab traverse start IMAGE h7 --annotation annotation.json --start T7
./lab traverse start IMAGE h7 --annotation annotation.json --start B7
./lab traverse start IMAGE h7 --annotation annotation.json --start N7
```

`Tn` and `Bn` use tee/basket truth. `Nn` is accepted only when the annotation explicitly owns a `numberBadge`/`badge` coordinate; Traverse never guesses a badge or secretly executes a detector.

## RUN

```bash
./lab compile CONFIG.json
./lab sweep CONFIG.json IMAGE.png [TRUTH.json]
```

`compile` is inspection-only. `sweep` remains the only LAB command that executes the algorithm plan against raster input.

## KNOW / PROVENANCE

```bash
./lab invariants
./lab detectors
./lab gates
./lab cases
./lab orient 3fd72 [--verbose]
```

## One front door

`lab --help` is the discoverable front door. One-shot, interactive `lab>`, and `.lab` scripts use the same command registry. LAB exposes no arbitrary shell, Python, or JavaScript eval escape.
