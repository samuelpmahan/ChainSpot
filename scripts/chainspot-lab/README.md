# ChainSpot LAB

LAB is ChainSpot's embodied CV toolkit. It is tooling around the algorithm, not a second algorithm implementation.

The package lives at `scripts/chainspot-lab` as private npm package `@chainspot/lab` and exposes the `lab` bin. The repository-root `./lab` and `lab.cmd` launch that same bin.

## First use

```bash
cd scripts/chainspot-lab
npm install
cd ../..
./lab --help
```

Windows:

```bat
cd scripts\chainspot-lab
npm install
cd ..\..
lab --help
```

LAB dependencies stay isolated from the root application dependency surface.

## One front door

One-shot:

```bash
./lab scope --help
./lab scope course.png 880,429
./lab sweep CONFIG.json IMAGE.png
```

Interactive:

```text
./lab
ChainSpot LAB. `help` to discover; `exit` to leave.
lab> help
lab> scope course.png 880,429
lab> history
```

Scripted:

```text
./lab run-script investigation.lab
```

A `.lab` script is intentionally boring: one normal LAB command per line; blank lines and lines beginning with `#` are ignored. The same dispatcher handles one-shot commands, interactive commands, and script commands. This is the substrate for later guided/apply workflows without inventing a second execution system.

LAB does not expose an arbitrary shell, Python, or JavaScript eval escape.

## Operations

### LOOK

`scope` is the embodied inspection operation. It supports point/bbox inspection, named marks, numbered dot-to-dot geometry, named search paths, manifest batching, contact sheets, and truth-assisted single-hole framing. Annotation in a manifest is optional; absence means BLIND.

Start at:

```bash
./lab scope --help
```

### KNOW

```bash
./lab invariants
./lab detectors
./lab gates
./lab cases
```

These are the observed renderer/detector/gate/evidence registries. They are claims and provenance, not enforcement.

### RUN

```bash
./lab compile CONFIG.json
./lab sweep CONFIG.json IMAGE.png [TRUTH.json]
```

`compile` is inspection-only. `sweep` is the only LAB command that executes the algorithm against raster input. Scope reuses the sweep raster intake seam for decoding but does not execute detector plans.

### PROVENANCE

```bash
./lab orient 3fd72 [--verbose]
```

This preserves the frozen-reference auditor behind the same root dispatcher.

## Discoverability rule

`lab --help` is the front door. Successful tools should leave a useful artifact or handle and point toward the nearest useful next operation. Prefer discovering through LAB before reading implementation source.
