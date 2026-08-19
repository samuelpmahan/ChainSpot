# Local Codex bootstrap — ChainSpot Lab

Use this as the first task for a fresh local Codex session on the experimental branch.

## Starting point

Work on `samuelpmahan/ChainSpot`.

Checkout/pull `experiment/chainspot-lab-bootstrap` and report the exact starting SHA.

Read, in order:

1. `AGENTS.md`
2. `docs/chainspot-lab/CONTRACT.md`
3. the NuThing endpoint/recovery work inherited from `experiment/nuthing-render-attribution-fixes`, especially:
   - `src/lib/nuthing/endpointStage.ts`
   - `src/lib/nuthing/screenChrome.ts`
   - `scripts/cv-probes/occluded_tee_recovery_v3.py`
   - `scripts/cv-probes/transparent_consensus_tee_recovery.py`
   - `docs/nuthing-p2/screen-chrome-attribution.md`
   - `docs/nuthing-p2/consensus-vs-unblend-ab.md`
4. existing replay/cache/evidence concepts already present in the repository before inventing replacements.

Do not deploy or modify production/staging branches.

## Mission

Build the smallest executable vertical slice of **ChainSpot Lab**: local continuous experimentation built around immutable Replay Nodes.

The goal is to stop modifying one canonical CV algorithm and judging only its latest output. Every meaningful measurement and decision boundary should become independently replayable, swappable, measurable, attributable, and cacheable.

The first race is deliberately narrow:

`raster -> viewport -> masks -> components -> badges -> basket sprites -> screen-chrome attribution -> tee candidates -> recovery variants -> endpoint truth evaluation`

Competing recovery implementations must consume identical shared upstream evidence. Start with the endpoint variants already present on this branch; do not rewrite them merely to fit a framework.

## Before implementation

Inspect the code and write a concise implementation plan covering:

- Replay Node TypeScript contract;
- implementation registry identity/versioning;
- content-address/cache key semantics;
- filesystem object layout;
- SQLite ledger schema;
- experiment manifest format;
- exact first nodes mapped to existing NuThing functions/files;
- invalidation semantics;
- CPU/RAM/GPU resource declarations and scheduler minimum viable behavior;
- `doctor`, `status`, `race`, and `show` CLI entry points;
- how Python research implementations participate without hiding their provenance;
- how per-hole/per-candidate evidence and rejection reasons reach the ledger/Toph artifacts;
- acceptance proof for cache reuse.

Do not generalize beyond what the endpoint race requires.

## Host

This is a local WSL2 experiment system, not GitHub Actions infrastructure.

Expected initial machine context:

- HP OMEN 30L;
- Windows 11 Home;
- Ubuntu 24.04 WSL2;
- Ryzen 7 3700X (8c/16t);
- 16 GB RAM;
- RTX 2060 6 GB;
- 256 GB NVMe with little Windows free space;
- 1 TB HDD with substantial free space.

Do not hard-code this. `doctor` must discover the actual host and configured evidence/corpus locations. Prefer WSL-native execution for the research loop and reserve Docker for hermetic reproduction.

## Acceptance target

A successful first vertical slice can run a manifest that compares the existing endpoint recovery implementations over the five current course rasters and produces:

- immutable run identity;
- immutable/cacheable upstream Replay Node outputs;
- per-course and aggregate endpoint metrics;
- per-hole/per-candidate evidence and rejection reasons where available;
- attribution-aware FP classes;
- runtime measurements;
- lineage from every result back to source raster + implementation + parameters;
- human-readable summary/leaderboard;
- artifacts suitable for later Toph visualization.

Then run the same manifest again and prove that unaffected upstream nodes are cache hits rather than recomputed work.

Change one downstream recovery implementation/parameter and prove that only that node and its descendants invalidate.

## Research discipline

Do not optimize for making one implementation win.

If an experiment loses, preserve the result.

If two implementations produce the same endpoint from different evidence, preserve that distinction.

If an implementation needs truth to tune itself, label that training/calibration explicitly and do not score the same data as held-out evidence.

Do not collapse `screen-chrome attributed`, `basket attributed`, and `unexplained` candidates into one FP count.

Treat missing observability as a defect in the experimental system.

## First response

Before coding, report:

1. exact branch/SHA;
2. existing reusable infrastructure you found;
3. proposed first Replay Node DAG;
4. proposed cache key;
5. proposed SQLite tables;
6. proposed manifest for the five-course endpoint race;
7. implementation sequence, intentionally kept small.
