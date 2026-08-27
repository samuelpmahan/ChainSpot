# ABFeature contract — porting your algorithm work into the engine

> This contract predates the current operation-DAG/Sweep handoff. Use it for
> the ABFeature model, then read
> [`INTAKE-ENGINE-HANDOFF.md`](./INTAKE-ENGINE-HANDOFF.md) for the audited
> branch position, runtime constraints, and current validation results.

The threeFactor detector is now an **engine executing a config**. This doc is
the contract for agents porting in-progress algorithm work, and the spec for
defining "your" alg as a config file. Source of truth for types:
`packages/alg/src/detectors/threeFactor/features/types.ts`. Machine-readable
config schema:
`packages/alg/src/detectors/threeFactor/configs/threeFactor-config.schema.json`
(generated from the registry; drift-guarded by
`tests/unit/threeFactorSchema.test.ts`).

## The one-paragraph model

The algorithm is an ordered list of **units** running over a shared
**evidence board** (named slots: `stage`, `badges`, `supportField`,
`sprites`, `baskets`, `tees`, `rawPairs`, `measurement`, `recoveredTees`,
`assignment`). The order comes from the config's `execution` array —
`configs/default.json` IS the frozen production algorithm, readable top to
bottom. **ABFeatures** are behavior with an A/B easy-off: `baseline` features
ship default-ON; `deviation` features default-OFF, so the default config
reproduces frozen behavior byte-for-byte (pinned by
`tests/unit/threeFactorParity.test.ts`). Every run under a config carries a
`paramsHash` (sha256 of the canonical resolved config) stamped on the trace
and every emission.

Until the detector has accepted 54-hole and 72-hole corpus results, an
approved feature flip is promoted immediately into this frozen baseline:
change it to `baseline`, make its registry default ON, schedule its unit in
`DEFAULT_EXECUTION`/`default.json`, and re-pin the parity receipts in the same
commit. `phantomTee` is explicitly excluded and remains a default-OFF
deviation until complete invisibility makes it necessary.

## Porting a new behavior: the 3-file recipe

Follow `features/g3.phantomTee.ts` — it is the reference port (of the LAB's
C01 predecessor-basket rule) and proves the workflow end to end.

1. **One feature file** `features/<gate>.<id>.ts` exporting:
   - an `ABFeature` (`satisfies ABFeature`): `id`, `gate`
     (`G1|G2|G3|G4|G5|G6|G7|shared`), `kind: 'deviation'`,
     `defaultEnabled: false` (the registry THROWS at import if a deviation
     defaults on), `knobs` with `default` + `note` + `validate` per knob.
   - if the behavior is its own pipeline step: an `EngineUnit` with
     `consumes`/`produces` slot declarations and a `run(board, ctx)` that
     no-ops when `ctx.resolve(feature).enabled` is false.
   - keep a **pure core function** exported for unit tests (see
     `synthesizePhantomTees`).
2. **Two registration lines**: add the feature to `ALL_FEATURES` in
   `features/registry.ts`; if it's a unit, add it to `ENGINE_UNITS` in
   `engine.ts`. (Import-time integrity checks guard duplicates.)
3. **One config file** `configs/<experiment>.json` enabling it — see the
   spec below. The config diff IS your experiment.

Rules that will get your port bounced:
- Never mutate board values you only `consume`; re-`produce` a slot to
  refine it (declare it in both lists — the validator requires an earlier
  producer).
- **No silent drops**: if your code examines-and-rejects candidates, emit a
  rejected drawable with a `reason` per kill
  (`ctx.overlay(id, { type, …, verdict: 'rejected', reason })`). This is the
  debuggability contract — "why 0 tees" must be answerable from the raster.
- Instrument what you measure: `ctx.measure(id, name, value)` (exact
  aggregates), `ctx.overlay(...)` (points/boxes/polylines in ORIGINAL-image
  px), `ctx.heatmap(id, key, float32)` for fields.
- Determinism: no Date/random; identical (pixels, resolved config) must give
  identical output. Knob values come ONLY from `ctx.resolve(feature).knobs`.
- If your behavior modifies an existing unit rather than being its own,
  compose per the allowZfit precedent: config-enabled AND call-site-allowed,
  inert factor recorded as identity either way.

## Config spec ("your" alg as a file)

```json
{
	"$schema": "./threeFactor-config.schema.json",
	"schema": "threeFactor-config@1",
	"name": "my-experiment",
	"note": "what this tries and why",
	"execution": ["badgeStage", "badges", "supportField", "badgeOcclusionPatch",
		"baskets", "tees", "rawPairs", "measurement", "assignment", "phantomTee"],
	"gates": {
		"G3": { "phantomTee": { "enabled": true, "knobs": { "minViableScore": 0 } } },
		"G5": { "zfit": { "enabled": true, "knobs": { "topK": 80 } } }
	}
}
```

- Sparse: list only deviations; omitted features keep registry defaults;
  omit `execution` to inherit the default order.
- `execution` is validated at load: unknown units, duplicates, and
  consumed-before-produced slots fail with the dependency named — a grid
  search over orderings gets a clean valid/invalid signal. Valid ≠ sensible:
  filter orderings by outcome metrics.
- Load in the /lab scrubber via the config file input; the TracePanel shows
  per-unit knobs (deviations starred), timings, measurements, and the
  spatial layers per unit with accepted/rejected toggles.
- Programmatic: `parseConfig(json)` → `resolveConfig(cfg, DEFAULT_EXECUTION)`
  → `sha256Hex(canonicalJson(resolved))` → `runThreeFactor(raster,
  { config, paramsHash })`.

## Parity guards you must keep green

- `threeFactorParity.test.ts` — pinned projection hash of the frozen
  default-path run. Changing it = changing frozen behavior = conscious call.
- `threeFactorConfig.test.ts` — pinned hash of the RESOLVED default config.
  Adding a feature to the registry changes this hash (the feature universe
  is part of config identity) — update the pin in the same commit that adds
  the feature.
- `threeFactorSchema.test.ts` — the checked-in JSON Schema must match the
  registry; regenerate `configs/threeFactor-config.schema.json` when you add
  features/knobs/units (the failing test prints the expected JSON).
