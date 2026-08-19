# Step 3 endpoint Replay proof

Status: implemented for review; not committed.

## Scope

The real-pixel Replay graph now runs:

`raster.decode -> viewport.crop -> mask.bright-dark -> components.bright -> badges.detect -> baskets.sprite-match -> chrome.attribute -> tees.candidates -> endpoints.evaluate`

The component, badge, basket, chrome, and tee nodes wrap the existing NuThing implementations. No supplemental recovery implementation is wired.

Course raster, truth, optional per-case viewport configuration, and the historical reference matrix are resolved from `experiments/chainspot-lab/ablations/step3-endpoint-baseline.json`. AlexClark evaluation uses only checked-in H1-H3 truth. The other four courses use their full 18-hole development truth.

## Persistent evidence

Evidence store: `/home/mahansa/workspace/chainspot-lab-evidence-step3-20260819-1523`

| proof | run ID | experiment | cache |
|---|---|---|---|
| cold five-course run | `e1e16a26-7b48-41c0-ad53-e752d72508f0` | `75fe34b2d8d978668fe031dda33e0a44be2be9d68b626ea56801a4789b5cebab` | 0 hit / 45 miss |
| identical replay | `6fd5a101-4ae0-45f4-9e35-5933e72abae0` | same | 45 hit / 0 miss |
| `chrome.none` switch | `a8503769-733a-477c-a750-30f9e3e072ee` | `68341e21b090923b909cce8dcb1d64cd99359e3cbfba7bd8ecfa712733958446` | 30 hit / 15 miss |

The chrome switch reused raster decode, viewport, masks, components, badges, and baskets for all five courses. Only chrome, tee candidates, and evaluation reran.

The ledger contains 3,668 stable entities, 9,847 run-to-entity links, and lineage relations for component classification/support, ring/candidate derivation, chrome grouping, and chrome attribution.

## Baseline evaluation

| course | truth | raw tees | chrome suppressed | free tees | tee recall | basket recall |
|---|---:|---:|---:|---:|---:|---:|
| AlexClark | 3 | 33 | 8 | 25 | 3/3 | 3/3 |
| DashsTrack | 18 | 29 | 10 | 19 | 18/18 | 18/18 |
| Heritage | 18 | 54 | 8 | 46 | 15/18 | 18/18 |
| Lenard | 18 | 63 | 7 | 56 | 18/18 | 18/18 |
| TowneLake | 18 | 32 | 3 | 29 | 18/18 | 18/18 |

Heritage baseline misses remain H5, H6, and H10. This is the expected pre-recovery recall pattern: 69/72 across the four fully annotated courses.

The three PNG courses exactly match the historical matrix in `docs/nuthing-p2/screen-chrome-attribution.md`. AlexClark and DashsTrack retain the same truth recall but differ in candidate counts because the historical report used OpenCV-generated RGBA traces while the proven source-raster Replay node uses the declared `jpeg-js` decoder. The ablation records both the historical reference and its decoder, and the CLI reports the difference rather than claiming pixel parity. Endpoint thresholds were not changed to erase this decoder-boundary evidence.

## Validation

- `npm run test:lab-foundation` - 10 tests passed.
- `npm run test:lab-replay` - one Step 2 multi-stage real-pixel acceptance scenario passed.
- `npm run test:lab-endpoints` - one Step 3 five-course Replay, lineage, query, and invalidation scenario passed.
- Strict TypeScript check for the lab scripts passed.
- `npm run check` passed with the repository's existing warnings.
- `npm run build` passed with the repository's existing warnings.
