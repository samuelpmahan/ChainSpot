---
name: receipt-reconcile
description: >
  Resolve one challenged ChainSpot claim by tracing it to the smallest human-
  checkable pixel/trace evidence. Use when a receipt line, component identity,
  angle, distance, support value, ownership statement, or diagnosis is challenged.
  Reconciliation fails if the correct fact is merely buried inside a giant dump.
---

# Receipt Reconcile — Minimal Proof

A receipt is an **acceptance surface**, not a data exhaust pipe.

The question is not:

> "Did we print every number we know?"

The question is:

> "Can the owner verify the challenged claim quickly without opening source or
> excavating a 200-line receipt?"

If the correct value is buried among every possible metric, **the receipt failed**.

## 0 — State exactly one challenged claim

Write the claim verbatim.

Examples:

- "H5 recovery used these visible tee pixels."
- "G3 rejected H13 because axis error exceeded the gate."
- "tee-11 was localized correctly but assigned to the wrong badge."

One reconciliation handles one claim. Do not widen into a general audit unless
the first evidence proves the issue is systemic.

## 1 — Identity gate before numeric proof

Before trusting any number derived from a component, identify the component in
the canonical raster.

Required result:

`IDENTITY: TEE | BADGE | BASKET | RANGE-CHROME | SCREEN-CHROME | UNKNOWN`

If `UNKNOWN`, no tee-specific geometric claim may proceed.

Especially:

- a component near a badge is not presumptively a tee;
- a 5 px bright component is not "definitely the tee";
- a beautiful PCA/ray agreement does not identify the pixels;
- a constrained fit does not identify the pixels;
- downstream usefulness is not object identity.

When badge chrome is plausible, show the badge crop and disprove it before
calling the component terrain evidence.

## 2 — Use the smallest evidence surface

Default reconciliation output:

1. **ONE-LINE VERDICT**
2. **ONE minimal crop/render** marking only the disputed object/evidence
3. **ONE tiny table** with only fields necessary to adjudicate the claim

Example:

```text
VERDICT: RETRACT — comp#304 is badge 16's "1", not tee evidence.

comp   identity       bbox        area   why
304    badge digit    7x21        78     inside badge plate; digit morphology
306    tee pad        19x14       153    visible pad outline in canonical crop
```

Do **not** append every component, every gate metric, all 18 holes, or the full
trace "for completeness."

Completeness belongs in machine artifacts. Human acceptance is selective.

## 3 — Progressive disclosure

Only reveal a second layer when the first layer cannot settle the dispute.

Layer A — verdict + crop + tiny table  
Layer B — exact receipt/trace provenance  
Layer C — broader component table / neighboring context  
Layer D — source inspection

Do not start at Layer D.

## 4 — Independent reconstruction when necessary

If the receipt's intermediate numbers themselves are disputed, reconstruct from
the canonical raster using the real project implementation, not a parallel
re-implementation.

LAB is preferred. If LAB lacks the necessary forensic operation, follow
`lab-shock-collar`: a one-shot warrant may answer the immediate question, but
reuse must promote the capability into LAB.

## 5 — Reconcile semantics, not only arithmetic

These are distinct:

- never ran;
- not scheduled;
- disabled;
- ran and found zero;
- ran and rejected;
- localized but unowned;
- owned but misassigned.

A numerically correct receipt that collapses those distinctions is still wrong.

Likewise, detector ordinal is not hole number.

## 6 — Close the claim

Update the claims ledger in the same commit as the work:

- `UPHELD`
- `RETRACTED`
- `PENDING`

A retraction must say what the pixels actually were.

## Receipt minimization acceptance test

Before presenting a receipt, ask:

> If the owner knows the challenged question, can they find the answer in
> roughly one glance without searching?

If no, produce a smaller human receipt and keep the giant diagnostics only as
machine/debug artifacts.

**The right number hidden in noise does not count as observability.**

## Atomic evidence delivery — one turn or no acceptance

Evidence presentation is atomic.

When you claim a result to the owner, the **same turn** must contain the complete
human-verifiable proof bundle needed to accept or reject that claim:

1. the verdict;
2. the smallest relevant visual/render/crop when the claim is visual;
3. the smallest relevant table/numbers;
4. provenance / artifact path / command sufficient to reproduce it.

Do not split these across conversational turns.

Forbidden pattern:

`I found the problem.`  
→ later: `Want to see the receipt?`  
→ later: `Here is the table.`  
→ later: `Here is the image.`

That is not progressive disclosure. It is incomplete evidence delivery.

Progressive disclosure means the **first turn already contains sufficient proof**.
Additional layers are optional only after acceptance can already happen.

If the result is visual, do not ask whether the owner wants the image. Include
the image in the same turn.

If the proof is too large, minimize it until the sufficient proof fits. Link the
full machine artifact separately.

**No acceptance credit is earned for a partial proof bundle.**
A discovery without its acceptance evidence is still unfinished work.
