# Test fixtures

Repository-controlled, privacy-safe synthetic images used by the foundation decoding tests and by later image-workspace tests.

| File | Format | MIME type | Dimensions | Content |
| --- | --- | --- | --- | --- |
| `tiny.png` | PNG, 8-bit RGB | `image/png` | 2x3 (portrait) | Solid red |
| `tiny.jpg` | Baseline JPEG, YCbCr 4:4:4 | `image/jpeg` | 5x4 (landscape) | Solid black |
| `acceptance-source-overview.png` | PNG, 8-bit RGB | `image/png` | 640x420 (landscape) | Synthetic map overview with five marked landmarks |
| `acceptance-clean-map.png` | PNG, 8-bit RGB | `image/png` | 960x540 (landscape) | Synthetic clean-map view with the matching five landmarks |

## Convention

- Fixtures are deterministic and repository-controlled. No external tools, user images, or third-party generators are required.
- Regenerate both files with `node scripts/generate-test-fixtures.mjs`.
- Regenerate the P0-014 acceptance images with `node scripts/generate-acceptance-fixtures.mjs`.
- Container-level decoding (signature, intrinsic dimensions, MIME) is verified in `tests/unit/fixture-decode.test.ts`; real Chromium decoding is verified in `tests/e2e/shell.spec.ts`.
- The acceptance landmarks are synthetic and privacy-safe: source pixels `[(90,70), (520,65), (120,330), (350,205), (560,350)]` correspond to target pixels `[(140,90), (780,80), (170,420), (520,270), (840,420)]`.
