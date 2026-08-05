# Test fixtures

Repository-controlled, privacy-safe synthetic images used by the foundation decoding tests and by later image-workspace tests.

| File | Format | MIME type | Dimensions | Content |
| --- | --- | --- | --- | --- |
| `tiny.png` | PNG, 8-bit RGB | `image/png` | 2x3 (portrait) | Solid red |
| `tiny.jpg` | Baseline JPEG, YCbCr 4:4:4 | `image/jpeg` | 5x4 (landscape) | Solid black |
| `acceptance-source-overview.png` | PNG, 8-bit RGB | `image/png` | 640x420 (landscape) | Synthetic map overview with five marked landmarks |
| `acceptance-clean-map.png` | PNG, 8-bit RGB | `image/png` | 960x540 (landscape) | Synthetic clean-map view with the matching five landmarks |
| `smart-import/smart-ul.png` | PNG, 8-bit RGB | `image/png` | 200x200 (square) | Upper-left tile of a deterministic 2x2 synthetic course |
| `smart-import/smart-ur.png` | PNG, 8-bit RGB | `image/png` | 200x200 (square) | Upper-right tile of the same course |
| `smart-import/smart-ll.png` | PNG, 8-bit RGB | `image/png` | 200x200 (square) | Lower-left tile of the same course |
| `smart-import/smart-lr.png` | PNG, 8-bit RGB | `image/png` | 200x200 (square) | Lower-right tile of the same course |

## Smart-import fixture sets

All sets are derived from the same seeded scene in `tests/helpers/smartMap.js`,
so the unit-test rasters, the PNGs, and the analysis always agree.

### `smart-import/` (strong, P1-001)

The default coherent capture: same device, zoom, and orientation; 200x200 tiles
with 25% overlap (50px per shared edge) arranged as a fixed 2x2; and a repeated
uniform chrome band at the top (4px) and bottom (3px) of every tile. The correct
2x2 arrangement wins with high edge scores, the lower-right path agrees, and the
shared crop is proposed with high confidence.

### `smart-import/weak/` (P1-002)

A weak-but-recoverable capture: the same course with only 17.5% overlap (35px
per shared edge), below ChainSpot's intended 20-30%. Every pairwise match is
still credible, so the best attempt loads, but classification reports a
**weak horizontal/vertical overlap** review warning instead of strong.

### `smart-import/incompatible/` (P1-002)

An internally contradictory capture: every pairwise match is credible, but the
lower-right tile is displaced 10px vertically, so the two redundant lower-right
paths disagree (~20px) and the vertical step is inconsistent. Classification is
**uncertain** with **contradictory lower-right position** and **mixed zoom**
warnings, and the four files load into the manual starting layout without
claiming success.

### `smart-import-large/` (P1-002, generated on demand)

A repository-controlled large set (four 1600x1200 tiles, coherent 25% overlap)
used by `scripts/perf-smart-import.mjs` to time decode + analysis in Chromium.
Generated on demand with `node scripts/generate-smart-import-fixtures.mjs --large`
to keep the committed repository lean; it is not part of the normal test suite.

### Unit-test-only variants

The pure unit tests build rasters directly with additional `buildGrayRaster`
overrides: `origin` (inconsistent grids), `unrelated` (a tile from a different
capture), `repetitive` (a periodic field that makes many placements nearly
equally plausible), and `chromeTop`/`chromeBottom` (missing or differing chrome).

- The shared source of truth is `tests/helpers/smartMap.js`; both the unit-test
  rasters and these PNGs are derived from the same seeded value-noise map,
  roads, landmarks, and chrome bands, so they always match.
- The unit tests build grayscale rasters directly (no decode, jsdom-safe); the
  browser test selects these PNG files in an order unrelated to their roles.
- Regenerate with `node scripts/generate-smart-import-fixtures.mjs`.

## Convention

- Fixtures are deterministic and repository-controlled. No external tools, user images, or third-party generators are required.
- Regenerate both files with `node scripts/generate-test-fixtures.mjs`.
- Regenerate the P0-014 acceptance images with `node scripts/generate-acceptance-fixtures.mjs`.
- Container-level decoding (signature, intrinsic dimensions, MIME) is verified in `tests/unit/fixture-decode.test.ts`; real Chromium decoding is verified in `tests/e2e/shell.spec.ts`.
- The acceptance landmarks are synthetic and privacy-safe: source pixels `[(90,70), (520,65), (120,330), (350,205), (560,350)]` correspond to target pixels `[(140,90), (780,80), (170,420), (520,270), (840,420)]`.
