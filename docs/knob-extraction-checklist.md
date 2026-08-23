# Knob extraction checklist — constants → baseline ABFeatures

Work order for extracting threeFactor's hardcoded tunables into baseline
ABFeatures (default-ON, knobs = today's frozen values → zero behavior
change). Read `docs/abfeature-contract.md` first; `features/g5.zfit.ts` and
`features/g3.phantomTee.ts` are the reference shapes.

## Inventory (phase 1 — read-only)

For every tunable constant in the assigned files, record:

| constant / literal | value | file:line (use site) | what it does (one clause) | proposed cluster |

Tunable = a number (or array of numbers) that shapes detection outcomes:
thresholds, sigmas, radii, strides, weights, percentiles, iteration counts,
window sizes, HSV bounds. NOT tunable: array indexing math, RGBA stride 4,
coordinate arithmetic, 0/1 identity values, loop bounds derived from data.
When unsure, include it and say why in the description — over-report.

Clusters (extraction order): `g4.scoring` (tee/badge geometry: sigmas,
fractions, collinearity) → `g4.search` (assignment search: top rows,
exchange passes, dedupe radius) → `st.straightTest` → `g5.ribbon` (support
field: sigma, percentile, gamma, quantum, ring) → `g5.routing` →
`g3.endpoints` (hole/ring windows, elongation) → `g3.screenChrome` →
`g2.sprite` → `g1.badges` → `g1.digits` → `shared.hsv`.

## Extraction (phase 2 — one cluster per commit, serial)

Per cluster:

1. **Feature file** `features/<cluster>.ts`: `kind: 'baseline'`,
   `defaultEnabled: true`, one knob per constant — `default` byte-equal to
   the current literal, `note` from the inventory description, `validate`
   only where an invalid value would crash (NaN, negative radius); don't
   invent constraints the code never had.
2. **Registry line** in `features/registry.ts`.
3. **Thread knobs** to use sites: the owning EngineUnit resolves
   `ctx.resolve(feature).knobs` once and passes values down as plain
   parameters. Move, don't rewrite — the diff should read as
   literal → named parameter, nothing else.
4. **Verify** (all must pass before the commit):
   - `npx vitest run` — the parity pin (`threeFactorParity.test.ts`) MUST
     stay green untouched. If it fails you transcribed a value wrong; fix
     the value, never the pin.
   - Re-pin the resolved-config hash in `threeFactorConfig.test.ts`
     (expected to move — feature universe changed).
   - Regenerate `configs/threeFactor-config.schema.json` (the failing
     schema test prints the expected JSON).
   - `npm run check` — 0 errors 0 warnings.
5. **Commit** that cluster alone: feature file + threading + both re-pins +
   schema. Message names the cluster and knob count. NO double quotes in
   commit messages (PowerShell harness).

Rules:
- Baseline features' `enabled` flag is not consulted by extraction — the
  knobs always apply. (Turning a baseline OFF is future work; do not build
  it.)
- Do not restructure code, rename existing symbols, or add instrumentation
  in these commits — knobs only.
- A constant used in two clusters belongs to the earlier one; the later
  cluster consumes it via the same feature.

## Sign-off (phase 3 — reviewer)

- `grep` the touched files for surviving numeric literals; every survivor
  is either on the not-tunable list or gets a written reason.
- Spot-check 5 random knobs: default equals the pre-extraction literal at
  the recorded use site (git blame / old commit).
- Full suite + check green; one live /lab run on the REC pair.
