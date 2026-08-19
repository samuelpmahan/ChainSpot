# ChainSpot Lab — Experimental Contract

## Purpose

ChainSpot Lab is the local continuous-experimentation system for CV and geometry research.

The operating model is an F1 team, not a single mutable algorithm: preserve cars, preserve telemetry, race competing implementations over identical evidence, and accumulate a durable engineering history.

The lab answers questions such as:

- Which endpoint recovery performs best specifically on basket-overlapped tees with fewer than 30 surviving bright pixels?
- Did a regression originate in measurement, attribution, scoring, or assignment?
- Can a new decision rule be evaluated without recomputing expensive upstream image measurements?
- What exact pixels and measurements caused a candidate to survive or fall out?
- Does an improvement generalize across courses/failure families, or merely tune one fixture?

## Core rules

### 1. Measurement and decision are different things

Preserve primitive evidence whenever practical. A node should prefer to emit `V`, `S`, component geometry, support samples, distances, probabilities, or pixel ownership rather than only `bright=true`, `accepted=true`, or `score=0.81`.

Thresholds, policies, attribution rules, ranking, assignment, and acceptance gates should be replayable decision nodes when the upstream primitive evidence is sufficient.

### 2. Replay Nodes are the durable boundary

Every meaningful boundary in an experiment DAG should be representable as a Replay Node.

A Replay Node execution has:

- stable node type/name;
- implementation ID and implementation version/source identity;
- exact input artifact hashes;
- exact parameter hash;
- corpus/suite and source-raster identity where applicable;
- content-addressed immutable outputs;
- structured per-entity measurements and/or decisions;
- reasons/rejection reasons where a decision is made;
- runtime and declared/observed resource usage;
- parent Replay Node hashes;
- artifacts useful for inspection (overlays, crops, planes, paths, traces).

If a meaningful decision cannot be traced to evidence at a Replay Node boundary, treat it as an audit gap.

### 3. Same evidence means the same hashes

Competing downstream implementations must consume the exact same upstream Replay Node outputs when the experiment claims an A/B comparison.

Do not silently recompute A after changing upstream code and compare it with an old B. The manifest/run ledger must make this impossible or obvious.

### 4. Content-addressed outputs are immutable

No node writes `latest` as its durable result. A result key is derived from at least:

`node type + implementation identity + implementation source hash + parameters + ordered input hashes + relevant environment/schema identity`.

If the same key already exists and passes integrity checks, reuse it.

Human-friendly aliases, championship leaders, and "current champion" pointers may move. Evidence objects do not.

### 5. Invalidation follows the DAG

Changing a node implementation or its parameters invalidates that node and descendants only.

Examples:

- assignment score change: do not rerun raster decoding, masks, endpoint detection, or MiddleOut path measurement if their hashes are unchanged;
- tee acceptance threshold change: do not rerun raster/component measurement if the necessary primitive measurements already exist;
- basket sprite measurement change: invalidate basket-dependent descendants, not unrelated upstream raster nodes.

### 6. Implementations are registered, not overwritten

Do not make `teeRecovery()` mean whatever was edited most recently.

Prefer identities such as:

- `tee.recovery.bbox-v2`
- `tee.recovery.consensus50-v1`
- `tee.recovery.alpha-unblend-v3`
- `chrome.none`
- `chrome.screen-space-v1`
- `assignment.exchange-v1`

Historical implementations that produced useful evidence should remain runnable until deliberately retired with a recorded reason.

Branches introduce implementations. Experiment manifests compare them.

### 7. Attribution is evidence

The input is synthetic CGI composited over a basemap, not merely natural-image features.

Known rendering families should be represented explicitly when possible: badge body/glyph, basket sprite, tee glyph, C1/C2 furniture, corridor/ribbon, walking-path rendering, screen chrome, etc.

A candidate inside known basket furniture is not equivalent to unexplained map clutter. A child component belonging to Apple Maps screen chrome is not an ordinary tee false positive. Preserve those distinctions in the ledger.

### 8. Truth evaluation never changes the measured evidence

Ground truth may score, categorize, and diagnose outputs. It must not leak into the measurement implementation being evaluated unless the experiment is explicitly labeled as supervised/training/calibration.

Training/calibration suites and held-out/validation suites must be distinguishable in the ledger.

### 9. Failures are first-class records

For each truth object/hole, the lab should eventually be able to answer:

`source evidence -> candidate formation -> each gate/decision -> attribution -> ranking -> assignment -> user-visible result`.

Record `never formed` separately from `formed then rejected`, and preserve the rejecting node/reason.

### 10. The ledger accumulates history

Do not delete an old run because a better algorithm exists.

The system should support queries over historical runs and failure families. Summary leaderboards are projections over the evidence ledger, not the evidence itself.

## First vertical slice

Build only enough infrastructure to race the endpoint work already present on `experiment/nuthing-render-attribution-fixes`:

`raster -> viewport -> masks -> components -> badges -> basket sprites -> screen-chrome attribution -> tee candidates -> recovery implementation -> endpoint truth evaluation`

Initial recovery implementations include:

- no supplemental recovery;
- existing bbox/fragment recovery v2;
- transparency-aware + normal-tee consensus50;
- alpha-unblend v3.

The first acceptance target is a manifest-driven reproduction of the current five-course endpoint matrix in which competing recovery implementations consume shared upstream snapshots and unaffected nodes are cache hits on a second run.

After that vertical slice works, extend the same DAG through MiddleOut measurement, path scoring, invariants, global assignment, and Annotate Course handoff.

## Experiment manifests

A manifest describes a race, not an imperative script. It should identify:

- suite/corpus selection;
- implementations to race at swappable nodes;
- parameters/sweeps;
- metrics and slices;
- optional resource limits;
- artifact/trace policy.

The runner computes required DAG variants and maximizes reuse of shared ancestors.

Illustrative shape only (the implementation may refine this):

```yaml
name: endpoints-dev5
suite: dev5
race:
  chrome:
    - chrome.none
    - chrome.screen-space-v1
  teeRecovery:
    - tee.recovery.bbox-v2
    - tee.recovery.consensus50-v1
    - tee.recovery.alpha-unblend-v3
metrics:
  - teeRecall18px
  - localizationErrorPx
  - unexplainedFalsePositive
  - basketAttributedFalsePositive
  - chromeAttributedFalsePositive
  - runtimeMs
```

## Local host and resources

Initial host:

- Windows 11 Home;
- Ubuntu 24.04 on WSL2;
- Ryzen 7 3700X, 8 cores / 16 threads;
- 16 GB RAM;
- RTX 2060, 6 GB VRAM;
- small/nearly-full NVMe plus spacious 1 TB HDD.

This is context, not configuration. `chainspot-lab doctor` must discover/report actual available CPU, RAM, GPU/CUDA, WSL state, free storage, configured corpus path, evidence-store path, repo SHA, and worker limits.

Default scheduling philosophy:

- CPU-only Replay Nodes may run concurrently subject to RAM/CPU budget;
- GPU nodes serialize by default unless explicitly proven safe;
- keep the interactive Windows desktop usable;
- fast research runs execute natively in WSL;
- Docker is a separate hermetic reproduction/scrutineering lane.

Large evidence objects should normally live on the HDD via a configurable WSL path. Keep only a bounded hot cache on faster storage. Never hard-code `/mnt/d` or another drive letter as an algorithmic assumption.

## Suggested local store

Exact paths are configurable; conceptual layout:

```text
.chainspot-lab/
  ledger.sqlite
  config.json
  hot-cache/

<evidence-store>/
  objects/
  runs/
  artifacts/
  suites/
  backups/
```

SQLite stores indexes, identities, metrics, lineage, decisions, and searchable metadata. Large rasters/arrays/overlays/path blobs remain filesystem objects referenced by content hash.

## Required operator commands

The first implementation should converge on a small CLI surface:

- `chainspot-lab doctor` — inspect host/config/dependencies/storage/resources;
- `chainspot-lab status` — current cache/store/ledger/registered implementations/latest races;
- `chainspot-lab race <manifest>` — execute/replay an experiment DAG;
- `chainspot-lab show <run>` — summarize a run and point to its evidence/artifacts.

Names may be implemented initially through `npm run`/`tsx`; do not spend time packaging a global executable before the vertical slice works.

## Toph

Toph is the intended evidence viewer, not the source of truth.

Replay Nodes should emit enough structured evidence for Toph to display the same entity across implementations, for example:

```text
H6 tee
  bright support: 21 px
  hollow-ring: never formed
  fallback: rejected (minDim < 8)
  bbox-v2: no recovery
  consensus50: 20/21 pixels agree with normal tee band -> candidate
  alpha-unblend-v3: 21 raw + 1 reconstructed pixel -> candidate
```

The immutable lab store/ledger remains authoritative; Toph visualizes it.

## Promotion to product

Lab success does not silently become production behavior.

When a variant is selected for product use:

1. identify the exact implementation and evidence/run hashes supporting promotion;
2. create/follow the normal ChainSpot product workflow and Linear ticket;
3. transplant/integrate the selected behavior with production tests and review;
4. preserve the lab implementation/evidence so the production choice remains explainable.

## Anti-patterns

Do not:

- tune one mutable implementation and report only its newest score;
- rerun expensive ancestors for every downstream threshold sweep;
- collapse attribution classes into one generic FP count;
- store only aggregate recall and discard per-hole evidence;
- let truth coordinates alter an allegedly unsupervised measurement pass;
- compare variants measured from different untracked upstream states;
- put giant binary evidence blobs in Git or SQLite;
- make GitHub Actions the primary experimental compute host;
- build a generalized workflow engine before the endpoint race proves the Replay Node contract.
