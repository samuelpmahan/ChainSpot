# Separate S0 and S1 Mermaid PCR proof

Status: implementation written; compilation, tests, execution and rendering await
Sam's requested post-implementation checkpoint review. No parity claim yet.
Base: fa44a4505d9aafbf6d2d21a12400298edb7fa96d.

From repository root, after checkpoint acceptance:

```sh
node ../chainspot-s0-smoke-deps-fa44/ChainSpot-Sweep-Ready/chainspot/scripts/chainspot-lab/node_modules/tsx/dist/cli.mjs experiments/mermaid-s0-s1/run.ts ../smoke-inputs-fa44/DashsTrack-full.jpg artifacts/mermaid-s0-s1
```

Focused validation, separately:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/s0-mermaid-pcr.test.ts
```

The CLI imports TypeScript source directly. It does not run LAB's dist build.

Authored inputs: experiments/mermaid-s0-s1/S0.mmd and S1.mmd, each with its
same-named args.json. The combined S0-S1 graph and S0-S1.pcr.yaml are historical
drafts, not inputs to this entry point. Separate YAML files are generated when
the proof runs; no generated output from this revision exists yet.

compiler.ts supports one explicit flowchart subset, declaration-order execution,
named input arrows, one publication per Calculation, and direct function-result
arrows. It rejects cycles/forward dependencies, duplicate writers/input bindings,
unknown argument IDs and unsupported syntax. It does not parse general Mermaid.

runner.ts is an isolated experimental async interpreter over existing PxC.call;
it is not integrated with shared PQL, Stage routing, browser inspection or S2.
It records each actual call and its values by reference. Run records are returned,
not published into PxC; FullImage is retained for inspection, not separately cached.
Only explicit graph publications write result Parts to PxC. Source setup and S1
registration also seed required inputs/model/raster using existing code.

The crop-bounds Part contains the existing StripChromeResult (including insets
and proposal metadata), rather than a newly invented rectangle representation.

proof.ts independently executes legacy S0 and existing S1 YAML for comparison.
It checks canonical bytes, crop proposal, decode count, direct reference identity,
S1 bindings/args/output addresses, all S1 intermediate values and full public
output values, including ownership declarations and pixel sets. Legacy FullImage
publication/cache are permitted; generated S0 has no separate cache call.

CLI outputs: two generated YAMLs; readable receipt; actual-runs.v8 retaining typed
arrays and shared references; baseline/generated canonical PNGs; separate exact
owned/muted/remaining masks. Failure preserves the successful prefix and failing
Calculation in failed-run.v8 plus readable failure.json. Raw records can be loaded
with node:v8 deserialize. This is basic inspection, not a finished browser viewer.
