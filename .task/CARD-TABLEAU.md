# LAB Card Tableau — composable knowledge as an active reasoning surface

## Status

Branch: `lab/card-tableau`
Base: `codex/lab-ui-hardening @ 21428fd4fcaf35221d5d9b0179556d7d5b4ddcb4`
Integration target: `staging/lab`

This is a cross-cutting LAB lane. It does not belong inside `lab/alg`,
`lab/ui`, `lab/cv-harness`, or `demo/*` because all four should be able to
participate in it without any one of them owning the reasoning substrate.

## Intent

Cards are not Frames.

A Frame tries to represent a situation completely.

A Card is deliberately partial and composable.

The working understanding of a situation should emerge from arranging several
small Cards and relation tiles together, Baba-Is-You style, rather than by
growing any one Card into an ontology, giant schema, or self-sufficient model.

The existing knowledge deck remains an **agentic rolodex**: cards are
self-contained enough to teach, cross-referenced enough to force traversal,
and intentionally not a knowledge-graph substrate.

This task adds a live composition surface on top of that deck without changing
that principle.

## Governing distinction

> Frames represent situations. Cards participate in situations.

Nuance should scale by composition, not increasingly specific card classes.

Bad:

```text
Tee
OccludedTee
OccludedTeeNearBasket
OccludedTeeNearC2D
OccludedTeeNearC2DWithBadgeOverlap
```

Preferred:

```text
[TEE]
[OCCLUSION]
[NEAR]
[C2D]
[AIMS-AT-BADGE]
```

with the active arrangement supplying the situation-specific nuance.

## Core model

The first slice should need only three conceptual objects:

1. **Card** — an existing reusable knowledge atom.
2. **Relation tile** — a small connective/operator token used between Cards.
3. **Tableau** — a temporary composition of Cards and relation tiles
   representing the agent's current working interpretation.

Example:

```text
[O00-tee] [NEAR] [I17-neighbor-ring]
[C01-complete-occlusion] [EXPLAINS?] [H5]
[E44-h5-rgb] [TESTS] [C01-complete-occlusion]
```

The tableau is temporary.

The Cards are durable.

Changing, challenging, rearranging, or removing a relation must not mutate the
underlying Cards.

## Subsumption target

Card composition should permit a knowledge-side analogue of subsumption:

- small durable claims remain independently useful;
- additional Cards add constraints, exceptions, evidence, or affordances;
- higher-order context modulates interpretation without rewriting lower-level
  knowledge;
- a contradicted Card or relation can be removed from the active tableau
  without discarding everything else known about the object.

The system must make it cheap to add one more piece of understanding without
inventing a new total representation.

## Existing deck is authoritative source material

Prior deck work lives on:

`cards/knowledge-deck-engine-era @ 692ff284b468cc1287a6738b0a98b7ffcf10b08c`

That branch is source material, not the base for this lane.

Important existing axes include:

- Gate = where
- Detector = mechanism
- Invariant = claim
- Case = pathology
- Known Object = durable object knowledge
- Evidence = dated reproducible measurement

Preserve existing conventions where ported:

- established card IDs;
- `measured | observed | archetype` epistemic vocabulary;
- validated cross-references;
- provenance/source/retest behavior;
- append-only evidence history;
- import-time self-checks;
- agentic traversal rather than graph search.

Do not wholesale merge the old branch. Port deliberately onto the current LAB
lineage.

## First slice

Keep the implementation aggressively small.

The first accepted surface should support the equivalent of:

```text
card
relation
compose
remove
show
save
load
```

The exact CLI syntax is part of the design task and is NOT pre-approved.

The public LAB surface must be receipt-first: an agent should be able to read
the command output and understand the current composition without opening
source.

A `cards` or `tableau` command may be appropriate, but Opus must propose the
contract before implementation.

## Relation vocabulary

Do not create a predicate ontology up front.

Start with the smallest relation vocabulary proven useful by concrete
ChainSpot/LAB reasoning.

Candidate examples, not requirements:

```text
IS
HAS
NEAR
CONSTRAINS
SUPPORTS
CONTRADICTS
EXPLAINS
REQUIRES
TESTS
BEFORE
AFTER
```

A provisional form such as `EXPLAINS?` may be useful if it preserves the
difference between hypothesis and asserted relation.

Every initially supported relation must be justified by actual intended use.
If five relations are enough, ship five.

## Card role is contextual

Avoid rigid syntactic classes such as noun/property/procedure/evidence unless
implementation reality proves one necessary.

A Card may act as subject in one composition and object in another:

```text
[E44] [CONTRADICTS] [C01]
[C01] [TESTED-BY] [E44]
```

The composition gives the Card its local role.

## Tableau semantics

A tableau is working epistemic state, not truth.

It must support:

- explicit provisional relationships;
- removal/rearrangement without mutating Cards;
- persistence and replay;
- deterministic textual rendering;
- enough provenance to know which Cards/relations participated;
- coexistence of competing tableaux or hypotheses where useful;
- loud failure on unresolved or invalid references.

Do not build automatic global inference in the first slice.

The agent remains responsible for composing and revising the tableau.

## LAB interaction

The eventual loop is:

```text
Cards / tableau
    -> tells the agent what currently matters
    -> Scope / Search / Traverse / Sweep
    -> receipt + raster evidence
    -> composition changes
    -> next LAB operation
```

Tableau must not replace Search, Pages, receipts, Sweep, or the algorithm
evidence board.

Reference those surfaces where useful rather than duplicating them.

## Cross-lane boundary

This lane owns the semantic/data/CLI contract for Card composition.

It does NOT own:

- algorithm behavior (`lab/alg`);
- independent scoring (`lab/cv-harness`);
- product behavior (`demo/*`);
- rich visual presentation (`lab/ui`).

A later `lab/ui` piece may render tableaux, but UI consumes the tableau
contract rather than defining it.

Invariant:

> No other lane needs to understand tableau implementation details to
> participate in it.

Algorithm, harness, and UI may emit/reference Cards or evidence without owning
the reasoning substrate.

## Explicit anti-goals

Do not build:

- a knowledge graph database;
- a graph query language;
- RDF/OWL/export machinery;
- a generic ontology engine;
- a theorem prover;
- a giant Frame object;
- hidden LLM state treated as authoritative;
- a speculative generic agent framework.

Cross-references remain navigation.

Tableau composition is the working surface.

## Receipt-first acceptance

Follow `docs/WORKFLOW.md`.

The Opus's first deliverable is the **receipt / CLI contract** it would itself
want when debugging this feature cold.

The receipt should make clear, at minimum:

- which tableau is active;
- which Cards participate;
- the relations between them;
- which relationships are provisional vs asserted, if that distinction exists;
- what changed after a mutation;
- how to reproduce/reload the tableau;
- unresolved/invalid references loudly.

Tests assert that the receipt tells the truth.

"Tests pass" is not acceptance.

## OSS implementation protocol

This task uses the owner's OSS pattern:

**Opus + Sonnet + Sonnet**

### Opus

Opus is planner, interface owner, orchestrator, and final validator.

Opus must:

1. inspect the current LAB trunk and prior card branch;
2. group work by context/seam rather than arbitrary file count;
3. design the public interface and receipt format FIRST;
4. plan only — do not implement before owner approval;
5. show the owner the complete plan and exact Sonnet assignments;
6. WAIT for explicit owner approval;
7. after approval, dispatch isolated Sonnet implementation pieces;
8. ensure each Sonnet cross-checks the other's work, never only its own;
9. integrate/reconcile the pieces;
10. personally validate through the public LAB surface, receipts, tests, and a
    real usage example;
11. present the evidence before push/landing according to repository rules.

Opus should be thorough, not clever.

Its job is to make the seam trustworthy and the acceptance surface
self-evident.

### Sonnet A / Sonnet B

The Sonnets implement against the pre-approved interface in isolated worktrees
or otherwise isolated contexts.

They receive bounded context groups chosen by Opus.

After implementation:

- Sonnet A reviews/cross-checks Sonnet B's piece;
- Sonnet B reviews/cross-checks Sonnet A's piece;
- an agent's own green tests are not sufficient review;
- disagreements return to Opus.

The Sonnets do not independently redesign the approved interface.

If implementation proves the interface wrong, stop and escalate to Opus and
the owner.

## Proof expectations

Because this is reasoning infrastructure, acceptance needs independent proof
paths.

At minimum demonstrate:

1. **Structural proof** — missing Cards, invalid relations, or malformed
   compositions fail loudly and deterministically.
2. **Replay proof** — save/load or equivalent replay reproduces the same
   canonical tableau and receipt.
3. **Use proof** — in a real ChainSpot reasoning example, rearranging/removing
   one Card or relation changes the working interpretation without mutating the
   underlying knowledge deck.

Additional orthogonal proofs are welcome when they arise naturally.

## Dogfood target

Use a real example from the existing Tee/C2D/occlusion knowledge rather than
making a toy domain the only demonstration.

A successful slice should be able to express and revise something
conceptually like:

```text
[O00-tee] [NEAR] [I17-neighbor-ring]
[C01-complete-occlusion] [EXPLAINS?] [H5]
[E...] [TESTS] [C01-complete-occlusion]
```

Then challenge/remove/replace the explanation while preserving all underlying
Cards.

The demo is not meant to prove that exact hypothesis.

It proves that nuanced working understanding can be composed, challenged, and
rearranged from durable pieces.

## Integration

Feature lane: `lab/card-tableau`

Waiting room: `staging/lab`

The feature lane branches from the LAB trunk, never `staging/lab`.

`staging/lab` never merges back into this lane.

A staging merge is not complete until the combined system demonstrates through
a real LAB run and self-evident receipt.

## Planning question for Opus

Before implementation, answer:

> What is the smallest compositional substrate that lets an agent externalize
> a nuanced, revisable working interpretation from existing Cards without
> accidentally turning the deck into a Frame system, graph engine, or ontology?

Plan until the owner approves.

Then orchestrate the two Sonnets.
