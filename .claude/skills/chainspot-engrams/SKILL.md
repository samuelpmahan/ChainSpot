---
name: chainspot-engrams
description: ChainSpot process memory — how work is accepted (receipts), the claims-ledger discipline, the gate model, standing owner policies, and agent operational quirks. Load at the start of any non-trivial ChainSpot task, before diagnosing anything, and before orchestrating agents in this repo.
---

# ChainSpot engrams (process)

## Acceptance = receipts

A piece of work is done when a human can accept it on sight from `./lab`
output: a real run, on real course data, printing a receipt. Full contract
in docs/WORKFLOW.md. Never silently drop a candidate; every number ships
with provenance or a loud UNKNOWN; "never ran" ≠ "ran and found 0" ≠
"not scheduled" ≠ "not enabled".

## The claims ledger (docs/CLAIMS-LEDGER.md)

Every load-bearing diagnosis gets a row WITH its receipt when made, and its
fate (UPHELD / RETRACTED / PENDING). Retraction is first-class; append-only;
update in the same commit as the work. Use the `receipt-reconcile` skill
before entering or resolving rows.

## The gate model (owner's 2026-08-28 arrangement)

G0 intake → G1 badges → G2 baskets → G3 tees → G4 recovery (tee AND basket;
ALL endpoints exist after G4) → G5 straight test (part 1 evidence, part 2
assign+complete straight holes) → G6 bent pathfinding + refinement; zfit
terminal and OFF in the default schedule (zfit-on.json flips it).
`lab sweep --through G1..G7` slices dependency-complete prefixes.

## Standing owner policies (2026-08-28)

- Frozen-baseline ceremony RELAXED until 54-hole and 72-hole proofs exist;
  the receipt contract itself never relaxes.
- **Dev6** = DashsTrack, Lenard, TowneLake, NorthPark, HeritagePark,
  AlexClark. The demo (TheRec FULL + L/R stitch) is gated behind 18
  assignments on every Dev6 course.
- The footgun law: "150 ft holes and 1700 ft holes — mins and maxes like
  that are ALWAYS footguns." No absolute course-distance/size literals;
  course-derived values with printed provenance; raster-cell allowances
  survive but are commented as raster geometry. Index of known offenders:
  docs/minesweeper/.

## Agent operations in this repo

- Rebuild before testing: `npm run build --workspace @chainspot/alg` after
  ANY packages/alg edit — LAB executes dist/, not src/.
- Corpus: sibling checkout at `../chainspot-corpus` (in cloud sessions a
  symlink to a hydrated clone; LFS files fetch via
  media.githubusercontent.com with sha256 verification against pointers).
- Agent worktrees may spawn on a STALE base (old history, no packages/):
  first action is `git log --oneline -1` and, on mismatch,
  `git fetch origin continuation/intake-engine && git reset --hard` to the
  expected commit. A worktree with zero file changes at turn end gets
  auto-deleted — write a progress file immediately and never end a turn
  with no file changes.
- Internal ordinals (`badge-7`) are NOT hole numbers. Map through
  `BadgeEvidence.label` (G1 digit read + confidence); print UNREAD when the
  read is garbage; never guess.
