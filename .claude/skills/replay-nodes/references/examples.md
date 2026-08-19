# Guided tour of the in-repo replay-node implementations

Both examples below are real, measured pipelines in this repository — not
toys. Read the one in your working language before building a new replay
boundary; copy its structure, not its domain specifics.

## 1. P2 pair matrix (TypeScript, JSON + binary sidecars)

**Measurement** — `scripts/nuthing/pair-matrix.ts`. One run per course:
auto-crop → badge/digit stages → paired-edge support field → per-badge
full-field Dijkstra → per-pair PathEvidence. Writes, per course:

- `<course>.json` — the snapshot: viewport, every endpoint candidate with
  a stable ID (`T3`, `B7`) plus identity metadata (tier, orientation
  angle, onRing, sprite match score), every badge with its routed legs
  (dense cell paths), every pair's evidence row (support samples-derived
  stats, lengths, efficiency, failure reason), the full params block, and
  the truth-match judgments.
- `<course>-field.bin`, `<course>-theta.bin` — Float32 planes (support,
  best-orientation) whose shape/scale live in the JSON. Cached because
  future re-scorings sample them; they enabled strip-coherence and
  zone-attribution scoring with zero re-measurement.

Why primitives mattered here: the measurement step cached *dense leg
paths* + *field planes*, not just scores. Five successive scoring layers
(worst-window, orientation-aligned, basket-zone-attributed, simple-path,
domain-invariants) were all invented AFTER the cache existed and all
replayed from it in seconds.

**Interpretation** — `scripts/nuthing/pair-matrix-replay.ts`. Loads the
snapshot, re-scores every pair, re-ranks, re-judges against the cached
truth matches. Each refinement is an independent flag (`--zones`,
`--simple`, `--invariants`, `--assign`), so ablations are one command:

```
npx tsx scripts/nuthing/pair-matrix-replay.ts CACHE_DIR                    # layer 1 only
npx tsx scripts/nuthing/pair-matrix-replay.ts CACHE_DIR --zones --simple   # layers 1-3
```

Every run prints per-course and total rank metrics against the same
judgment set, so each layer's contribution is a diffable number.

## 2. P3 ReplayNode (Python, frozen dataclasses)

`scripts/cv-probes/p3_replay.py` on branch
`claude/nuthing-p3-endpoint-pairs-bsy3kb`. The same architecture with the
bookkeeping made explicit in types:

- `RasterEndpointSnapshot` — boundary-1 input, fully immutable: image
  path, candidate pools, badges, config. Same IDs + config ⇒ same
  measurement, by construction.
- `measure_from_raster()` — the only function allowed to touch the image;
  produces a `PathEvidenceSnapshot`.
- `PathEvidenceSnapshot` — boundary 2: cached evidence, immutable;
  refinements return a NEW snapshot via `dataclasses.replace`, never edit
  in place.
- `replay_from_evidence(snapshot, refinement_fn, name, config)` — pure
  replay; wraps any evidence→evidence function.
- `ReplayRecord` — provenance per run: boundary kind
  (`raster->path-evidence` vs `path-evidence->path-evidence`), source and
  output snapshot IDs, config, runtime, input candidate IDs, and the
  delta (promoted / demoted / changed pair IDs, computed by rank diff).

The two boundary-kind constants are the "two experiment classes" made
machine-checkable: you can tell from any ReplayRecord whether an
experiment re-measured pixels or reinterpreted evidence.

## Which parts to copy for a new pipeline

- Minimal (a script pipeline you're iterating on): the P2 shape — one
  writer script producing JSON (+ binary sidecars if large arrays), one
  replay script with per-refinement flags and a fixed judgment printout.
- Structured (library code, multiple writers/consumers): the P3 shape —
  immutable snapshot types, a single blessed measurement function, replay
  wrapper, and ReplayRecords with deltas.
- Either way, the non-negotiables are the same: stable IDs, primitives
  not conclusions, params embedded in the snapshot, refinements as named
  toggles, per-layer measurement.
