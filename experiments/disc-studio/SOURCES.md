# Inspected sources and seed provenance

Inspected 2026-09-07. These are source references, not runtime dependencies.

## Repository readings

### ChainSpot

- `main/package.json`: existing SvelteKit/Svelte/static stack, legacy CV/Konva dependencies.
- `lab/stages/package.json`: workspace, Svelte, Vite, Storybook and static build conventions.
- `lab/stages` HEAD inspected: `f13d31728e54ff6f08f21429bd86eda313eafde2`.
- [`src/lib/evidence-workbench/README.md`](https://github.com/samuelpmahan/ChainSpot/blob/f13d31728e54ff6f08f21429bd86eda313eafde2/src/lib/evidence-workbench/README.md): selection/projection versus producer; same pure projection for different inspection surfaces.
- Supplied source snapshot: inspected `src/routes/+layout.svelte`, application routes, `src/lib/components/`, `src/lib/evidence-workbench/`, `.storybook/main.ts`, `.storybook/preview.ts`, `src/lib/geo.ts`, `src/lib/session.ts`, package/Vite/Svelte configuration, `AGENTS.md` and `docs/WORKFLOW.md`. No existing disc-specific object or reusable general product design system emerged from these inspected paths.
- The snapshot's package and evidence-workbench README were compared with the live `lab/stages` versions. This is not a claim that the whole snapshot equals today's upstream branch.

### WumpusLab = samuelpmahan/EmbodiedWumpusWorld

`main` contained only a README, so inspection used the active `lab/wumpus-core` branch at `6043d3566eafa05b340951cd9ee68ed50e24bdf0`.

- [`docs/core.md`](https://github.com/samuelpmahan/EmbodiedWumpusWorld/blob/6043d3566eafa05b340951cd9ee68ed50e24bdf0/docs/core.md): explicit transition seam, readonly projected views, optional composition metadata.
- [`src/browser-workbench.js`](https://github.com/samuelpmahan/EmbodiedWumpusWorld/blob/6043d3566eafa05b340951cd9ee68ed50e24bdf0/src/browser-workbench.js): selected object, frame, alternate controls, inspectable actual values and reasons.

Borrowed interaction/model separation; did not copy the reasoning engine or its data model.

### ChessLab

Inspected `main`; tree `6809fbf084fd1fbfddf01515ae90411a55732aa1`.

- [`README.md`](https://github.com/samuelpmahan/ChessLab/blob/6809fbf084fd1fbfddf01515ae90411a55732aa1/README.md): inspect selected objects; shared execution payload; position edits are not legal gameplay actions.
- [`site/src/chess/boardStory.js`](https://github.com/samuelpmahan/ChessLab/blob/6809fbf084fd1fbfddf01515ae90411a55732aa1/site/src/chess/boardStory.js): pure projection over retained data and editor focus; no move generation or score calculation in the view.

Borrowed pure projection and selection-versus-output distinction; no chess or generic LAB runtime dependency was introduced.

## Seed disc ratings

Ratings are manufacturer-published mold ratings used as editable sample data, not specimen-specific measured flight or buying recommendations. Specimen colors/descriptions are fictional; all seed `image` values are `null`.

| Manufacturer | Mold                         | Speed / glide / turn / fade | Primary source                                                                          |
| ------------ | ---------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Discraft     | Buzzz (two separate samples) | 5 / 4 / -1 / 1              | [Discraft Buzzz](https://www.team.discraft.com/discs/buzzz)                             |
| Discraft     | Zone                         | 4 / 3 / 0 / 3               | [Discraft Zone](https://www.team.discraft.com/discs/zone)                               |
| Innova       | Destroyer                    | 12 / 5 / -1 / 3             | [Innova comparison chart](https://www.innovadiscs.com/disc-golf-discs/disc-comparison/) |
| Innova       | Leopard3                     | 7 / 5 / -2 / 1              | [Innova comparison chart](https://www.innovadiscs.com/disc-golf-discs/disc-comparison/) |
| Innova       | Mako3                        | 5 / 5 / 0 / 0               | [Innova comparison chart](https://www.innovadiscs.com/disc-golf-discs/disc-comparison/) |
| Innova       | TeeBird3                     | 8 / 4 / 0 / 2               | [Innova comparison chart](https://www.innovadiscs.com/disc-golf-discs/disc-comparison/) |

No third-party photographic artwork or font files are packaged. The simple CSS disc illustrations are marked SAMPLE / NO PHOTO; ordinary system fonts are used. Manufacturer/mold words identify the editable examples, not endorsements. The image-pipeline test is synthetic and visibly says it is not a disc photo.

## Framework reference

Svelte's official [state](https://svelte.dev/docs/svelte/$state), [derived](https://svelte.dev/docs/svelte/$derived), and [props](https://svelte.dev/docs/svelte/$props) documentation was consulted. Implementation uses the existing pinned repository dependencies rather than a new framework/library choice.
