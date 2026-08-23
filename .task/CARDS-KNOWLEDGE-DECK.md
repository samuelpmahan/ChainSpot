# LAB deck update — engine-era knowledge cards

Branch: `cards/knowledge-deck-engine-era`. Base: `0850f75`.
Scope: files under `scripts/chainspot-lab/` ONLY. No engine code, no test
pins, no configs. The deck's import-time self-check must stay green.

Process requirement: this task follows mise-en-place — lay out the plan in
plain chat and WAIT for an explicit go before editing any file. All numbers
below must be re-verified against their stated sources before being written
into a card; a number you cannot re-derive does not go on a card.

## Design rules (owner-approved, 2026-08-23)

1. **Relationships are data, not prose.** Every cross-reference is a typed,
   labeled field the registry self-check validates (existing pattern:
   invariant cards name gates/detectors). New relationship labels needed:
   `constrains`, `is-enforced-by`, `supersedes`, `is-implemented-by`,
   `validates-on`. These become knowledge-graph edges later; build no graph
   tooling now.
2. **Re-run button.** Every evidence entry carries the exact zero-fill
   command that re-derives it (test invocation + config name + expected
   resolved-config hash).
3. **Append-only history.** Evidence cards hold dated entries
   (date, commit, paramsHash, numbers). New measurements append; old entries
   never change. Superseded claims stay, marked retired.
4. **Scope claims to what was measured.** Per-course entries, never blended
   ("on DashsTrack", not "the engine works").
5. **Plain-language note on every card** — a reader two months from now
   gets the concept without jargon.

## Card 1 — NEW invariant card: routing bucket-queue capacity

Claim: in `src/lib/detectors/threeFactor/routing.ts`, the bucketed
priority queue is correct only while
`ring * quantum > (1 + costMultiplier) * sqrt(2)`.
At defaults: `64 * 0.125 = 8 > 5 * 1.41421... ≈ 7.071`. Violation wraps a
relaxation into an already-drained bucket and corrupts distances silently.
Enforced by `validateRoutingRingQuantum` in
`src/lib/detectors/threeFactor/config.ts` (fails at config-resolve time).
Relations: `constrains` the G5 routing detector card;
`is-enforced-by` config.ts validateRoutingRingQuantum.
Source to re-verify against: the code itself + the two tests added in the
g5.routing cluster commit (35db5a4).

## Card 2 — NEW evidence card: threeFactor engine vs dev72 ground truth

First-ever scoring of the clean-room threeFactor engine against corpus
annotations. Commit `aeabb38`, default config, resolved hash
`7c75595338b0a45502ce615a9ea827d4e9140b6eca7a950061f03a6b7625a52e`
(hash is from the post-merge 14-feature universe; re-verify at write time),
26px association tolerance (convention inherited from
old-stuff/scripts/toph-corpus-gate.ts, ASSOCIATION_TOLERANCE_PX).

Per-course entries (re-verify each against
`npx vitest run tests/unit/corpusSweep.test.ts tests/unit/dashsTrackSweep.test.ts`):
- DashsTrack: G1 18/18 digits 18/18 · G2 matched 18/18 (found 23, extras 5, maxDev 5.02px) · G3 matched 18/18 (found 19, maxDev 6.09px) · G4 exact 18/18
- TowneLake: G1 18/18 · G2 18/18 (maxDev 3.26px) · G3 18/18 (maxDev 2.38px) · G4 exact 18/18
- Lenard: G1 16/18 (H5, H12 missing; one misread as spurious 4-digit) · G2 18/18 · G3 18/18 · G4 exact 16/18 (H5, H12)
- Heritage: G1 16/18 (H2, H15) · G2 18/18 · G3 14/18 (H5/H6/H10/H15, 70-224px off) · G4 exact 9/18
- AlexClark: excluded — annotation truths only 3 holes, no sourceImage/sha256; every predecessor harness excluded it.

History entries: (a) retired entry — old pipeline (pancake-harness /
toph-corpus-gate, old-stuff) DashsTrack 18/18 within 26px, maxDev 4.17px,
per CHANGELOG-dev.md; marked superseded-by entry (b). (b) the above.
Relations: `validates-on` each course case card where one exists;
`supersedes` the old-pipeline claim.
Coordinate-frame caveat to record: Heritage/Lenard/TowneLake corpus images
are pre-autocrop; truth is post-autocrop; the harness reproduces the crop
(tests/unit/helpers/intakeAutocrop.ts) — without it, misses of ~700px would
be reported spuriously.

## Card 3 — NEW evidence card OR entry: family deviations first A/B

Commit `0850f75`, config `family-on` (teeFamily + cleanBasketFamily),
observational run vs default, same tolerance. Headline (re-verify against
`npx vitest run tests/unit/familyDeviationSweep.test.ts`):
- cleanBasketFamily removed ALL extra baskets on all 4 courses but dropped
  real matched baskets on 3 of 4 (Dash 18→17, Heritage 18→15, Lenard
  18→16), dragging G4 down accordingly; TowneLake was clean (extras 2→0,
  no loss, G4 held 18/18).
- teeFamily reduced extra tees but changed no truth-tee matches anywhere;
  Heritage's 4 wild tees are DETECTION misses, not selection misses —
  unfixable by any selection-stage family filter.
- Lenard's missing plates unchanged (predicted no-effect, confirmed).
Honest framing: a negative/mixed result — current family knob defaults are
too strict for corpus conditions. Evidence images regenerable via the same
test (artifacts/ dir, gitignored).
Relations: `is-implemented-by` g3.teeFamily / g2.cleanBasketFamily feature
files and configs.

## Card edits — port stamps (3 small edits)

The cards that motivated these ports gain an `is-implemented-by` relation
(feature file + config name):
- intact tee-family card (C01-adjacent lineage) → features/g3.teeFamily.ts, configs/tee-family-on.json
- basket family signal card (basketFamily.ts) → features/g2.cleanBasketFamily.ts, configs/clean-basket-family-on.json
- straight-test / four-lane lineage card(s) → features/st.fourLaneSensor.ts, configs/tbs-four-lane-sensor-on.json
Locate the actual card ids by reading the deck; do not guess ids. If no
suitable card exists for a port, note that instead of inventing one.

## Acceptance

- Deck self-check passes on import (run any test that imports the registry,
  or the deck's own validation path).
- `npx vitest run` full suite unchanged-green; `npm run check` 0/0.
- Every number on every card re-derived from its stated source during the
  work, not copied from this spec (this spec may contain transcription
  errors — the sources are authoritative).
- One commit per card is fine; or one commit total. No pushes without the
  coordinator's gate.
