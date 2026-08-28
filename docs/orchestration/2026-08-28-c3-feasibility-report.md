# C3 pair feasibility (badge interiority) — implementation report

Lane: continuation/intake-engine, one-hour build lane, 2026-08-28.
Contract: `docs/contracts/2026-08-28-render-stack-reading-contract.md` (SIGNED).
Scope: supersede the convicted `beyond-claim-bound` distance-kill rule in
`pruneImplausiblePairs` with contract clause C3 (pair feasibility by badge
interiority, pure structure, zero numeric constants). Files touched:
`packages/alg/src/detectors/threeFactor/assignment.ts`,
`packages/alg/src/exec/operations.ts`. `g3.teeRecovery.ts`,
`tests/unit/teeRecoveryFeature.test.ts`, the schema json, and all pin values
were left untouched per the fence.

## What changed

1. **Removed** the `beyond-claim-bound` exclusion (distance > median claim
   distance × `padClaimOutlierFactor`) from `pruneImplausiblePairs`. The
   knob (`padClaimOutlierFactor`) and `deriveGeometricClaims` were **not**
   deleted — `g3.teeRecovery.ts`'s frozen `deriveHuntTargets` still imports
   `deriveGeometricClaims` for its own hunt-widening bound, and
   `g3.teeRecovery.ts`'s `onPrune` callback (also frozen) reads
   `PlausibilityPrune.claimSet` / `.padClaimOutlierFactor` and
   `PlausibilityDropRecord.distancePx` directly. Those fields are kept on
   the return shape for back-compat (populated, no longer consulted for
   exclusion) so the frozen file compiles and runs unmodified.
2. **Added** rule `badge-not-interior`: a scored (badge, tee, basket)
   pairing is dropped unless the badge's center projects strictly interior
   on the tee→basket chord, `0 < projFraction < 1`, where
   `projFraction = dot(badge-tee, basket-tee) / |basket-tee|^2`. No margin
   or tolerance constant — bare `(0,1)` only, per the contract's explicit
   "later change" carve-out for an estimated margin.
   - Degenerate chord (tee/basket non-finite or coincident) is treated as
     **feasible** (a measurement defect, never exclusion evidence).
   - A recovered tee's own bound badge is exempt from this check
     entirely (same as the old rule's owner-exemption): the proof-based
     `recovered-tee-bound-elsewhere` rule still fires first and still wins
     over interiority for every *other* badge trying to claim that tee.
3. `PlausibilityDropRecord` keeps its structure per the brief, gains
   `basketId` and `projFraction`, and renames the rule from
   `beyond-claim-bound` to `badge-not-interior`. Drop records for this rule
   key on `(badgeId, teeId, basketId)` (interiority depends on the
   basket), while `recovered-tee-bound-elsewhere` still keys on
   `(badgeId, teeId)` only, unchanged.
4. Receipt text in `operations.ts` (both `assignment.ranking` and `zfit`
   choke points) now prints, per dropped pairing: `"badge N: pairing with
   tee-X->basket-Y removed before ranking (badge projects at F.FF on the
   tee->basket chord; the badge lies strictly between its tee and basket
   -- contract S3/C3)"` — matching the contract's own worked example
   verbatim in form. `g3.teeRecovery.ts`'s own `onPrune` receipt rendering
   is untouched (frozen); it renders the SAME `PlausibilityDropRecord` via
   its own ternary on `rule === 'recovered-tee-bound-elsewhere'`, which
   still compiles and still functions correctly against the new rule name
   (verified — that file was not printing anything C3-specific and does
   not need editing; its `distancePx`/`claimSet` fields are back-compat
   only for this callback and are otherwise inert now).

## Validation

- `npm run build -w packages/alg`: clean.
- `npm run check`: 0 errors, 615 files.
- New unit test `tests/unit/pairFeasibility.test.ts` (7 tests, all green):
  (a) interior badge (projFraction 0.5) kept; (b) projFraction −0.3
  excluded, named record with correct `projFraction`; (c) projFraction 1.2
  excluded; (d) degenerate/coincident chord kept; (d2) non-finite basket
  position kept; (e) `recovered-tee-bound-elsewhere` unchanged (a tee's own
  bound badge survives regardless of interiority; any other badge trying
  the same tee is still excluded by the binding rule, not interiority);
  plus an explicit assertion that no dropped record ever carries the dead
  `beyond-claim-bound` rule name.
- `npx vitest run tests/unit/corpusSweep.test.ts tests/unit/dashsTrackSweep.test.ts tests/unit/labSweepReceipt.test.ts tests/unit/pairFeasibility.test.ts`:
  33 passed, 6 expected-fail (`test.fails`, pre-existing), 1 todo, **2
  failed** — both on Lenard, both **pre-existing and unrelated to this
  change**: `[Lenard][G4] assignedExact=17/18 misses=[H3:no-assignment]`
  is the exact regression already logged as OPEN in
  `docs/CLAIMS-LEDGER.md` row 29 ("NorthPark H5 orphaned... Lenard 17/18
  vs ground truth (H3:no-assignment, a REGRESSION, diagnosis
  interrupted)"), predating this lane; the G1 test failure is a 60s test
  timeout on a slow run, not an assertion failure, and G1 (badge digit
  reading) has no code path through `assignment.ts` at all.

## Corpus receipts

Before-state preserved (NOT overwritten) at
`artifacts/orchestration/c3-before/{DashsTrack-full,NorthPark-full,HeritagePark-full}`
(copied from `artifacts/sweep/dev72-recovered-default/<course>` before any
sweep in this lane ran). After-state is the freshly rewritten
`artifacts/sweep/dev72-recovered-default/<course>` from this lane's three
sequential `./lab sweep` runs (DashsTrack used the corpus's actual
`DashsTrack-full.jpg` — no `.png` exists for that course).

Pairs excluded by interiority per course (total `prunedPairings` measure,
`badge-not-interior` + the much smaller `recovered-tee-bound-elsewhere`
combined; the printed receipt caps the named lines at 24 each and reports
the rest via `prunedBeyondReceiptCap`):

| Course | prunedPairings before (old distance rule) | prunedPairings after (C3 interiority) |
|---|---|---|
| DashsTrack | 0 (never fired) | 2433 |
| NorthPark | 202 | 2676 |
| HeritagePark | 215 | 2456 |

C3 fires roughly 10x more often than the old distance rule, as expected —
it evaluates every (badge, tee, basket) triple's structural chord, not
just (badge, tee) proximity, and geometric backwardness is common across
all pairs, not rare.

### DashsTrack — the acceptance case

**HOLE ASSIGNMENTS: byte-identical before and after, 18/18.** No hole
changed assignment. No new empty hole.

H1/H2 (the contract's named acceptance pair):

```
H1 | badge-0 | tee-0 -> basket-2 | 0.373 | 1 | 0.993   (unchanged)
H2 | badge-1 | tee-1 -> basket-0 | 0.146 | 4 | 0.993   (unchanged)
```

H2's pre-recovery `assignment.selection.table.bin` alternatives (the G6
table, before the teeRecovery reassignment pass) are **also unchanged**
before vs. after:

```
alternatives: tee-1->basket-2 (0.206), tee-1->basket-1 (0.186), tee-1->basket-0 (0.146)
```

`tee-1->basket-2` (H1's basket) is **still present** in H2's ranked
alternatives after C3. This was investigated directly (scratch probe,
removed after use): badge-1's (H2's badge) center genuinely projects at
`projFraction ≈ 0.40` on the `tee-1→basket-2` chord — **strictly
interior**. C3 cannot and must not exclude this pairing: badge-2 really
does sit geometrically between tee-1 and its neighbor's basket (adjacent
parallel fairways on this course render that way), so bare `(0,1)`
interiority is satisfied and the contract's own "later change: per-image
estimated margin" note is exactly what would be needed to narrow this
further — explicitly out of scope for this lane. The reason DashsTrack's
final H2 answer is still correct (`tee-1->basket-0`, not the higher-scoring
`tee-1->basket-2`) is the solver's one-to-one exclusivity: `basket-2` is
already claimed by H1, so H2 cannot have it regardless of score. C3 did
its job (pure structural feasibility); the cross-hole basket-stealing
ambiguity the contract motivation describes is a C4 (trace-association)
concern, not a C3 one, and C4 is explicitly Lane B territory this lane
does not touch.

### NorthPark

Coverage unchanged: **17/18 both before and after, H5 still the sole
missing hole** (pre-existing per ledger row 29, untouched by this change).

Two holes' *pairings* changed without changing which holes are covered:

```
H18 | badge-12 | tee-recovered-0 -> basket-13 | score 0.384 | rank 1   (before)
H18 | badge-12 | tee-9          -> basket-12  | score 0.000189 (printed "0") | rank 48   (after)

H14 | badge-7  | tee-9          -> basket-5   | score 0.114 | rank 2   (before)
H14 | badge-7  | tee-recovered-0 -> basket-5  | score 0.120 | rank 3   (after)
```

**Finding, reported not fixed:** H18's final pairing degraded sharply in
quality (score 0.384 → 0.000189) even though the hole stays "assigned."
Investigated directly: the raw pair `badge-12/tee-9/basket-12` is real and
reachable (`failureReason: null`), just geometrically very poor
(`teeOrientation` factor 0.023, `badgeFraction` factor 0.049) — far from
badge-12's better-scoring kept candidates (best kept was
`tee-12->basket-17` at 0.103). The fill-first solver picked the
near-zero-score option at rank 48 because `tee-9` and `basket-12`'s
higher-scoring badge-12 candidates were claimed elsewhere in this run's
global 2-opt settle, and `tee-recovered-2` (the recovery predicate now
bound to some *other* badge this run — receipt line 224 shows badge-18
tried it and was correctly refused via `recovered-tee-bound-elsewhere`) is
no longer badge-18's own recovery. This is a genuine second-order
consequence of C3 changing the candidate pool that upstream (frozen)
`g3.teeRecovery.ts` widens its hunt from — not a bug in the C3 predicate
itself (unit-tested correct in isolation), but a real quality regression
worth the owner's attention: **H18 went from a solid, well-scored pairing
to a near-zero-evidence one while the coverage count stayed flat.** Not
fixed in this lane per the fence on `g3.teeRecovery.ts` and per
"failure you cannot explain goes in the report, not the code."

### HeritagePark

**Coverage count unchanged (16/18 both before and after) but WHICH holes
are covered changed — a real finding.**

```
Before: missing H5, H10 (16 assigned: H1,H2,H3,H4,H6,H7,H8,H9,H11,H12,H13,H14,H15,H16,H17,H18)
After:  missing H4, H13 (16 assigned: H1,H2,H3,H5,H6,H7,H8,H9,H10,H11,H12,H14,H15,H16,H17,H18)
```

H4 (`badge-8`, score 0.366, rank 1) and H13 (`badge-9`, score 0.401, rank
1) — both previously well-scored, rank-1 pairings — **disappeared
entirely** from the assignment. In their place, H5 (`badge-5`, score
0.021, rank 12) and H10 (`badge-4`, score 0.001, rank 9) appeared — both
very poor. `tee-12`, H4's former tee, now belongs to H10's badge instead;
receipt lines confirm C3 directly excluded two of badge-4's/H4's own
`tee-12` candidate baskets (`basket-16` at −0.04, `basket-9` at −0.01 —
both genuinely not interior), which is correct C3 behavior in isolation,
but the knock-on effect through the global 2-opt exchange search left the
two previously-solid holes (H4, H13) empty and filled two different,
much-worse-scored holes instead.

Also unchanged: H6 (`badge-2`, recovered tee) kept its recovered tee but
its basket target and score shifted (`basket-3`@0.028 → `basket-11`@0.073)
— a smaller, same-direction effect of the same candidate-pool change.

**Per the instructions: this is reported loudly, not patched.** No
knob, pin, or test expectation was touched to paper over it. It is the
same class of finding as NorthPark's H18 above: C3 is structurally correct
per its own unit tests and per direct geometric verification, but the
*global solver* built on top of the new candidate pool settles into a
different (and, on these two courses, sometimes worse) local optimum than
it did with the old distance-kill rule in place. The old rule, despite
being convicted for deleting real long/short-hole pairings elsewhere, was
also — apparently incidentally — suppressing some of the noisy, small-
positive-score candidates that the fill-first/2-opt solver will now
happily grab when a better option gets claimed by another badge. This
looks like a genuine coverage-quality tradeoff the owner should see before
deciding whether the next lane (C4 trace association, or a coverage-aware
solver objective) is required before this ships past dev-corpus receipts.

## Fences respected

- `g3.teeRecovery.ts`, `tests/unit/teeRecoveryFeature.test.ts`, the schema
  json: **not edited.**
- No knob defaults changed. `padClaimOutlierFactor` still resolves exactly
  as before (still consumed by `g3.teeRecovery.ts`'s own hunt-bound logic);
  it is simply no longer consulted by `pruneImplausiblePairs`'s exclusion
  decision.
- No pin values touched (`tests/unit/exec.compile.test.ts`'s frozen plan
  fingerprint, `tests/unit/threeFactorConfig.test.ts`'s resolved-config
  hash) — both were already mid-edit from a prior uncommitted lane
  (`maxBareSupportFraction`/note-append pins) at lane start; this lane
  made zero additional changes to either file.
- No commits, pushes, or resets performed.
- No test expectations altered to force a pass; the two Lenard
  `corpusSweep.test.ts` failures and the two coverage/quality findings
  above (NorthPark H18, HeritagePark H4/H13/H5/H10) are reported as-is.
