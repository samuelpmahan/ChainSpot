# NuThing P2 experiment — TypeScript P1 port, candidate pools, digit recognition

Experimental CV work. Nothing here is wired into production; downstream
NuThing path/ownership work is explicitly out of scope.

## Layout

- `../nuthing-p1-canonical.py` — executable Python reference (baseline commit
  8643549). Behavior is preserved, not improved.
- `../../src/lib/nuthing/` — pure TypeScript P1 port (no OpenCV.js/WASM):
  - `raster.ts` — RGBA contract, OpenCV-exact fixed-point HSV thresholds
  - `components.ts` — 8-connected labeling + PCA stats (LAPACK dlaev2 port
    for eigenvector parity)
  - `chamfer.ts` — OpenCV DIST_L2 3x3/5x5 chamfer transforms, fuzzy support,
    inner core
  - `families.ts` — anchored repeated-family discovery
  - `npcompat.ts` — numpy float32 pairwise reductions, rint, quantile lerp
  - `p1.ts` — the full pipeline
  - `candidatePool.ts` — reusable `CandidatePool<T>` (primary / forwarded /
    culled-for-compute-only; 0.40 documented as a theoretical floor, never an
    acceptance threshold)

## Parity workflow

Corpus images are Git LFS files in `samuelpmahan/chainspot-corpus`
(`dev/**`, `validation/FountainHills/**`); hydrate before use and verify the
files decode (a ~130-byte file is an unhydrated LFS pointer).

```sh
# Python side: JSON trace + canonical RGBA dump per image
python3 scripts/nuthing/p1_trace.py IMAGE WORK_DIR/traces-py --name NAME

# TypeScript side: identical-shape trace from the same RGBA bytes
npx tsx scripts/nuthing/run-p1.ts WORK_DIR/traces-py/NAME.rgba.bin WORK_DIR/traces-ts --name NAME

# Compare one image / all images
npx tsx scripts/nuthing/parity.ts WORK_DIR/traces-py/NAME.trace.json WORK_DIR/traces-ts/NAME.trace.json
npx tsx scripts/nuthing/parity-all.ts WORK_DIR/traces-py WORK_DIR/traces-ts docs/nuthing-p2/parity-report.md
```

Parity runs feed both implementations bit-identical RGBA (image-decoder
variance is a separate concern from algorithm parity). The comparator matches
components structurally, tolerates float32 reduction noise (2e-6), exact-tie
permutations, and itemized unstable-axis components (BLAS covariance noise on
degenerate/clipped components); everything else must match. See
`docs/nuthing-p2/parity-report.md` for the current corpus result.
