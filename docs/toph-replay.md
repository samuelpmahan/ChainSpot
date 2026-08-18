# Toph counterfactual replay (dev tool)

This is a **dev-tool surface only** — it does not ship in the Svelte app and
does not change production behavior. It lets you re-run the Pancake CV
pipeline (P1 → P6.2 → final display grammar) against a fixed image under
different `ChainSpotCvConfig` values, and inspect the result stage-by-stage
in a local diagnostic viewer, using [Toph](https://github.com) (a sibling
counterfactual-replay tool, developed against a pinned cross-repo contract —
see `/tmp/.../replay-contract.md` in the environment this was built in, or
ask the lead for the current copy).

## Requirements

- Both repos checked out on disk: this repo (ChainSpot) and Toph. By
  default the scripts look for Toph at `../toph` (a sibling directory) or
  `/workspace/toph`; override with `--toph-dir <path>` or the `TOPH_DIR` env
  var.
- `npm install` run in **both** repos. There is no npm package dependency
  between them — ChainSpot's scripts import Toph's TypeScript sources
  directly by absolute/relative path (tsx-resolvable), so Toph's own
  `node_modules` must be present for its imports to resolve.
- `tsx` (already a devDependency here).

## Launch the viewer

```bash
npx tsx scripts/toph-viewer.ts \
  --image resources/cv-fixtures/TheRec-stitched.png \
  --truth resources/cv-fixtures/the-rec.json \
  [--session .toph-sessions/the-rec] \
  [--port 4173] \
  [--toph-dir ../toph]
```

This creates (or reuses) a replay session under `--session`, ensures a
baseline run exists, and starts an HTTP server printing the URL to open. The
page has: a raster pane with entity overlays and pixel-click lineage, a
stage scrubber, a parameter pane generated from `CV_PARAM_SCHEMA`, an
experiment tree, an A/B diff panel (config diff + first-divergent-stage),
a grid-search form, and a sortable runs table.

`--truth` is optional; when given a fixture with independent basket ground
truth (a bare `TruthHole[]` JSON array — see `p6AssignmentScoring.ts`), the
adapter also reports `assignment.correct`/`assignment.incorrect` in each
run's summary. `resources/cv-fixtures/the-rec.json` intentionally has *no*
independent basket ground truth (it records observed, not verified,
behavior), so scoring is silently skipped for it — this is expected, not a
bug.

## Programmatic use

`scripts/toph-replay-adapter.ts` exports `createChainSpotReplayAdapter`,
Toph's `ReplayAdapter` implemented against the real pipeline
(`runPancakePipeline`, via `scripts/lib/cvReplayCore.ts`'s shared
image/template-loading machinery — the same code `scripts/cv-replay-run.ts`'s
CLI uses). Anything that wants to drive `openReplaySession`/`replay`/`grid`
programmatically (grid search, CI regression checks, a future proof script)
can import it directly rather than going through the viewer's HTTP API. See
`scripts/toph-replay-proof.ts` for a full worked example: baseline, a manual
`p6.swap.enabled=false` toggle, a `minRibbonImprovementPx` grid, and a
manual-toggle-vs-one-point-grid equivalence check.

## Design notes / things that don't fit the naive story

- **Wall-clock timing (`ms`) is intentionally NOT recorded as a Toph
  measure.** Toph's `firstDivergentStage`/`stagesEquivalentThrough` treat
  every recorded measure as a semantic fact for divergence comparison. Wall
  time varies run-to-run even under an identical config (OS scheduling,
  cache warmth, etc.), so recording it as a measure would make two
  behaviorally-identical runs "diverge" at whichever stage happens to jitter
  first — defeating the entire point of the comparison. Per-stage timing is
  still fully visible in the raw `StageExecutionRecord.ms` on disk and in
  each run's `summary.wallMs`; it's just excluded from the structural
  equivalence facts.
- For the same reason, `summary.wallMs` is excluded when checking that a
  one-point grid run is equivalent to the same manual `replay()` call —
  everything else (patch, effectiveConfig, every other summary key) must
  match exactly; `wallMs` is expected to differ by a few hundred ms between
  otherwise-identical runs.
- The "zero-bend shortcut" some earlier investigation mentioned is **not** a
  real P6 lever (see `cvConfig.ts`'s doc comment) and is deliberately not
  exposed in `CV_PARAM_SCHEMA`.
