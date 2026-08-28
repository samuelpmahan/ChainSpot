# 2026-08-28 — Build-state untangle (Sonnet A, mechanical repair)

Scope: verify `npm run build -w packages/alg` and `npm run check`, run the
named unit suites, record pass/fail. No fixes beyond compile breakage; no
knob/threshold/expectation edits.

## 1. Compile/typecheck status

**No breakage found.** Both commands pass clean against the current
uncommitted working tree (on top of `10df47f`):

- `npm run build -w packages/alg` → exit 0. `tsc -p tsconfig.json` produced
  zero diagnostics; `copy-assets.mjs` copied all detector configs normally.
- `npm run check` (`svelte-kit sync && svelte-check`) → exit 0,
  `COMPLETED 613 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.

I specifically inspected `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts`
(the file named as the likely site of a syntax/garbled-string error) for
unterminated template literals or mangled knob-note strings: grepped every
backtick-delimited string in the file and read the full diff against
`10df47f`. All template literals are properly terminated (including the
long knob `note:` strings with embedded escaped `\'` and nested backticks in
comments). No syntax defect exists in the current tree — either it was
already repaired before this session started, or the described symptom was
not actually present in this snapshot. I made **zero edits** to any file:
the working tree is byte-for-byte what I found it to be.

Files touched by the uncommitted pile (`git diff --stat` against 10df47f):
- `packages/alg/src/detectors/threeFactor/configs/threeFactor-config.schema.json`
- `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts` (+98/−11: adds `maxBareSupportFraction` knob, `SupportFootprintAudit`, `auditSupportFootprint`, contrapositive bare-fraction gate, `ScreenChromeRegion` import)
- `tests/unit/exec.compile.test.ts`
- `tests/unit/teeRecoveryFeature.test.ts` (+53 new test lines)
- `tests/unit/threeFactorConfig.test.ts`

## 2. Unit suite pass/fail matrix

Ran `npx vitest run` against the nine named files in one invocation.

| Suite | Result |
|---|---|
| tests/unit/g4HuntTargets.test.ts | PASS |
| tests/unit/teeRecoveryFeature.test.ts | PASS |
| tests/unit/phantomTeeFeature.test.ts | PASS |
| tests/unit/exec.compile.test.ts | PASS |
| tests/unit/threeFactorConfig.test.ts | PASS |
| tests/unit/threeFactorSchema.test.ts | PASS |
| tests/unit/labSweepReceipt.test.ts | PASS |
| tests/unit/labRunReceiptText.test.ts | PASS |
| tests/unit/teeVisualReceipt.test.ts | PASS |

Vitest summary: `Test Files 9 passed (9)`, `Tests 83 passed (83)`, 0 failed,
0 skipped. No assertion text to record — there were no failures.

## 3. Root-cause investigation (per owner's widened brief)

The owner asked, for every failing assertion, which uncommitted-lane change
causes it and whether code or test is wrong, with receipt/trace evidence.

**There are no failing assertions to investigate.** All 83 tests across all
9 named suites pass against the current uncommitted tree, including
`tests/unit/teeRecoveryFeature.test.ts`, which itself carries the new
53-line addition exercising the contrapositive bare-support gate
(`maxBareSupportFraction` / `auditSupportFootprint` / `footprintAudit`)
added in `g3.teeRecovery.ts`. That test file's new assertions pass against
the new gate code as committed in the working tree — i.e. the lane
("contrapositive gate") that the owner flagged as a candidate root cause is
not merely compiling, it is covered by a passing test that exercises its
own knob (`maxBareSupportFraction` default 0.7) and its own audit shape
(`SupportFootprintAudit { total, white, occluded, bare }`).

I did not find any of the other named lanes (geometric hunt derivation,
recovered-tee binding, plausibility prune, hunt-union+redundant-discard,
receipt plumbing) implicated by a failure either, because none of the nine
suites reported one.

Two possible explanations for the mismatch between the task brief
(anticipating breakage and failing assertions) and what I observed, offered
as findings rather than fixes:

1. **The pile may have already been partially repaired** by another agent's
   pass before this session's turn began — the diff I audited already
   contains a complete, internally-consistent contrapositive-gate feature
   (interface, knob, validator, audit function, and its own test), which
   reads like finished work rather than an interrupted edit.
2. **The specific breakage may be located outside the 9 named suites and
   outside `packages/alg`/`svelte-check`'s reach** — e.g. only surfaced by
   `./lab` sweep execution against `dist/`, which I did not run per the hard
   rule against sweeps, or by a suite not in the requested list.

No knob defaults, thresholds, test expectations, pin hashes, or fixture
values were changed. No commits, pushes, resets, checkouts, or stashes were
performed. No `./lab` sweep was run.
