# Intake engine handoff

Current as of 2026-08-27. This is the transfer note for the local
`continuation/intake-engine` line. `docs/CLOUD-BRIEF.md` and
`docs/WORKFLOW.md` describe an earlier orchestration phase and are not the
current branch or accuracy contract.

## Git position

- Received remote base: `origin/continuation/intake-engine` at `cf40f85`.
- Local branch: `continuation/intake-engine`, tracking that remote.
- `279a3a8` adds the shared contextual-help catalog, CLI help/error routing,
  browser help API, and accessible help drawer.
- `d4829cc` checkpoints all 32 files that arrived dirty, including the
  previously untracked SmartBasket and Sweep receipt test files.
- `c061a5c` makes Sweep execution, provenance, cutoff,
  and trace receipts match what they claim.
- The line is published at `origin/continuation/intake-engine`.

## What the checkpoint contains

- G2 SmartBasket renderer-family localization with clean and local-occlusion
  recovery evidence.
- G3 ring-only visible-tee detection followed by the default-ON `teeFamily`
  selector and oriented full-pad geometry.
- G4 default-ON shard recovery for assignment-missing tees, using every
  fitting visible white component and the badge-axis geometry contract.
- `phantomTee` remains a default-OFF deviation and is not scheduled by the
  frozen production config.
- Config/schema/operation-DAG integration.
- Trace-driven Sweep renders, receipts, truth grounding, and regression tests.
- Contextual CLI and browser help generated from one catalog.

This is a coherent endpoint baseline: easy visible tees are found at G3 and
occluded shard-supported tees are completed at G4.

## Hardened contracts

1. Sweep resolves config-backed zfit/ribbon/routing parameters before seeding
   the execution board. Custom knobs now affect the measured run, not only its
   config hash and trace. Caller-explicit numeric/routing parameters retain
   precedence; an enabled zfit ABFeature is intentionally authoritative over
   the legacy caller boolean.
2. An official truth scoreboard requires verified truth in the canonical
   execution frame. Dimensions-only correspondence is untrusted. A stitched
   multi-input reconciliation is downgraded unless truth exactly identifies
   the canonical composite; completely unmatched truth produces neither a
   scoreboard nor grounding evidence, and unmapped truth is never scored in
   raw coordinates.
3. `lab sweep --through` currently accepts only `G1`, `G2`, and `G3`. The one
   canonical order continues through `G4` Endpoint Recovery, `G5` Straight
   Test, `G6` Assignment, and `G7` Bend Refinement; `shared-set` is
   infrastructure rather than a scheduled gate.
4. Each `UnitTrace` records all operation-bound feature IDs and names the
   primary feature supplying its legacy enabled/knob fields. `baskets` now
   reports `sprite`; `tees` reports `endpoints`.
5. CLI and browser Sweep results expose the exact reason when truth scoring is
   skipped.

## Validation receipt

The 2026-08-27 frozen promotion ran the full default config on DashsTrack:

- Config hash: `bb53203cbf82cd9b68471251d6fadbb9d515a00e2b18241e0982c10a51d3e2d9`.
- Plan: 19 chronological operations; `assignment.selection → teeRecovery → zfit`.
- Results: 18 badges, 18 baskets, 15 visible tees, 3 recovered tees,
  18 total tees, 18 assignments, and 4,860 raw pairs.
- G4: 3 accepted recovery hypotheses, 0 rejected; H3 uses two visible shards,
  while H5 and the basket-occluded H12 each use one. Full-span single-component
  recoveries localize from their exact component PCA testimony; H12 lands
  0.095 px from frozen truth instead of the prior 5.96 px support-fit offset.
- Phantom completion: disabled and unscheduled.
- Receipt warnings: 0; operation conformance drift: 0.
- The run receipt emits one unified endpoint VisualRender with portable
  run-relative paths.
- Visible and recovered tees share one render standard: exact green
  border/shard evidence, four pad-axis-aligned cyan corner plus signs, and
  two one-pixel red diagonals whose intersection is the fitted center.

Machine and human receipts are written by the repro command below to
`artifacts/sweep/dev72-recovered-default/DashsTrack-full/run.receipt.{json,txt}`.

Run from the repository root after building `packages/alg`:

```bash
npm run build --workspace @chainspot/alg
npm run check
node_modules/.bin/vitest run \
  tests/unit/teeVisualReceipt.test.ts \
  tests/unit/labRunReceiptText.test.ts \
  tests/unit/labSweepReceipt.test.ts \
  tests/unit/threeFactorConfig.test.ts \
  tests/unit/teeFamilyFeature.test.ts \
  tests/unit/teeRecoveryFeature.test.ts \
  tests/unit/exec.compile.test.ts \
  tests/unit/exec.evidenceChains.test.ts \
  tests/unit/labHelp.test.ts \
  tests/unit/labHelpApi.test.ts \
  tests/unit/labColdHelp.test.ts
```

Observed on this handoff:

- Algorithm package build: PASS.
- App type check: 0 errors, 0 warnings.
- Focused execution/help/render/recovery tests: 95/95 PASS.
- Full corpus suite with sibling corpus detached at
  `origin/codex/lab-scope-validation@e98724d`: 318 pass, 7 fail,
  5 expected-fail, 3 skip, 1 todo.
- The seven failures are the known set: `dashsTrackSweep.test.ts` G3/G4 for
  H3/H5; `corpusSweep.test.ts` TowneLake G3/G4 for H13 and Lenard G3 for H3;
  plus both tests in `labScopeForensicAnnotation.test.ts` (hairline anchor
  pixel and pin exclusion), which reproduce on the untouched `cf40f85` base.
- Default G2 basket localization remains 18/18 on DashsTrack, Heritage,
  Lenard, and TowneLake.
- A real blind CLI run through G3 completes with 0 conformance drift:
  18 badges, 18 baskets, 32 raw tee rings, 17 post-exclusion tees, and
  15 accepted visible tee-family members, with H3/H5/H12 reserved for G4.

Default DashsTrack G3 artifact hashes after hardening:

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| bright mask             | `1b2d2b5053057c166307ec55680b4a50fbcc194bdde524f7c9393d9f333a461c` |
| dark mask               | `d78cee4f185286d1c561d7022d3db3ef3d1c11d289ec443bd3d3e30efa31ef04` |
| bright components       | `cc2f6f69eedf77f46b43077067219040f4568f9170ab6f090b3f6e3549a5dda5` |
| retained tee candidates | `c2569ee020c33ec4ccbe95be33292a1040567226983684513c421f12569832a2` |

## Known gaps that remain honest

- The frozen recovery baseline has one accepted 18-hole proof. Keep promoting
  approved flips directly into frozen until both a 54-hole (three-course) and
  72-hole (four-course) result exist, or the owner changes that policy.
- Complete-invisibility fallback remains intentionally absent from production:
  `phantomTee` stays OFF until an observed course needs it.
- Ownership is a downstream conclusion. A localized tee with
  `ownership: UNKNOWN` is not an ownership success or failure.
- SmartBasket's bbox-tolerance behavior and the recovered candidate's
  `whiteBbox` semantics need a focused follow-up before those fields are used
  as precise component geometry.
- The endpoints feature render is still attached from LAB's pending-render
  registry rather than owned beside the feature.
- Browser truth-status coverage combines an operation-level provenance test,
  API payload wiring, and static DOM wiring assertions; there is no browser
  DOM end-to-end test yet.
- Later-gate cutoff slicing needs an explicit dependency-complete design; do
  not widen the CLI parser beyond `G3` without adding those valid prefixes.

## Resume safely

```bash
git status --short --branch
git log --oneline origin/continuation/intake-engine..HEAD
npm run build --workspace @chainspot/alg
./lab help here
./lab sweep \
  packages/alg/src/detectors/threeFactor/configs/default.json \
  ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg
```

Build the algorithm package after every edit under `packages/alg/src`; LAB
loads `packages/alg/dist`, so testing without rebuilding can execute stale
code.
