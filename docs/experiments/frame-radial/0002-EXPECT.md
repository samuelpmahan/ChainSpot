# Patch 0002 — Frame Study skeleton

## Why
We need an explicit, composable way to re-express an observation before comparison without prematurely defining what the transformations must be.

## Expected change
Adds a deliberately no-op `Frame` contract and a smoke harness. Frames have names, purpose, provenance/logging, composition order, and a human explanation hook.

The basket-tip frame carries this permanent mistake note:

> The first PCA probe centered angles on the 42×66 body center instead of the documented bottom-center pole tip.

## What must NOT change
- No PCA.
- No basket math.
- No loss function.
- No normalization behavior.
- No scientific conclusion.

All default frame transforms return their input unchanged.

## Verify before continuing
Smoke result must report identity preserved, `loss=null`, `factors=[]`, `projection=null`, with a log entry for every applied no-op frame.
