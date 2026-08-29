# Tee-Badge Ray Lock — resolver completion report

Branch: `continuation/intake-engine`. Ported probe: `684727e` (feature/tee-badge-ray-lock, forked from kerchooo-v9) → `.github/workflows/tee-badge-ray-probe.yml`.

## 0. Probe port

`684727e` carried exactly one file, the probe workflow. Cherry-picked cleanly
(no conflicts — the branch never touched detector source). Adapted:
push-on-`feature/tee-badge-ray-lock` trigger and the hardcoded checkout
`ref` removed; now `workflow_dispatch`-only against whatever ref triggers
it, since that branch is retiring in favor of `continuation/intake-engine`.
Commit: `4ac8f81`.

## 1. Probe evidence (before any resolver code changed)

Full detail: `artifacts/orchestration/ray-lock/probe/EVIDENCE-SUMMARY.md`.
Payload mirrored the workflow's own commands (`./lab sweep batch --through
G4 tee-badge-lock-on.json <course>`), run locally.

| course | badges | candidates | locks | unmatched | unused tees |
|---|---|---|---|---|---|
| NorthPark | 18 | 324 | 18 | 0 | 0 |
| DashsTrack | 18 | 324 | 18 | 0 | 0 |
| HeritagePark | 18 | 306 | 17 | 1 (`badge-2`) | 0 |

**What the machinery already got right**: full 18/18 coverage on two of
three courses, deterministic max-weight matching, zero Euclidean-distance
evidence anywhere in scoring (C4).

**The gap that made stage 2 necessary**: HeritagePark's one unmatched
badge (real hole **H6** — the `badge-2` ordinal is NOT the hole number;
resolved via `BadgeEvidence.label` per chainspot-engrams) printed only an
aggregate `unmatchedBadges=1` count before this change. No hole number, no
reason, no named conflict — pure silence on the one hole that actually
needed a human sentence. That silence is exactly what stage 2 closes.

## 2. Interpreting "two-ray → multiclaim → all-Hn" (owner's phrase, ambiguous beyond the math module's own vocabulary — my interpretation, for review)

Per the owner's instruction, these terms are read from `g4.teeBadgeLockMath.ts`'s
own vocabulary, not invented:

- **Two-ray** = `scoreTeeBadgeCandidates`'s evidence channels, which were
  already built and unchanged by this work: (a) the routed-path channel
  (`weakAlignedSupport` × `pathEfficiency`, following the support field
  through the reversed `teeLeg` path) and (b) the tee-axis channel
  (`axisFactor`, comparing the tee's own axis ray against the tee→badge
  chord ray — S2's "tee aims at badge"). Two independent rays feeding one
  score; nothing in stage 2 touched this math.
- **Multiclaim** = `maximumWeightTeeBadgeMatching`, the deterministic
  Hungarian one-to-one match already in place (no score threshold, no
  Euclidean distance, tie-break stable under permutation). Also unchanged.
- **All-Hn** = the piece that was NOT finished: every G1-read hole must end
  up with a lock, an explicit abstention, or a named conflict — never
  silence. This is what stage 2 built.

**My interpretation, flagged for the owner's review**: I split "abstention"
into two named dispositions rather than one generic bucket, because the
evidence demanded it (HeritagePark's H6 is not "no evidence" — it lost a
real contest):
  - `orphan` — the badge had zero candidate rays at all.
  - `conflict` — the badge had candidates, but its best-scoring tee was
    awarded to a different badge's stronger claim (named, with both
    scores and the winning hole).

If the owner intended "abstention" and "conflict" as the two named things
literally listed in the brief (rather than "abstention" subsuming both, as
I read it), the code already carries the distinction as `kind: 'orphan' |
'conflict'` — renaming or re-exposing it is a small change, not a rewrite.

## 3. What changed

- `packages/alg/src/detectors/threeFactor/features/g4.teeBadgeLockMath.ts`:
  new `TeeBadgeLockAbstention`/`TeeBadgeLockAbstentionKind` types and
  `buildAbstentions`, wired into `buildTeeBadgeLockEvidence`. Every
  unmatched badge id gets exactly one abstention row, resolved to its hole
  number via the same `exactPositiveHole(label)` helper locks already use.
- `packages/alg/src/detectors/threeFactor/features/types.ts`: added the
  `'tee-badge-abstention'` `visualRole` (shared enum — the one file touched
  outside the strict teeBadgeLock trio, and only additive).
- `packages/alg/src/detectors/threeFactor/features/g4.teeBadgeLock.ts`:
  `emitDrawables` now also emits one point drawable per abstention
  (`verdict: 'rejected'`, `reason:` the human sentence), guarded the same
  `state.enabled` way the existing lock drawables are.
- `packages/alg/src/detectors/threeFactor/features/g4.teeBadgeLockReceipt.ts`:
  reads those drawables back into `TeeBadgeLockAbstentionRow`s and appends
  a `TEE→BADGE ABSTENTIONS` section to the CLI receipt.
- No knob, threshold, default, or config change. `teeBadgeLockFeature`
  stays `kind: 'deviation'`, `defaultEnabled: false`. No new constants —
  every abstention field is provenance carried from scores already computed
  per-image (N1-N3 untouched).

## 4. Tests

- All 4 pre-existing `teeBadgeLock*.test.ts` files pass unchanged (15
  tests) — no existing expectation was touched.
- Added to `tests/unit/teeBadgeLockMath.test.ts` (7 new tests in a new
  `describe` block):
  - two badges contesting one tee → winner locks, loser named `conflict`
    with the exact winning hole/score, third badge with zero testimony
    named `orphan`.
  - one tee contested by three badges → both losers named `conflict`
    against the single winner.
  - degenerate calibration (all-zero support field) → scores collapse to
    `0`, never `NaN`/`Infinity`; `locks.length + abstentions.length`
    accounts for every badge (N3 graceful degradation, no threshold
    invented to paper over it).
- Full `npx vitest run tests/unit`: **464 passed, 1 failed, 5 expected-fail,
  3 skipped, 1 todo** (474 total). The one failure —
  `tests/unit/corpusSweep.test.ts > Heritage gate sweep > G1 — badge count +
  digit reads (measured: digits 16/18, missing H2,H15)` — is a
  pre-existing `test.fails` wrapper for a *known* G1 OCR defect on the
  "Heritage" truth fixture; this run's G1 read all 18/18 digits correctly
  (an unrelated improvement elsewhere flipped it from failing to passing,
  which makes the `test.fails` wrapper itself report a failure). It is
  outside every file this work touched (G1 badge OCR, not teeBadgeLock) and
  is flagged here rather than "fixed" — DT12 lanes are concurrently active
  on this branch and I did not investigate further per the scope fence.

## 5. Lock-on sweeps vs probe baseline

| course | probe locks/abstentions | post-change locks/abstentions | match |
|---|---|---|---|
| NorthPark | 18 / 0 | 18 / 0 | identical |
| DashsTrack | 18 / 0 | 18 / 0 | identical |
| HeritagePark | 17 / (silent) | 17 / **1 named** | same matching, now named |

HeritagePark's `run.visual.receipt.txt` now prints, verbatim:

```
TEE→BADGE ABSTENTIONS (all-Hn: every unmatched badge named, never silent)
hole | badgeId | kind | bestScore | winningHole | winningScore | verdict | reason
H6 | badge-2 | conflict | 0.247801 | H4 | 0.402969 | rejected | H6: best candidate tee tee-12 (score 0.2478) was awarded to H4 (score 0.4030) by the max-weight match -- conflict, abstaining.
```

alongside the unchanged 17-row `HOLE ASSIGNMENTS` / `TEE→BADGE LOCK`
tables. The matching itself (which badge gets which tee) is byte-for-byte
the same as the probe baseline on all three courses — only the receipt's
completeness changed.

Lock-on config runtime (own path, reported separately from the default
path per the perf fence): sweep-batch `ms` sums were NorthPark 21254ms,
DashsTrack 19400ms, HeritagePark 28295ms (vs. the probe's own baseline of
21478/—/— on the same machine — within normal run-to-run noise; the
teeBadgeLock/abstention work adds O(unmatched badges) string formatting
only, no new per-candidate cost).

## 6. Default-path parity

Ran `./lab sweep default.json <course>` for NorthPark, DashsTrack,
HeritagePark and diffed `run.receipt.json`/`run.receipt.txt` against
`artifacts/orchestration/kerchooo-port/after/`. `teeBadgeLock` is not in
`default.json`'s execution list and `defaultEnabled: false`, so it is fully
uninstantiated on this path — confirmed structurally: after stripping
`generatedAt`/`revision`/every `*Ms`/`ms`/`durationMs`/`percentOfOperationBody`
field (all volatile timing measurements, not plan identity), **every
remaining field is byte-identical** on all three courses — same op
ordering, same counts (`badges.length=18`, `tees.length=…`,
`rawPairs.length=…`, etc.), same statuses, same config/paramsHash. The
default plan fingerprint did not move; KERCHOOOOO's perf gains are
preserved by construction (this feature's files are never reached when
`teeBadgeLock` is absent from `execution`/`gates`).

## 7. Open questions for the owner

1. Section 2's `orphan`/`conflict` split — confirm this matches intended
   "abstention, or a named conflict" semantics, or say if they should
   collapse to one generic "abstention" disposition.
2. The probe workflow is now `workflow_dispatch`-only with no ref pinned
   (runs against whatever ref triggers it). Say if a specific always-probe
   ref (e.g. `continuation/intake-engine`) should be hardcoded instead.
3. `tests/unit/corpusSweep.test.ts`'s Heritage G1 `test.fails` (section 4)
   looks like a genuine, unrelated fixture-drift bug (an improvement made
   an expected-broken test pass) — worth a follow-up ticket; left
   untouched here per the DT12/other-lanes scope fence.

## Fences respected

No edits outside `g4.teeBadgeLock{,Math,Receipt}.ts`, the shared
`types.ts` `visualRole` enum (additive only), the probe workflow, this
report, and the one test file. No knob defaults changed on this or any
other feature. No pin moved (`default.json`'s plan fingerprint is
unchanged, confirmed in §6). `artifacts/orchestration/dt12-*` and their
topics were not touched. Nothing pushed; no PR opened — three logical
commits left on `continuation/intake-engine` for the lead to review, push,
and PR:

```
f9ed1da Add multiclaim and degenerate-calibration tests for the all-Hn resolver
721659b teeBadgeLock: emit and print abstention/conflict receipts
78c8598 teeBadgeLock: complete the all-Hn resolver with named abstentions
4ac8f81 Port tee-badge ray probe workflow onto continuation/intake-engine
```
