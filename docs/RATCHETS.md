# RATCHETS

Course-derived thresholds (footgun-law-compliant knobs) still embed a shape
assumption — "no real X sits beyond the bound the derivation encodes." This
document is the registry of every time a confirmed-real case broke one of
those assumptions, and the law that governs the response.

## The law

0. **STEP 0, before anything else: verify the measurement itself**, per the
   `receipt-reconcile` skill, BEFORE treating a broken threshold as a
   footgun firing. Check (i) whether the fitted rectangle/pose is sound
   against the actual pixels — bad rectangles are the dominant error
   source (owner: "genuinely 80% of the error if not more") — and (ii)
   whether the right object was measured at all, with the receipt showing
   WHAT was looked at (a visual anchor, not just a number). A case whose
   measurement fails either check is a **MEASUREMENT DEFECT**: fix the
   measuring, leave the threshold untouched. Widening a bound to admit a
   garbage measurement bakes the garbage in permanently. Only a
   measurement-VERIFIED extreme may enter the registry or move a bound.

a. **A confirmed-real case breaking a derived threshold — once its
   measurement clears Step 0 — is a footgun firing, full stop.** The gate
   was wrong, not the hole. There is no "logic'd upon" — no explanation
   that argues the extreme away, no per-case exception that lets the
   outlier through while leaving the bound as printed.

b. **Mandatory response, mechanical, in this order:**
   1. Verify the measurement (Step 0). Stop here, as a measurement-defect
      fix, if it fails.
   2. Append the extreme to the [Registry](#registry) below, WITH its
      receipt pointer (measurement + which artifact/log line it lives at)
      and its measurement-verified status.
   3. Update the threshold's DERIVATION so it admits the entire recorded
      population for that knob — every row ever appended, not just the
      newest one.

c. **Forbidden responses:**
   - A per-case exception ("this one hole is special, carve it out").
   - Dismissing the extreme as a flake, a bad frame, or noise, without a
     receipt-backed reason to distrust the measurement itself.
   - Leaving the threshold unchanged and just noting the miss elsewhere.
   - Skipping Step 0 and widening a bound on an unverified measurement.

d. **Ratchet direction: bounds only widen to include real, measurement-
   verified cases.** A proposal to *tighten* a ratcheted bound must
   re-prove itself against every row recorded here — the unit test in
   `tests/unit/thresholdRatchets.test.ts` is what enforces that re-proof,
   not a person's memory of the table.

e. **Claims-ledger discipline applies:** every row appends in the SAME
   COMMIT as the work that discovered it. A discovery without its registry
   row in the same commit is not yet accepted work.

## Registry

| Knob | Owning feature file | Assumption it encodes | Recorded real extremes | Measurement verified? | Status |
|---|---|---|---|---|---|
| `g4.search` `padClaimOutlierFactor` (default 3) | `packages/alg/src/detectors/threeFactor/features/g4.search.ts` | No real pad sits beyond 3x the median badge↔tee claim distance on a given run. | Real claim ratio **2.00** — Heritage H17, `tee-19` at ~129px vs median 64.3px on that course. Receipt: `artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt`, `measurement padClaimDistancePx` (max=128.99) / `measurement padClaimMedianPx` (64.309) lines, cross-checked against the `HOLE ASSIGNMENTS` `H17 \| badge-17 \| tee-19 -> basket-17` row. | **NOT YET VERIFIED** — the 129px distance is computed from the detector's tee POSITION only; the fitted rectangle/pose behind that position has not been checked against the actual pixels per Step 0 / `receipt-reconcile`. Status below stands on the assignment-record number, not yet on a pixel-checked pose. | **HOLDING** (margin 1.5x: factor 3 vs recorded extreme 2.00) — pending Step 0 verification |
| `teeRecovery` `axisToleranceDeg` (default 3°) | `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts` | Real recovered-pad axis error stays under 3°. | Max real accepted `axisErrorDeg` = **2.5** (n=2, min≈2.49999998°, max≈2.50000000°). Receipt: same run, `artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt`, `measurement axisErrorDeg` line. | **NOT YET VERIFIED** — likewise a receipt-printed number, not yet checked against pixels/crops for rectangle soundness or right-object identity per Step 0. | **HOLDING** (margin 0.5°) — pending Step 0 verification |
| `raster.ts` `brightVMin` (ABSOLUTE LITERAL 210 — not even course-derived) | `packages/alg/src/detectors/threeFactor/raster.ts` | Every real pad outline pixel has V >= 210. | DashsTrack badge-5's real, correctly-located recovered pad (`tee-recovered-1`) measures **mean V = 188.7** over its 26x26 crop region, well under 210. Receipt: `docs/orchestration/2026-08-28-bare-pixel-audit.md` (measurement table, "tee-recovered-1 (badge 5)" row); crops in `artifacts/orchestration/bare-pixel-audit/`. **Open question the audit leaves unsettled**: the healthy comparison pad `tee-2` (badge 3, genuine, segments fine) measured mean V = 183.9 over the *same kind of crop region* — LOWER than the failing pad's 188.7 — so a crop-region mean V is not yet proof the literal is discriminating correctly at all; the definitive **outline-pixels-only** measurement (not whole-crop mean) is still owed before this ratchet's derivation can be trusted. | **VERIFIED** — pixel audit WITH crops (`artifacts/orchestration/bare-pixel-audit/`), confirming both the location (right object) and the pixels themselves, per `docs/orchestration/2026-08-28-bare-pixel-audit.md`. | **FIRED — awaiting fix.** Backlog item 3 in `/home/user/chainspot-backlog.md` ("course-derive the bright-mask threshold") is the tracked remediation. |
| `teeRecovery` `maxBareSupportFraction` (uncommitted, default in flux) | `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts` | Real recoveries' bare fraction stays below X. | **NONE VALID YET.** Winner-side (accepted-candidate) bare-fraction audits are not currently printed in receipts — a known gap. The only accept-side samples on record (0.159, 0.626) are runner-ups on one course, not accepted winners, so they cannot seed this row. | n/a — no candidate extreme exists yet to verify. | **UNSEEDED** — do not trust any current default until winner-side data exists. Backlog item 1 in `/home/user/chainspot-backlog.md` ("print footprint audit for ACCEPTED candidates in receipts") is the tracked prerequisite. |

Teeth: `tests/unit/thresholdRatchets.test.ts` asserts, for every seedable row
above, that the CURRENT configuration admits the recorded real extreme.
