# Python quick_anno S1 checkpoint

Branch: `task/quick-anno-s1-materialization`
Base first-class Python core: `f3ecab36eed4f3a8eaa785197ac48f087b960f67`

## Purpose

Prove one complete slice before delegating S2+:

- PxC, PQL, PCR, Part, Calculation and Tick are first-class Python objects;
- Python can consume a real S1 snapshot from the production ChainSpot runtime;
- a Python PCR can derive and publish a scratch Part;
- PQL can query that result;
- S1 emits deterministic correctness renders from the same production run;
- the Python PCR can emit Mermaid as a view of composition.

This is an experimental investigation surface, not a production Stage rewrite.

## Run

From repository root in the sweep-ready environment:

```sh
python experiments/quick-anno-python/s1.py \
  ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg
```

The script invokes `export_s1_snapshot.cjs`, which executes real S0 then real S1 using the built `@chainspot/alg` runtime and writes the Stage panels plus `snapshot.json`.

Outputs are under:

```text
experiments/quick-anno-python/generated/DashsTrack-S1/
```

Expected correctness renders include:

```text
s0-fullimage.png
s0-croppedimage.png
s1-croppedimage.png
s1-masks.png
s1-badgepx-subtraction.png
s1-badge-mute-subtraction.png
s1-badge-objects.png
```

Python also writes:

```text
python-summary.json
python-S1.mmd
snapshot.json
s0.receipt.txt
s1.receipt.txt
```

## Observed Dash's Track result

Observed in the bounded materialization run used to establish this checkpoint:

```text
canonical: 1290x2083
badges: 18
bright components: 144
dark components: 708
family: 18
owned px: 37002
muted px: 45813
added mute px: 8811
remaining opaque px: 2641257
```

The Python-owned derived Part `scratch.s1.ownershipSummary` produced:

```json
{
  "badges": 18,
  "ownedPx": 37002,
  "mutedPx": 45813,
  "addedMutePx": 8811
}
```

## Correctness meaning

The materialized images are the correctness check. The Python surface is acceptable only if its source snapshot corresponds to the same real S1 run represented by those panels and receipts.

Do not claim the Python-authored semantic S1 graph itself executes the full badge detector yet. Today the production runtime executes S1; Python consumes its resulting testimony/materials and performs experimental calculations over them.

That boundary is deliberate: first make PxC/PQL/PCR behavior pleasant in Python, then promote only proven calculations.

## Delegate from here

A Luna extending this pattern should:

1. take the prior Stage's PxC material as input;
2. expose the smallest real runtime snapshot needed for the investigation;
3. seed first-class Python Parts;
4. express new experimental work as named Calculations in a PCR;
5. publish useful scratch Parts into Python PxC;
6. query with PQL rather than parallel ad-hoc state;
7. materialize a visual correctness check;
8. emit Mermaid/PCR testimony from the same composition;
9. add a convenience only after real repeated friction demonstrates it.

S2 is the next useful transfer test.
