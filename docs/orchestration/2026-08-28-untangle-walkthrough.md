# Untangle walkthrough — 2026-08-28 frozen pile

Audit of the work sitting on `continuation/intake-engine`. Written for the
owner to approve or reject **piece by piece**. Nothing here was changed by
this audit: no knob default, no threshold, no test expectation was touched.

---

## 0. Read this first: the pile is not where the brief says it is

The brief describes one large uncommitted pile containing eight tangled
things. That is not what is on disk. The split is:

| | Where it actually lives | Reversible how |
|---|---|---|
| 1. Geometric hunt derivation (`deriveHuntTargets` / `deriveGeometricClaims`) | **committed AND pushed** in `10df47f` | needs a revert commit |
| 2. Recovered-tee → badge binding (`RecoveryProvenance.badgeId`) | **committed AND pushed** in `10df47f` | needs a revert commit |
| 3. Plausibility prune (`pruneImplausiblePairs`, `padClaimOutlierFactor`) | **committed AND pushed** in `10df47f` | needs a revert commit |
| 4. Solver-widened hunt union + redundant-recovery discard | **committed AND pushed** in `10df47f` | needs a revert commit |
| 5. Contrapositive bare-support gate (`auditSupportFootprint`, `maxBareSupportFraction`) | **uncommitted working tree** | discardable |
| 6. Receipt plumbing (named drops, hunt declarations, dup-suppression) | **split**: prune/hunt/dup lines in `10df47f`; the footprint-audit line is uncommitted | split |
| 7. Test edits + schema regen | **split**: fixture move + first-rejected filters + `g4HuntTargets.test.ts` in `10df47f`; the contrapositive describe, the `setActiveBareSupportFraction(1)` disable, and both pin bumps are uncommitted | split |
| 8. Syntax error | **already gone** — `tsc --noEmit -p packages/alg/tsconfig.json` is clean, schema JSON parses | fixed by the Sonnet teammate |

`origin/continuation/intake-engine` is at `10df47f`. So **items 1–4 cannot be
un-done by discarding the working tree.** Anything you reject there is a
forward revert on a pushed branch. Please decide 1–4 with that in mind — the
cost of "hold" is different from the cost on item 5.

The uncommitted diff is small and self-contained: 5 files, +153/−11, and it is
**entirely item 5 plus its plumbing, tests and pins**.

Only one course has a post-gate receipt on disk:
`artifacts/test/lab-sweep-through-g4/` (DashsTrack, `revision:
10df47f...+dirty`, `config.paramsHash f1609dbd...` — i.e. generated *with* the
bare gate active). Everything in `artifacts/sweep/dev72-recovered-default/`
predates the gate. That single receipt is the whole evidentiary base for
section 5 below, and it is thinner than the knob note claims.

---

## 1. Geometric hunt derivation — `deriveHuntTargets` (committed, `10df47f`)

**What.** The set of badges G4 recovery hunts for is now computed from
geometry: greedy nearest badge↔tee claims over the visible tees, with a
course-derived bound (median claimed distance × `padClaimOutlierFactor`,
default 3). A badge with no surviving claim is hunted. The G6 solver may only
*widen* the set, never shrink it.

**Why.** Ledger row 27: Heritage H5's tee was never hunted, because the hunted
set was read off the *pre-recovery G6 assignment*, and at that moment badge 5
was not "missing" — it held a mis-paired tee 317px away at score 0.189 rank 1.
A mis-pairing masked a missing tee from the machinery built to recover it.
Owner directive on the same day: "step-4 input must never come from step 6."

**Evidence for.** Row 27 is **UPHELD** with a full pixel receipt (component
#1096, 50px at (729,1154), 77px down-ray of badge-5, beside basket glyph
#1051). Row 29 records the outcome: DashsTrack `--through G4` went to 18/18
*truthful* (the prior 18 contained a fake H5 row paired at 400–700px, score
0.06), Heritage H4/H18 now hold their correct pads. The prune lines print
verbatim in `artifacts/test/lab-sweep-through-g4/run.receipt.txt` lines
114–137, each naming the badge, the tee, the distance, the bound and its
derivation.

**Evidence missing.** Row 29 is filed **PARTIAL**, not upheld: NorthPark H5 and
Lenard H3 are open regressions this lane introduced. The bound `median × 3`
has no ground-truth study behind the factor 3 — it is scale-free and
course-derived (footgun-law compliant), but 3 is a guess with a knob around it.

**Recommendation: KEEP.** This is the fix to a diagnosed, upheld root cause,
it obeys the owner's directive directly, and the derivation is
course-relative rather than a literal. The regressions belong to rungs A/B,
not to this mechanism.

---

## 2. Recovered-tee → badge binding — `RecoveryProvenance.badgeId` (committed, `10df47f`)

**What.** A tee recovered because it satisfied badge N's predicate is stamped
with badge N, and assignment refuses to pair it with any other badge.

**Why.** Without it the global re-solve could hand a recovered pad to a
different badge than the one whose ray justified its existence — the recovery
evidence and the assignment would then be claims about different holes.

**Evidence for.** Structurally sound and cheap to reason about: the acceptance
predicate *is* badge-relative (badge-ray-constrained hollow-support fit), so
the provenance is not an added assumption, it is the recorded reason. Row 29
lists it as one of four structural fixes and marks the structural fixes
UPHELD.

**Evidence missing.** No receipt isolates this constraint's effect. Nothing on
disk shows a run where the binding changed an outcome — its contribution is
tangled with items 1, 3 and 4 in the same commit and the same scoreboard.

**Recommendation: KEEP.** It is the honest bookkeeping of a claim the
predicate already made. But note for the ledger that its independent effect is
**unmeasured**, so do not credit it with any part of the DashsTrack/Heritage
improvement.

---

## 3. Plausibility prune — `pruneImplausiblePairs` (committed, `10df47f`)

**What.** Before selection, in both exec paths, any (badge, tee) pairing whose
distance exceeds the course-derived claim bound is dropped, with one named
receipt line per drop.

**Why.** Row 27's tee-12/badge-5 pairing at 317px scored 0.189 **rank 1**; the
same final table carried a 745px pairing at score 0 rank 88. The scoring
function will happily rank a physically impossible pairing first.

**Evidence for.** The strongest receipt in the pile. Twenty-four prune lines in
`run.receipt.txt` (114–137), each fully self-describing, e.g. *"badge 5:
pairing with tee-12 removed before selection (tee-badge distance 706.9px
exceeds the course-derived claim bound 375.3px = median 125.1px × 3 (knob
padClaimOutlierFactor); best dropped score 0.0820 over 18 pairs)"*. Row 29
credits this prune with killing DashsTrack's fake H5 row and correcting
Heritage H4/H18.

**Evidence missing.** The bound is recomputed at different points in the run
and drifts (375.3px in one block, 378.7px in another — receipt lines 114 vs
197). Harmless numerically, but two different "the" course bounds print in one
receipt, which will confuse a reader. Worth a follow-up, not a blocker.

**Recommendation: KEEP.** Course-derived, receipt-named, never silent. This is
what the footgun law asks for.

---

## 4. Solver-widened hunt union + redundant-recovery discard (committed, `10df47f`)

**What.** Badges with no surviving pre-recovery row are added to the geometric
hunt set (union, never intersection). Recoveries that duplicate an already-good
tee are discarded, naming whose hunt died, against which tee, at what distance.

**Why.** The union direction preserves the row-27 fix under a solver that is
still allowed to have an opinion — the solver can only add work, never
suppress it. The discard prevents recovery from manufacturing a second pad for
a hole that already has one.

**Evidence for.** Hunt declarations print verbatim (receipt line 196: *"badge
12: hunted — no visible tee could claim this badge (greedy nearest badge↔tee
matching over 15 visible tees); … hunted-set derivation is geometric
(deriveHuntTargets) plus pairability, never solver preference"*). `tests/unit/
g4HuntTargets.test.ts` (4 tests) covers the derivation.

**Evidence missing.** The union is exactly where row 29's **rung B** bites:
NorthPark H5 was orphaned by the post-discard re-solve. The discard logic and
the coverage-blind solver interact, and no receipt separates them.

**Recommendation: KEEP the union; HOLD the redundant-recovery discard.** The
union is a safety direction. The discard is the piece nearest the NorthPark
regression and deserves a receipt that isolates it before it is called good.

---

## 5. Contrapositive bare-support gate — `auditSupportFootprint` / `maxBareSupportFraction` (UNCOMMITTED)

This is the whole uncommitted diff and it needs the most scrutiny.

**What.** For each candidate, enumerate the *full hypothesized support band*
and classify every pixel: **white** (bright-mask evidence), **occluded** (owned
badge/basket/chrome pixel, OPAQUE sprite occlusion, screen chrome, or
off-raster), or **bare** (open ground where the outline should be and is not).
Reject when `bare/total > maxBareSupportFraction`. Default **0.7**.

**Why.** Row 29's **rung A**, verbatim: the promiscuous predicate. One Heritage
fragment at (277,910) satisfied the strict fit for badges 5, 6 **and** 10
simultaneously. With no spatial prefilter, a small shard fits a 3°-aligned pose
toward almost any badge. The owner's completeness invariant says there is no
third state — non-occluded means visible, occluded means recoverable — so a
band that is neither white nor named-occluded is a *contradiction*, not an
absence. The logic of the gate is exactly right and it is the correct answer to
a docketed rung.

### What is genuinely good here

- **Coordinate frames are correct.** `auditSupportFootprint` uses
  `occlusion?.kindAt(x, y + viewportTopPx)`, `pointInScreenChrome(x, y, …)` and
  a stage-frame `owned` set — identical conventions to the existing ownership
  filter at lines 925–930. I checked this specifically; it is consistent.
- **Scale-free.** A fraction, never a pixel literal. Footgun-law compliant.
- **Loud.** The audit prints on every accept *and* every contrapositive
  reject, with white/occluded/bare counts and the fraction beside the active
  threshold. Erosion of the separation would be receipt-visible.
- **It fires.** 25 contrapositive rejections in the DashsTrack receipt, all in
  the 0.860–0.968 band, all runner-up hypotheses of the promiscuous kind rung A
  describes.

### Problem 5a — the knob note's empirical claim is not reproducible

The note asserts a Dev6 audit distribution: *"known-real recovered pads
measured 0.42–0.63 bare while every observed garbage fragment measured
0.860–0.966."* Against the only post-gate receipt on disk:

- The **garbage half checks out**: 25 rejected rows, min 0.860, max 0.968.
- The **real-pad half does not**. There are exactly **two** rows in the entire
  receipt whose reason text is an accept ("every non-occluded visible component
  pixel … fits …"), and they measure **0.159** (badge 12, 422 white / 502) and
  **0.626** (badge 5, 188 white / 503). The claimed range 0.42–0.63 does not
  describe them: 0.159 is far below the stated floor.
- Worse: **both of those two rows are `also considered (not chosen)`.** They are
  runner-up hypotheses, not the three tees actually recovered. **The bare
  fractions of the three winning DashsTrack recoveries appear nowhere on
  disk.** The distribution the default is justified against is n=2, from
  non-winners, on one course — described in the note as a six-course audit.

The note is not lying about direction; it is overstating its sample by a large
factor and citing a range that its own receipt does not contain.

### Problem 5b — the default was fitted to the two points in hand

Owner-reported history: `0.15 → 0.5 → 0.7`. The working tree is at **0.7** — a
*third* value, and the brief's "0.15→0.5" is already stale. The two real-pad
samples explain the ladder exactly:

- at **0.15**, badge 12's real pad (0.159) is rejected → raise;
- at **0.5**, badge 5's real pad (0.626) is rejected → raise;
- **0.7** is the smallest round number that admits both.

The note's own arithmetic confirms the fit: "0.07 headroom" is 0.70 − 0.626,
"0.16 margin" is 0.860 − 0.70. Those are the two nearest observed points. This
is a threshold placed to make the observed cases pass, then documented as an
empirical finding. **The note is honest that the default is "EMPIRICAL AND
INTERIM" and that the 0.42–0.63 cause is "UNVERIFIED" — that candour is real
and should be preserved — but the sample size is misrepresented.**

### Problem 5c — a real pad is 63% bare and nobody knows why

This is the substantive open question, and the note says so: an earlier canopy
explanation was invented without looking and retracted the same day. A genuine
tee pad whose outline should be a closed white ring is reading 315 of 503 band
pixels as bare, on open fairway, with **zero** pixels attributed to any named
occluder. Either the bright mask is losing pad pixels (the renderer's
translucent corridor ribbons are the standing suspect), or there is an unnamed
occluder class, or the footprint is mislocalized. **Until that is settled by
pixels, the gate is thresholding a quantity we do not understand.** The
DashsTrack bare-pixel audit now running is exactly the right next act; this
section should not be accepted before it reports.

### Problem 5d — bright-mask check precedes the ownership check

```
if (stage.brightMask.data[y * stage.width + x]) { white++; continue; }
if (owned.has(...) || occlusion... ) { occluded++; continue; }
```

A bright pixel belonging to **another object** — a badge plate outline, a
basket glyph, a digit — is counted as **white evidence for this pad**, because
`brightMask` is tested before `owned`. That is backwards for the exact case the
gate exists to kill: the badge plate is ~450px of bright rounded-rect and the
band is ~500px, so a hypothesis centred inside a badge ("the tip of a 1 could
totally be a tee pad") gets its bare fraction *deflated by the badge's own
chrome*. The gate is weakest precisely where rung A said it must be strongest.
Not fatal — the gate still rejected 25 such candidates — but the ordering
should be `owned` first, and that is a code change, not a threshold change.

### Problem 5e — no measured outcome change, ~2× cost

On the only course with a post-gate receipt, `recoveredTees.length=3` both
before and after the gate. The gate removed 25 runner-ups and changed **no
final assignment**. Meanwhile `teeRecovery` went **8736ms → 16918ms** — and the
slower run did *less* downstream work (`rawPairs` 1440 vs 5832). The audit runs
a ~500-pixel double loop with string-keyed `Set` lookups per candidate, per
badge. So today the gate costs ~2× runtime and buys zero measured coverage; its
value is entirely the *future* rung-A garbage it will refuse. That may well be
worth it — but it should be accepted as a correctness guard, not sold as a
coverage win.

**Recommendation: HOLD.** The idea is right and matches the owner invariant
precisely. Do not land it until (i) the DashsTrack bare-pixel audit explains
why real pads are 42–63% bare, (ii) the accepted-winner bare fractions are
actually measured and printed for all six Dev6 courses so the default rests on
more than two non-winning samples, (iii) 5d's check order is fixed, and (iv)
the knob note is rewritten to state its true sample. If it lands sooner, the
ledger row must say **PARTIAL** with the n=2 basis spelled out.

---

## 6. Receipt plumbing

**What.** Named drop records for every pruned pairing, hunt declarations,
named dup-suppression (committed); the footprint audit line on every accept and
contrapositive reject (uncommitted).

**Why.** Standing policy: never silently drop a candidate; every number ships
with provenance.

**Evidence for.** Verified verbatim in
`artifacts/test/lab-sweep-through-g4/run.receipt.txt` and
`renders/run/run.visual.receipt.txt`. Every drop names the actor, the victim,
the measurement, and the knob that decided it. This is the best part of the
whole pile and it is what made this audit possible at all — I could reconstruct
the threshold-fitting history *from the receipts alone*.

**Evidence missing.** The accept-side audit line is not reaching the rejection
summary in a way that exposes **winners'** fractions (see 5a). The receipt
tells us everything about what was refused and nothing about what was kept.
That asymmetry is the reason problem 5a exists.

**Recommendation: KEEP, and extend.** Print the footprint audit for accepted
recoveries somewhere a reader can find it. Row 29's standing docket on receipt
verbosity levels (confirm vs `--dig`) is the natural home.

---

## 7. Test edits and schema regen

The schema regen is safe: `tests/unit/threeFactorSchema.test.ts` is
*generative* — it compares the checked-in file to a freshly built schema — so
the regen is self-verifying and needs no separate pin. The JSON parses.

`tests/unit/teeRecoveryFeature.test.ts` passes (17/17) with the new describe.
`tsc --noEmit` on `packages/alg` is clean. Item 8's syntax error is gone.

The individual test edits are flagged in section 8 below rather than blessed
here.

**Recommendation: KEEP the schema regen. HOLD the test edits** pending section 8.

---

## 8. Flagged: thresholds and expectations changed to make things pass

Documented, not fixed, as instructed. Six items.

**F1 — `maxBareSupportFraction` default 0.15 → 0.5 → 0.7 (uncommitted).**
The headline. Sections 5a/5b: each raise admitted one real-pad sample the
previous value rejected; the final value is fitted to two data points, both of
which are non-winning runner-ups on a single course, and the note describes
them as a six-course distribution with a range (0.42–0.63) that does not match
either sample (0.159, 0.626). *No change made.*

**F2 — fixture `knownTee` moved (committed, `10df47f`).**
`tests/unit/teeRecoveryFeature.test.ts` moved `knownTee` from `xPx: 115.5,
yPx: 93.5` to `xPx: 12, yPx: 12` — over 100px — while leaving `bbox: [110, 90,
12, 8]` untouched. The fixture's tee centre and its bounding box now describe
**different places**. The in-code comment concedes the reason: the old position
"was nearer badge-2 than badge-1 … an accident of fixture authorship that would
satisfy the wrong badge" — i.e. the fixture was relocated so `deriveHuntTargets`
would pick the intended badge. The defence, "only size medians are read from
it", is true of today's code and silently brittle against tomorrow's. Whether
or not the original placement was an accident, this is a fixture edited to
agree with new code, and it left the fixture internally incoherent. *No change
made.*

**F3 — `setActiveBareSupportFraction(1)` disables the new gate for the legacy
suite (uncommitted).**
Added to the `beforeEach` of `teeRecovery visible-component evidence contract`,
turning the contrapositive gate fully off for every pre-existing test in that
describe. The comment's justification is reasonable (synthetic fixtures sit on
synthetic open ground, so they would all read ~100% bare). But the effect is
that **no pre-existing test exercises the new gate**, and the only tests that do
are the two new ones written alongside it. There is also no `afterEach`
restoring the value — `activeBareSupportFraction` is module-global mutable
state, so this leaks to anything sharing the module instance. *No change made.*

**F4 — the two new contrapositive tests assert numbers, not behaviour
(uncommitted).**
Both test names promise a verdict; neither asserts one.

- *"a bare 9-pixel shard on open ground is **REJECTED**"* asserts only
  `expect(bare/total).toBeGreaterThan(0.7)`. It never checks that the candidate
  was rejected. It also selects its subject as
  `searchOutcomes.find(…)?.winner ?? candidates[0]` — a silent fallback that can
  test a different object than the one named.
- *"the same shard is **ACCEPTED** … **and the receipt prints the audit**"*
  asserts only `expect(bare/total).toBeLessThanOrEqual(0.7)`. It checks neither
  acceptance nor that the receipt printed anything.

Both hardcode the literal `0.7` rather than reading the knob default, so they
will keep passing unchanged if the default moves again. As written they assert
that `auditSupportFootprint` returns the numbers `auditSupportFootprint`
returns. *No change made.*

**F5 — "first rejected drawable" lookups filtered (committed, `10df47f`).**
Five tests changed `drawables.find(d => d.verdict === 'rejected')` to
`… && !/hunted --|removed before selection/.test(d.reason ?? '')`. This is
defensible — the new receipt lines legitimately crowd the front of the list —
but the filter is a **regex over prose**. Any rewording of a receipt line
silently changes which drawable five tests inspect. A structural discriminator
(a reason kind/code field) belongs here. *No change made.*

**F6 — the pins were re-pinned six times in one day.**
`FROZEN_DEFAULT_PLAN_FINGERPRINT` in `tests/unit/exec.compile.test.ts` now
carries a comment chain recording six consecutive "moves this pin again" events
dated 2026-08-28: zfit drop + G7 custody, `axisToleranceDeg`, `maxCompletions`,
the G1 OCR trio, `padClaimOutlierFactor`, and now `maxBareSupportFraction`
(`a60669eb… → f31e7890…`). `threeFactorConfig.test.ts`'s config hash moved with
it (`4421f931… → f1609dbd…`). Each individual bump is legitimate and
consciously annotated — the discipline is being followed. But a pin re-pinned
six times in a day is no longer detecting anything; it is a changelog. Worth
raising as a process question: these pins currently guard against *accidental*
plan drift, and at this edit rate they cannot. *No change made.*

---

## Summary table

| # | Change | Where | Class | Recommendation |
|---|---|---|---|---|
| 1 | Geometric hunt derivation | committed | proven-good (row 27 UPHELD, receipts verbatim) | **KEEP** |
| 2 | Recovered-tee → badge binding | committed | plausible-but-unvalidated (no isolating receipt) | **KEEP**, mark effect unmeasured |
| 3 | Plausibility prune | committed | proven-good (24 named receipt lines) | **KEEP** |
| 4a | Solver-widened hunt union | committed | plausible-but-unvalidated | **KEEP** |
| 4b | Redundant-recovery discard | committed | plausible-but-unvalidated; nearest the NorthPark H5 regression | **HOLD** |
| 5 | Contrapositive bare-support gate | uncommitted | right idea, **suspect default** (F1), one latent bug (5d), 0 measured gain, ~2× cost | **HOLD** |
| 6 | Receipt plumbing | split | proven-good — the best work in the pile | **KEEP + extend to accepts** |
| 7 | Schema regen | uncommitted | proven-good (generative pin) | **KEEP** |
| 8 | Test edits F2–F6 | split | **suspect** | **HOLD** — see section 8 |
| — | Syntax error | — | already fixed; `tsc` clean | — |

## If the owner wants the smallest safe landing

Keep 1, 3, 4a, 6, 7 (already pushed except 6's audit line and 7). Hold 5 behind
the DashsTrack bare-pixel result. Before any of 5 lands, three things that are
**not** threshold changes: fix the 5d check order, print the accepted-winner
audit fractions for all six Dev6 courses, and rewrite the knob note to state
n=2-on-one-course instead of a six-course range. Then set the default *once*,
from a distribution that exists.
