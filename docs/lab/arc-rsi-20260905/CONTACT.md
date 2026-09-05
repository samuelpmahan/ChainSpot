# ARC-RSI world bench — first contact

Status: CONTACTED. No claim that the world or any Stage is solved.

## Custody

Workspace: `/mnt/data/ChainSpot-Sweep-Ready/chainspot`.
Source packet: `ChainSpot-Sweep-Ready-no-chromium(1).zip`.
Packet SHA-256: `49d8a3f8b184f3347eb8143ec868adb8990821cba74a2018e5a54f98787d7fdf`.
All 14 READY_MANIFEST hashes matched (eight critical files, six dev images).
Packet-declared remote checkpoint and branch base: `60f53cd9ae8ab210dc73aa884086e315dccbe0a2`.
Live `lab/dev-pathfinding` was already `40586d29cff388a70293fddd28f3359797f00e5b`; it was not overwritten or silently substituted.
Node v22.16.0; npm 10.9.2. Dependencies and compiled ALG came from the packet. No install, build, repair, or code edit during boot.

## Contact

World location: S0 -> S0.full-to-cropped -> source.cropUDiscChrome.
Reads: px.source.fullImage. Calculations: fn.stripChromeProposal, fn.materializeComposite. Writes: px.course.canonicalPixels.

Command (workspace root):

```sh
timeout --signal=TERM --kill-after=2s 55s ./lab sweep --through S0 ../chainspot-corpus/dev/NorthPark/NorthPark-full.png
```

Exit 0; action stderr empty. Actual `artifacts/sweep/stages/NorthPark-full-through-S0/progression.png` existed (1,337,860 bytes) and was opened visually. Source 1290x2796; crop removed 431 top/254 bottom rows; canonical 1290x2111. Both panels visibly depict the same NorthPark map with major screenshot headers/footer removed on the right.

## GG contact

PRESENT: Sweep, semantic PxC addresses, declared S0 Ticks, S0 PCR specification, source/crop Materialization, isolated S3 experimental contract and warm-state implementation.
PARTIAL: S0 intake (this seam accepts one image); native Stage contracts cover S0-S3, not S4-S7.
UNKNOWN: semantic detection accuracy, warm isolation in this session, safe truth-grader availability, later-stage correctness.

## HUHs

- Embedded WORLD_BOOT still requires Storybook. Current user protocol explicitly permits Sweep and supplies the packet; Sweep was used.
- Discovery guessed stageSweep.ts; rg reported that path missing. Existing stageOperation.ts was found in the directory listing. LAB help itself succeeded; no missing interface was fabricated or repaired.
- Canonical crop visibly retains Apple Maps attribution and MAP/SAT controls. Their downstream effect remains a question, not an inferred causal result.
- Historical engrams require globally complete endpoints before later work and say all missing tees are recoverable. Current protocol permits invisible/UNKNOWN state and local path reasoning; those older dependencies are not acceptance rules.
- Directory freezing is not semantic completion. Prior notes already report visible misses and chrome false positives in frozen S3.

## Next cells

1. Run warm clean S3 on AlexClark, inspect its native panels (+15).
2. Run remaining dev courses and inspect full-course outputs (+13).
3. Trace the safe evaluator boundary without opening Annotation contents (+5).

Active hypothesis: S3's common-family/enclosed-ring model misses distinct tee structures and accepts some screen glyphs. Rival explanations: discovery connectivity, measurement defects, or ownership errors upstream. Falsifier: inspect measured/selected membership against visible pixels, not target counts. No raw Annotation data has been opened. No promotion authorized by these observations.

Remote commit route: GitHub connector create_file/update_file or atomic tree+commit+ref on this isolated branch. Preserve compact experiments and decisions regularly; do not overwrite lab/world or another worker's branch.
