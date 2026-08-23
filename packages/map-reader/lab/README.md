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

A plain `npm install` at the repository root is enough — the LAB's TypeScript
runner is a devDependency of `@chainspot/map-reader`, which the root workspace
installs.

## Where this sits

The LAB lives inside the package that owns the algorithm
(`packages/map-reader/`), not beside the app. That is the point of the layout:
the algorithm, the evidence about it, and the gates that evidence has to clear
are one unit, and the app consumes that unit through a single exported contract
(`packages/map-reader/src/index.ts`).

Two tests hold that boundary up, and both fail on a real violation rather than
merely documenting the rule:

- `tests/isolation.test.ts` — no import in the package may escape it, no bare
  module may go undeclared, and no browser or Node runtime global may appear.
- `tests/surface.test.ts` — the package's exported names are pinned, so a change
  to what the app can see is a deliberate diff instead of a surprise.

The practical consequence is that algorithm branches and app branches can
diverge freely: the only thing they share is the contract. Divergence behind it
costs nothing; divergence _on_ it reaches every branch at once, which is why it
is the one part held still.

## Porting status

The LAB currently lives in two places, and this directory is the destination
rather than the source. Files here came from `codex/lab-smart-basket-finish`,
where the LAB sits alongside `src/lib/nuthing/` — an older layout of the same
detector code that this package now carries as `src/threeFactor/`.

**Ported (no dependency on detector source):**

| file              | what it holds                                             |
| ----------------- | --------------------------------------------------------- |
| `invariants.ts`   | invariant cards I00–I21                                   |
| `detectors.ts`    | detector cards D00–D12                                    |
| `gates.ts`        | LAB gates 0–7                                             |
| `cases.ts`        | hard-evidence case cards, cross-checked against the above |
| `basketFamily.ts` | provisional basket family signal card                     |

**Not ported — these import `src/lib/nuthing/*`, which does not exist here:**

| file        | blocked on                                                                             |
| ----------- | -------------------------------------------------------------------------------------- |
| `gate2.ts`  | `badgeStage`, `smartBasket`, `viewport`, a PNG decoder                                 |
| `gate3.ts`  | `badgeStage`, `endpoints`, `teeCandidates`, `viewport`, decoder                        |
| `orient.ts` | `scripts/nuthing/pair-matrix*.ts`, `scripts/lab-grid.ts`, and a raster corpus checkout |

Unblocking them means reconciling `src/lib/nuthing/` with
`src/lib/detectors/threeFactor/`. After both trees were put on the same prettier
config, most of that gap turned out to be formatting: `components.ts`,
`raster.ts`, `families.ts`, `digits/normalize.ts` and `digits/segment.ts` are now
byte-identical between the two, which is what makes the remaining merge legible. The real remaining divergence is `ribbon.ts`
(substantial), `badgeStage.ts`, `endpoints.ts`, and two `digits/` files, plus the
LAB-only modules with no product counterpart (`teeCandidates.ts`,
`smartBasket.ts`, `candidatePool.ts`, `chamfer.ts`, `twoPass.ts`, `viewport.ts`,
`badgeOcclusion.ts`, `npcompat.ts`, `p1.ts`, `digits/{features,logistic,prototype}.ts`).

That reconciliation is a separate, reviewable change. It is not attempted here.

One consequence to be aware of while reading cards in this tree: the ported cards
still cite their original `src/lib/nuthing/...` implementation paths, because
those strings are recorded provenance rather than live references. `./lab
detectors D04` will point at `src/lib/nuthing/endpoints.ts`, which does not exist
here; the code it describes is `packages/map-reader/src/threeFactor/endpoints.ts`. The card text is left exactly as it was written when the evidence was
gathered; rewriting it to point at this package would assert
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

What the cards do _not_ do is check the code. An invariant states what the
renderer was observed to do and what a detector should therefore avoid assuming;
nothing enforces that the detector complies. Treat a card as a claim with
evidence attached, and the `retest` field as the procedure that would falsify it.

## Open decisions

These are choices the port deliberately did not make. Each one changes behaviour
or ownership, so they belong to whoever owns the algorithm, not to a mechanical
move.

**Which crop does the algorithm own?** `nuthing/viewport.ts` is the one module
not ported. It called `proposeSingleImageCrop` from the LAB branch's
`src/lib/stitch/autoCrop.ts` — deliberately delegating to a validated production
crop instead of forking one. That module has no counterpart in the app tree,
whose `src/lib/autoCrop.ts` is a different implementation exposing only
`proposeSharedCrop(rasters[])`. Three ways out: bring the LAB's stitch crop into
the package, point the algorithm at the app's crop, or make the proposer an
argument so callers choose. Cropping is a detector concern (`D00-map-viewport-crop`),
so this is not merely plumbing. Nothing ported depends on `viewport.ts`; only the
unported `gate2`/`gate3` do.

**Do the two implementations merge, and which wins where?** `nuthing/` and
`threeFactor/` are both in the package now, side by side. Five modules were
byte-identical and are kept as one copy (see below). The rest still differ, and
the differences are algorithm decisions rather than merge conflicts:

| module                 | differing lines | note                                  |
| ---------------------- | --------------: | ------------------------------------- |
| `ribbon.ts`            |            1347 | nuthing 1200 lines vs threeFactor 247 |
| `badgeStage.ts`        |             147 |                                       |
| `endpoints.ts`         |              63 |                                       |
| `digits/badgeGlyph.ts` |              14 |                                       |
| `digits/readBadges.ts` |              10 |                                       |

`threeFactor/` additionally has `assignment`, `measure`, `routing`, `scoring`,
`screenChrome`, `types` and the sprite/logistic assets, which `nuthing/` lacks.
`nuthing/` has `p1` (a pipeline entry, `runNuThingP1`), `smartBasket`,
`teeCandidates`, `chamfer`, `candidatePool`, `badgeOcclusion`, `twoPass`,
`npcompat` and three `digits/` modules, which `threeFactor/` lacks. Nothing here
is dead: every module has importers.

**Shared modules.** `components.ts`, `families.ts`, `raster.ts`,
`digits/normalize.ts` and `digits/segment.ts` were byte-identical after both
trees were put on the same prettier config. The `nuthing/` copies are now
one-line re-exports of the `threeFactor/` originals, so there is a single
implementation of each. This was mechanical — byte equality was checked, not
assumed — but it is still a structural choice, and reverting it is five file
restores.
