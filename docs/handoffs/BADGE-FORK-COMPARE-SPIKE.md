# Badge fork.compare spike

This is the second concrete render-first composition test, after the badge PCR itself. It deliberately stays a **local experiment seam**, not a new engine architecture.

## Shared checkpoint

Both branches begin from the same prepared badge checkpoint:

- checkpoint: `ba71242da8dfbd30`
- schema identity: `threeFactor.badgeStage+BadgeReading`
- coordinate frame: `badge-crop-normalized:74x62`
- badges: 18

The expensive acquisition prefix is shared: image decode -> badge stage -> digit reading -> normalized badge records -> course-local frame/digit population evidence.

## Branches

### `defaultLive`

Current V1 component ownership only. The branch is observational: it does not modify the default or feed its output back into downstream execution.

- plan/config hash: `b82aa7a812ab17f0`
- unexplained residual pixels: `45359`
- owned pixels: `37002`

### `experimentalPcr`

Residual-aware PCR composer:

- adds the empirically demonstrated dark digit-hole components;
- uses the PCR's course-local repeatable frame/digit support to claim additional structure;
- leaves variable context and unexplained residue visible.

- plan/config hash: `3703b9e560ea3377`
- unexplained residual pixels: `20426`
- owned pixels: `37295`
- added dark-hole components: `10`

## Comparison

Comparison id: `2e9587af08e2d4ec`

In the same measurement space:

- residual-pixel delta: `-24933`
- unexplained-fraction delta: `-0.546754`
- owned-pixel delta: `+293`
- local scratch timing delta: `+6.420 ms` for the experimental branch in this run

These numbers are **not a winner selection**. In particular, a reduction in residual is only useful if the PCR's claims remain visually/evidentially honest. The paired-difference render therefore shows exactly which pixels the experimental branch claims beyond the live branch, while both branch residual populations remain visible.

## One comparison trace, two projections

The scratch producer derives both the PNG and CLI receipt from one comparison result. It fails if render/text projection summaries disagree on:

- comparison id;
- checkpoint id;
- branch hashes;
- instance labels.

The render progression is:

`shared input -> default residual population | experimental PCR residual population -> paired claimed differences -> same-space measures`

## Small local combinator

`scripts/chainspot-lab/experiments/badgeForkCompare.ts` is intentionally badge-scoped. It exists only to test the execution shape that this real comparison required:

- one immutable named checkpoint;
- exactly two branch definitions;
- branch identity/config hash preserved;
- schema identity and coordinate frame preserved;
- evidence trace, render fragment, unexplained residual, output, measure, and timing retained per branch;
- one caller-supplied compatible measurement;
- one caller-supplied comparison;
- **no merge, winner selection, downstream replacement, or pin mutation**.

The smoke test verifies the sidecar preserves default/experimental branch identity and performs a same-space comparison without mutating the checkpoint.

## What earned reuse

The real badge case earned **`fork(...).compare(...)` as an experimental sidecar shape**.

It did not earn:

- a generic FeatureSet execution engine;
- automatic branch selection;
- generic pinning machinery;
- a rendering DSL;
- automatic merging of branch outputs.

The next integration decision is narrow: decide whether this local shape should become a small exec-level comparison helper, or remain an experiment helper until the basket fringe/PCA/backwalk case exercises the same seam a second time.
