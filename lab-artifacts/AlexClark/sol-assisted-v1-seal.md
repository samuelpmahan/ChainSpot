# AlexClark assisted blind-pass seal

State A commit: `47fd2e97cbaaf40e6288693d716fa0dd3df73245`.

## Inputs admitted

- Frozen `sol-blind-v1.annotation.json` and blind notes.
- Canonical `AlexClark-cropped.png`.
- Truth-free outputs from `./lab check badges AlexClark`, `baskets`, and `tees`.
- Existing runtime implementations named in each measurement JSON.

## Inputs refused

- AlexClark source annotation/truth and registered annotation resources.
- Alex evaluation reports, pair-matrix/evaluation output, GT-derived caches, endpoint pools produced by truth-loading scripts, and prior evidence-store answers.
- `scripts/cv-probes/hole_path_tee_recovery.py` output and recovered-tee resources: the inspected source consumes truth basket coordinates and contains hard-coded course answers.

## Integrity

- Blind annotation SHA-256: `dbfda792a0a7b808f71d53196de730c096aeff9d5a2883f3d177e6dc6dbdcb69`.
- Badge measurement SHA-256: `64e5e3bbdd52d07b484b1435c1d793c5e3b23c71b4e242d48eca72b6b34bad4c`.
- Basket measurement SHA-256: `e70ea1bab23a89d85ed4ca4d28ef1bdcd0d6692a84bae531ab532219b854b190`.
- Tee measurement SHA-256: `4e9bd61f997d95d25ca26df9df911ab5bf23ad8a0f3185e5c458b4f4e534afbd`.
- Oracle observations: none.
- Frozen does not mean Oracle-approved. These outputs are structured so a future `--gate` can compare them to a separately approved state.
