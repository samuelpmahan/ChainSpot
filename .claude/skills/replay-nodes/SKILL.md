---
name: replay-nodes
description: Restructure a pipeline around replay nodes — immutable cached snapshots at expensive-computation boundaries, so every downstream refinement re-scores from cache instead of re-running measurement. Use this whenever the user says "add replay nodes", "replay boundary", "make this replayable", "cache the expensive part", or whenever you are iterating on the LATER stages of any pipeline whose EARLIER stages are slow (detection, routing, model inference, big joins, API sweeps) — even if the user never says "replay". If you are about to re-run an expensive stage just to test a change in a cheap downstream stage, stop and apply this skill first.
---

# Replay nodes

A replay node is a persisted, immutable snapshot placed at the boundary
between an **expensive measurement** and the **cheap interpretation** built
on top of it:

```
  inputs (raster / corpus / API)
        |
   MEASUREMENT            <- slow: detection, routing, inference, sweeps
        |
  ===== SNAPSHOT =====    <- the replay node: written once, never mutated
        |
   interpretation         <- fast: scoring, ranking, filtering, assignment
        |                    each variant REPLAYS from the snapshot
     results
```

The point is experimental velocity **and** honesty: once the boundary
exists, every experiment is structurally one of two kinds —

- a **measurement experiment** (changed what you measure → must re-run the
  expensive stage and produces a NEW snapshot), or
- an **interpretation experiment** (changed what the evidence means →
  replays from the existing snapshot in seconds).

If you cannot tell which kind an experiment is, the boundary is in the
wrong place. Most iteration loops are interpretation experiments wearing a
measurement experiment's runtime cost — that is the waste this removes.

## How to carve the boundary

1. Time the stages. The boundary goes immediately downstream of the last
   stage whose runtime you are not willing to pay per-iteration.
2. Everything upstream must be **deterministic given recorded inputs +
   config**: record the input identity (file paths + hashes or IDs), every
   parameter, and code-version markers in the snapshot so "same snapshot"
   really means "same measurement".
3. Give every entity a **stable ID** at measurement time (candidate,
   pair, row, span). Refinements, diffs and rank comparisons join on these
   IDs across replays — without them you cannot say what a refinement
   changed.

## What to cache: primitives, not conclusions

Cache what you **measured**, never just what you **concluded**. A final
score can always be recomputed from primitive evidence; the reverse is
impossible, and the refinements you have not thought of yet will need
primitives you did not think you needed.

- Store raw evidence rows: per-entity samples, paths, distances,
  per-sample values — not only aggregates. (In this repo, worst-window,
  orientation-aligned, and zone-attributed scorings were ALL derived later
  from one cached set of path samples + field planes; none required
  re-measurement.)
- Sidecar large arrays as binary files next to the JSON (e.g.
  `<name>-field.bin` Float32 planes) rather than inflating the JSON —
  and include their shape/dtype/params in the JSON so a replay can load
  them blind.
- Write the full config/params block INTO the snapshot, including
  constants you consider obvious. A snapshot that needs the git history to
  interpret is not a snapshot.

## Refinements are pure replays

- A refinement is a pure function: cached snapshot in → new results (or a
  new snapshot) out. It must not edit the cached snapshot in place, and it
  must not silently reach back upstream (re-detect, re-route, re-fetch).
  If it needs something not in the cache, that is a measurement
  experiment: extend the snapshot format, re-measure once, and record the
  format change.
- Make each refinement a **named, independent toggle** (a flag like
  `--zones`, `--invariants`), not an accumulating edit to one scoring
  function. Layered flags give you ablations for free: you can measure
  every layer's contribution and every combination against the same cache.
- Record a **replay record** per run: refinement name, config, runtime,
  and the delta — which entities changed, which were promoted/demoted in
  rank. "What did this layer actually change?" must be answerable from
  the record alone.

## Discipline that makes replays trustworthy

- **Validate before wiring.** Before adding a refinement layer, measure
  its signal on the cached evidence against ground truth (or the best
  proxy you have) as a standalone probe — separation between true and
  false cases first, integration second.
- **Measure every layer.** Report results per-layer and cumulative
  against a fixed judgment set, so each layer's contribution is visible
  and regressions are attributable. Never report only the final stack.
- **Keep the fast oracle fast.** The full measure-then-replay cycle
  should have a one-command entry point; the replay-only path should be
  seconds, not minutes. If replay grows slow, you are probably
  recomputing something that belongs in the snapshot.
- **Never break old caches silently.** If the snapshot format changes,
  bump a version field in it and make the replay refuse mismatches
  loudly.

## In-repo reference implementations

Read these when you want a concrete template (both are working, measured
examples in this repository — see `references/examples.md` for a guided
tour of what each one caches and why):

- `scripts/nuthing/pair-matrix.ts` (measurement: writes the snapshot) +
  `scripts/nuthing/pair-matrix-replay.ts` (interpretation: layered
  re-scoring flags) — JSON evidence + binary field planes, TypeScript.
- `scripts/cv-probes/p3_replay.py` on branch
  `claude/nuthing-p3-endpoint-pairs-bsy3kb` — the same pattern as frozen
  dataclasses (`RasterEndpointSnapshot` → `PathEvidenceSnapshot` →
  `ReplayRecord` with promoted/demoted deltas), Python.
