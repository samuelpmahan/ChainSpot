# Brief: expose the consequences

Paste this to a cloud agent starting cold on ChainSpot.

---

## The thesis this work serves

> Stop trying to learn the universe. Build a system that already acts, expose
> the consequences of its actions, and learn the small pieces that make its
> closed loop better.

The system already acts. What it does not do is expose what it did. Every task
below is one clause of that sentence: **make a hidden consequence visible.**
None of them is an optimization. If you find yourself making something faster,
you are on the wrong task.

## What exists and works — do not rebuild it

ChainSpot reads UDisc disc-golf screenshots and recovers course geometry from
pixels: hole-number badges, baskets, tee pads, walk paths.

- `packages/alg` — the algorithm. A config-driven engine: an ordered list of
  units over a shared evidence board. `configs/default.json` IS the frozen
  algorithm, readable top to bottom.
- **ABFeatures**: `baseline` features default ON, `deviation` features default
  OFF, so the default config reproduces frozen behavior byte-for-byte.
  `tests/unit/threeFactorParity.test.ts` pins it. Every run carries a
  `paramsHash` of the resolved config.
- `tests/unit/dashsTrackSweep.test.ts` is the oracle: G1 18/18 digits,
  G2 18/18 baskets, G3 18/18 tees, G4 18/18 assignment.
- `scripts/chainspot-lab` — LAB, the CV workbench. `./lab --help`.

**Read `docs/WORKFLOW.md` first.** It defines the lanes, the receipt, the
waiting room, and the branch topology. It is the process, not a suggestion.

## Hard constraints

1. **`default.json` output stays byte-identical.** Anything new is a
   `deviation` feature, default OFF. Parity proves it. Non-negotiable.
2. **`dashsTrackSweep` stays at 18/18** on every gate.
3. **No silent drops.** `packages/alg/src/detectors/threeFactor/features/types.ts:76`
   already states the rule: *"Filtering code MUST emit a rejected drawable
   (with reason) per killed candidate: no silent drops."* Honor it.
4. **Every number ships with where it came from, or a loud UNKNOWN.**
   Thresholds here are dataset-fit estimates, not physics, and are the first
   suspect when a gate misbehaves.
5. **Nothing is pushed** without showing the user verbatim content first.

## The four tasks, in dependency order

### 1. Wire the suppression sink to the trace channel

`packages/alg/src/detectors/threeFactor/endpoints.ts`, `collectTeePoints`.

This function had five silent `continue`s. One of them —

```js
if (spriteCenters.some((s) => Math.hypot(...) < knobs.teeSpriteExclusionDistance)) continue;
```

— deletes any tee candidate within `teeSpriteExclusionDistance` (24px) of a
basket sprite, with no record. **That is the occluded case, not the absent
case.** Three separate agents have looked at output with a tee missing,
concluded the detector was broken, and rewritten correct code. This one line
has destroyed the same capability three times.

An optional `suppressed?: SuppressedTee[]` sink already exists and records
reason, failing value, and the limit it failed against. It is **not wired**.
The caller (`measure.ts`, `excludeAndAssembleTees`) has `ctx` and must turn
each suppression into a rejected drawable with its reason — satisfying the
existing rule rather than inventing a parallel path.

### 2. Count closure

Nothing anywhere asserts that N badges implies N tees, N baskets, N
assignments. Grep confirms zero hole-count assertions in the whole repo.

G1 gives you N for free (max badge number). Every gate should emit
`expected N / resolved M / unresolved [hole numbers]`.

**A deficit is not a failure — it is a located occlusion.** "G3 resolved 17 of
18; hole 7 unresolved" tells you *which hole* is hidden, with no geometry and
no new detector. Arithmetic. This is the only thing that can expose the
consequence of a *missing* action, which a silent `continue` can never show.

### 3. Renderers

`scripts/chainspot-lab/sweep/rendererContract.ts` has a `RENDERERS` registry
for 8 artifact kinds. **One is implemented** (`mask`). `lab sweep` reports
"2 rendered, 7 stubbed".

Follow `sweep/renderers/mask.ts` as the reference. Each renderer writes a PNG
plus a receipt. `rgba` (the base layer) and `componentSet` (blobs found on the
b/w raster, drawn over the mask) are the next two and the most valuable.

Note `RendererInput.baseRasterPngPath` exists for overlay kinds and is
currently hardcoded `undefined` in `artifactIo.ts` — same shape of gap as
`dims` was.

### 4. Pathfinder gate (design only unless told otherwise)

The precondition: **every hole must have a tee before path search is
permitted.** Tees gate pathfinding; badges and baskets are solved.

Depends on 1 and 2. With rejection records and count closure, an unresolved
hole can be completed by a *targeted second pass*: search near that hole's
badge at a permissive threshold, starting from the suppressed pool — a tee
dropped for being near a basket is exactly the occluded case. Strict globally,
permissive in one small window where the count guarantees an answer exists.

## The acceptance gate

**The CLI output itself must be self-evident.** A human accepts or rejects by
reading `./lab ...` output, without opening a source file. "Tests pass" is not
acceptance. A receipt states: what ran (config, `paramsHash`, course), what it
saw, what it rejected and the value that failed which threshold, **what it
could not see**, every number with provenance, and what changed vs frozen.

If a number appears with no provenance, the receipt failed. If something is
missing with no line explaining why, the receipt failed.

## Environment

### If you are on Linux (cloud agents, CI, containers)

Most of what follows does not apply to you. `@esbuild/linux-x64` is already
correct for your host. Ignore any mention of WSL.

What you DO need:

1. **The corpus is a SEPARATE SIBLING REPOSITORY.** Almost every real run and
   most tests read `../chainspot-corpus`. Clone it next to this repo, not
   inside it:
   ```
   git clone <corpus-remote> ../chainspot-corpus
   ```
   Without it you will get confusing ENOENT failures deep inside tests.
2. **Node >= 22.**
3. **Build the algorithm before using LAB.** LAB consumes `packages/alg/dist`,
   not `src`. Installing the LAB package runs a postinstall that bootstraps it:
   ```
   npm install
   cd scripts/chainspot-lab && npm install && cd ../..
   ./lab --help
   ```
   **Re-run the alg build after ANY edit under `packages/alg/src`**
   (`cd packages/alg && npm run build`), or you will test stale code and
   conclude your change did nothing. This has already cost time.

### If you are on Windows (the owner's local machine)

- **Nothing runs natively.** `@esbuild/linux-x64` is installed; Windows needs
  `win32-x64`. Every `lab` command goes through `tsx`. Use WSL:
  ```
  wsl -d Ubuntu -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh";     nvm use 22.22.2; cd /mnt/d/LAB/ChainSpot && ./lab <args>'
  ```
  WSL's PATH resolves `npm` to Windows nvm4w, which is why `node` looks
  missing. Sourcing nvm explicitly is required.
- **Git Bash mangles paths starting with a dot.** `git show <ref>:.github/...`
  silently returns nothing and exits 0. Use `MSYS_NO_PATHCONV=1`.

### If you are working in a git worktree

A worktree gets source only — no `node_modules`, no `dist`. `./lab --help`
works (cold help is dependency-free) but nothing else does.

**Do not symlink `node_modules` from another worktree.**
`scripts/chainspot-lab/node_modules/@chainspot/alg` is itself a symlink to
`../../../../packages/alg`, so a shared `node_modules` makes you silently test
a DIFFERENT worktree's algorithm while editing yours. Run the install in the
worktree instead — it takes about 30 seconds.

## Repository facts that will mislead you

- **The trunk is `origin/codex/lab-ui-hardening`**, despite the name. Lanes
  branch from it.
- **`main` is 336 commits behind and on a DIFFERENT lineage.** Shared ancestor
  is `4da01fb` (2026-08-17), before the CHSPT-82 rebuild moved every file from
  `src/lib/detectors/` to `packages/alg/src/`. Do not merge toward main. Do not
  use it as a review base.
- `docs/unported/` is rescued prose from unmergeable branches. Reference only.
- **Truth scoring is broken for 4 of 5 annotated courses.** Their annotations
  record source dimensions that no longer match their images; only DashsTrack
  still pairs. `matchTruth` returns null and `lab sweep` prints one quiet line
  and discards the scoring. The fix is to recover the offset from the
  correspondences, not to add a tolerance.
- **`ASSOCIATION_TOLERANCE_PX = 26` is inherited, not derived**, and copied into
  five files. Measured median tee error is **0.32px**. The tolerance is 81x the
  actual error and wider than `teeSpriteExclusionDistance` (24), meaning a
  "match" can be farther away than the distance at which the algorithm treats
  two objects as the same. Do not trust it as a quality signal.

## What not to do

- Do not optimize. Not the 10.5s `supportField`, not anything.
  `features/g5.supportRoi.ts` is parked deliberately; read its header before
  reviving it.
- Do not reorder `default.json`'s execution list. It moves the parity hash.
- Do not add a threshold to decide whether to look at something. If the
  coordinates can work, use them and report the result.
- Do not merge lanes into each other. They meet in `staging/lab`.
