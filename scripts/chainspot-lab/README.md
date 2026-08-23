# ChainSpot LAB

The LAB is the instrument for the UDisc map reading algorithm: a registry of what
has actually been observed about the renderer, which detectors depend on which
observations, and the gates that evidence has to clear. It is not the algorithm.

Run it with the `./lab` script at the repository root:

```
./lab invariants          # list every invariant card
./lab invariants I21      # print one card in full
./lab detectors D04       # the detector that card constrains
./lab gates 3
./lab cases
```

First use needs its own dependency install, which is deliberately separate from
the root app:

```
(cd scripts/chainspot-lab && npm install)
```

## Why the deps are isolated

The root `package.json` is the clean-room surface from CHSPT-82, where every
dependency has to be explainable. The LAB needs a TypeScript runner (and, once
the gate harnesses land, a PNG decoder) that the shipped app does not. Keeping a
second `package.json` here means LAB tooling can grow without widening what the
application itself depends on. `scripts/chainspot-lab/node_modules/` is covered
by the root `.gitignore`.

## Porting status

The LAB currently lives in two places, and this directory is the destination
rather than the source. Files here came from `codex/lab-smart-basket-finish`,
where the LAB sits alongside `src/lib/nuthing/` — an older layout of the same
detector code that the product tree carries as `src/lib/detectors/threeFactor/`.

**Ported (no dependency on detector source):**

| file              | what it holds                                   |
| ----------------- | ----------------------------------------------- |
| `invariants.ts`   | invariant cards I00–I21                         |
| `detectors.ts`    | detector cards D00–D12                          |
| `gates.ts`        | LAB gates 0–7                                   |
| `cases.ts`        | hard-evidence case cards, cross-checked against the above |
| `basketFamily.ts` | provisional basket family signal card           |

**Not ported — these import `src/lib/nuthing/*`, which does not exist here:**

| file             | blocked on                                                     |
| ---------------- | -------------------------------------------------------------- |
| `gate2.ts`       | `badgeStage`, `smartBasket`, `viewport`, a PNG decoder          |
| `gate3.ts`       | `badgeStage`, `endpoints`, `teeCandidates`, `viewport`, decoder |
| `orient.ts`      | `scripts/nuthing/pair-matrix*.ts`, `scripts/lab-grid.ts`, and a raster corpus checkout |

Unblocking them means reconciling `src/lib/nuthing/` with
`src/lib/detectors/threeFactor/`. After both trees were put on the same prettier
config, most of that gap turned out to be formatting: `components.ts`,
`raster.ts`, `families.ts`, `digits/normalize.ts` and `digits/segment.ts` are now
byte-identical between the two. The real remaining divergence is `ribbon.ts`
(substantial), `badgeStage.ts`, `endpoints.ts`, and two `digits/` files, plus the
LAB-only modules with no product counterpart (`teeCandidates.ts`,
`smartBasket.ts`, `candidatePool.ts`, `chamfer.ts`, `twoPass.ts`, `viewport.ts`,
`badgeOcclusion.ts`, `npcompat.ts`, `p1.ts`, `digits/{features,logistic,prototype}.ts`).

That reconciliation is a separate, reviewable change. It is not attempted here.

One consequence to be aware of while reading cards in this tree: the ported cards
still cite their original `src/lib/nuthing/...` implementation paths, because
those strings are recorded provenance rather than live references. `./lab
detectors D04` will point at `src/lib/nuthing/endpoints.ts`, which does not exist
here. The card text is left exactly as it was written when the evidence was
gathered; rewriting it to point at `src/lib/detectors/threeFactor/` would assert
a correspondence the port has not yet established. Those citations get updated as
part of the reconciliation, not ahead of it.

## Two entrypoints named `lab`

`lab.cmd` at the repository root is a different program: the machine-bound 3fd72
provenance auditor (`scripts/lab-orient-3fd72.mjs`), which checks a frozen source
tag and evidence ledger across a specific Windows + WSL pair of checkouts. It
does not run anywhere else, and it shares no subcommands with `./lab`.

On Windows, typing `lab` runs `lab.cmd`. On POSIX, `./lab` runs this one. That
collision is unreconciled and deliberate for now — naming it is cheaper than
guessing which one should win.

## Reading the cards

`invariants.ts` validates itself on import: card ids must be unique, and every
gate and detector a card names must exist. A card that cites a detector id which
has been renamed will throw rather than print, so the registry cannot silently
drift out of sync with `detectors.ts` and `gates.ts`.

What the cards do *not* do is check the code. An invariant states what the
renderer was observed to do and what a detector should therefore avoid assuming;
nothing enforces that the detector complies. Treat a card as a claim with
evidence attached, and the `retest` field as the procedure that would falsify it.
