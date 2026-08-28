# The Claims Ledger

Every load-bearing diagnostic claim gets a row here WITH its receipt (the
evidence a human can check), and its fate. A retraction is a first-class
entry — the ledger exists because claims that sound like evidence get
believed, and the only defense is receipts visible to the owner plus a
public record of which claims died on contact with them.

Rules (binding on every agent working this repo):

1. A claim that steers work (a diagnosis, a root cause, a "this hole is
   missing because...") is entered here when made, status PENDING, with its
   receipt: verbatim receipt lines, artifact paths, or the command that
   reproduces the evidence. No receipt, no claim.
2. When a receipt survives challenge, mark UPHELD. When falsified, mark
   RETRACTED and record what falsified it and what the truth turned out to
   be — the retraction text is the valuable part.
3. Never edit a dead claim's row to look smarter; append the correction.
4. This file is a handoff document like INTAKE-ENGINE-HANDOFF.md: agents
   update it in the same commit as the work it describes.

Format: `date | claim | receipt | status | fate`.

---

## 2026-08-28 — founding entries (the day the ledger earned its existence)

| # | Claim | Receipt | Status | Fate |
|---|---|---|---|---|
| 1 | NorthPark H14's tee pad points ~19.8° off its badge ray; the 3° axis gate is what blocks recovery. | G4 rejection pixels (679-686,1026) + offline PCA vs ray math. | **RETRACTED** | The "shard" was badge 15's "5" digit glyph (14×21, area 155, centroid (683,1036) = H15's badge position). The angle was measured on chrome. Falsified by the owner's crop challenge + the component forensic table. Truth: digit glyphs escaped ownership subtraction (fixed, `dc96000`); H14's real pad likely merged with the basket glyph — reclassification pending. |
| 2 | NorthPark H16's badge baseline (~8px) makes the badge ray numeric noise; needs a short-baseline PCA fallback. | Component table: rejected shard = comp#304, 7×21, area 78, 8px from badge. | **RETRACTED** (evidence), reframed | comp#304 is badge 16's own "1" digit. The real pad is comp#306 (19×14, area 153, (798,1169), 5.0° on-axis) — never considered, because... see claim 3. And per the owner's z-order observation the pad renders ON TOP of its C2D, so H16 is a **G3 visible-detection defect** (dash-broken ring), not a recovery case at all. |
| 3 | G4 recovery discovery only searches ~83px around the PREDECESSOR hole's basket tip; everything else is structurally unfindable. | `g3.teeRecovery.ts:622-630` (anchor = basket tip, radius = hypot(padHalf)+observedSpan+4); post-fix NorthPark trace `seedFragments: 0, candidates: 0` with a 153px on-axis pad 60-100px away. | **UPHELD** | Owner's law issued (no absolute course-distance assumptions, ever). Fix in flight: predicate-as-filter over all unowned bright components, known-occluder pixel subtraction, no spatial prefilter. |
| 4 | Badge digit glyphs are separate bright components inside the plate's dark interior and escape recovery's ownership subtraction. | Component signature trio at every badge (plate ~450px 55×42, "1" digit 78px 7×21, second digit ~155px 14×21); pre-fix rejections vanish post-fix. | **UPHELD** | Fixed in `dc96000` (own every bright pixel in badge bbox). DashsTrack parity held byte-exact. |
| 5 | HeritagePark H5 has "no visible evidence" (complete-invisibility / phantom territory). | Absence of G4 hypotheses in the trace. | **RETRACTED** | comp#1096: 50px, 12×16, at (729,1154), 77px below badge 5 — real, visible, outside the discovery box. Falsified by the owner's crop + component table. Class reassignment pending the invariant classification. |
| 6 | HeritagePark H6's visible support is 2 pixels (< 8 minimum). | `rejectionReason badge 6: visible component support 2 < 8`. | **RETRACTED** (as stated) | The 2px was the anti-aliasing halo of badge 6's own digit — chrome again. The real pad is comp#778: 21px, 3×7, 71px below the badge, 4.0° on-axis, outside the discovery box. |
| 7 | Heritage H17's pad is absent from the bright mask near the badge (mask-threshold class). | Component table: only chrome + 2px specks within 110px of badge 17. | PENDING | The owner's crop shows a pad to the right, possibly beyond the inspected window or too dim for the mask. Needs the wider look; discovery lane's classification will rule. |
| 8 | Every tee is either non-occluded (G3 must find it) or occluded by a known occluder (G4 must recover it); no third state. | Owner invariant, 2026-08-28. | ADOPTED as contract | Discovery lane must classify every missed Dev6 hole: G3-defect / recovered / recovery-rejected(reason) / invisible — each with pixel receipts, entered here when delivered. |
| 9 | C1S/C2D range circles (solid 10m / dashed 20m) are in-scene renderer chrome whose z-order vs the tee pad varies by course zoom (NP: pad on top; DT: pad under), and their fitted pixel radii imply meters-per-pixel. | Owner observation + `g3.teeReceipts.ts:136` vocabulary; StripChrome receipt shows intake never touches them. | PENDING | Chrome classifier + metersPerPixel measurement chartered in the discovery lane; receipts to land here. |

## 2026-08-28 — discovery de-footgun lane: settlements

| # | Claim | Receipt | Status | Fate |
|---|---|---|---|---|
| 10 | Row 3 root-cause, precise mechanism: on the real NorthPark canonical raster, H16's own tee pad (bright component 19x14/area 153 at (798,1169), componentLabel 306) DOES fall inside the old predecessor-basket radius box by coordinate math (distance to basket-9's tip = 57px < radius 88.59px) -- but it never reached `visibleComponents` because `ownership`, not the region test, excluded it: G3 had already registered that exact component as `tee-11`'s pad, and G5/G6 assignment/scoring had mis-paired `tee-11` to badge-4 (hole 12) at a near-zero garbage score (2.4e-13) instead of hole 16. | Instrumented trace on `dc96000` unmodified code, real NorthPark sweep: `near component label=306 ... distToAnchor=57.0 ... ownedCount=153 inBoxCount=153` (all 153 pixels owned) plus `tee tee-11 pad.bbox=[789,1162,19,14] pad.componentLabel=306` and `assignment badgeId=badge-4 teeId=tee-11 basketId=basket-5 score=2.428394544561205e-13`. | UPHELD, refines rows 1-2 | This is NOT "row 2's G3 z-order/dash-broken-ring defect" -- G3 correctly found and localized the pad as a normal, complete, non-occluded tee (`tee-11`). The defect is downstream, in G5/G6 assignment scoring accepting a 2.4e-13-score row over letting hole 16 claim its own visible tee. See row 12 below for what actually happened once the tee pool grew. |
| 11 | NorthPark H14 (badge 14, bbox [674,946,56,42]) has no bright component registered as a tee pad anywhere near its own badge; its predecessor's basket (basket-8, hole 13's basket, tip (919,1095)) sits ~245px from badge 14's position, far outside the ~89px predecessor-anchored box -- so the box design could never search where H14's evidence would be even if present. | Full badge/tee position dump from the same instrumented `dc96000` trace: no `tee.pad.bbox` entry falls within ~150px of badge 14's centroid (700.2,966.5); nearest is `tee-9` at (823,1067), 146px away. | UPHELD | Confirmed the genuine "predecessor-anchor is the wrong worldview" shape of the footgun (as opposed to H16's assignment-scoring shape). Fixed structurally by removing the spatial prefilter entirely (row 3's fate). |
| 12 | After replacing the predecessor-basket-radius box with a global, no-spatial-prefilter search (every unowned, non-occluded bright component is a candidate for every missing badge; strict predicate unchanged), NorthPark H14 and H18 each get a new accepted G4 recovery candidate, and the resulting larger tee pool lets G5/G6's whole-board reassignment also correctly re-pair `tee-11` to hole 16 (fixing row 10's mis-pairing as a side effect, without any code change in scoring/routing). All 18 NorthPark holes end with a real assignment and 0 warnings. | `packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts` (`buildTeeRecoveryCandidates`, `git log` on this lane's commits); real NorthPark sweep after the fix: `results.recoveredTees: 2`, final table rows `H16 \| badge-10 \| tee-11 -> basket-10`, `H14 \| badge-7 \| tee-recovered-0 -> basket-5`, `H18 \| badge-12 \| tee-recovered-1 -> basket-13`, `WARNINGS (none)`. Repro: `./lab sweep packages/alg/src/detectors/threeFactor/configs/tee-recovery-on.json chainspot-corpus/dev/NorthPark/NorthPark-full.png`. | UPHELD | Resolves row 7's open PENDING adjacently (Heritage H17 still separately triaged below) and settles row 8's contract requirement for NorthPark: H16 classifies as **recovered-via-reassignment-cascade** (G3 found it correctly; G5/G6 scoring lost it; G4's bigger tee pool let reassignment recover it), not G3-defect and not a G4-recovery-direct-accept. H14 and H18 classify as **recovered** (direct G4 accept). See the discovery-lane final report for the full per-hole class table (also covering Heritage/AlexClark) and the DashsTrack full-parity receipt (18/18/18/18/4860 raw pairs/0 warnings, `tests/unit/dashsTrackSweep.test.ts` G6 now a real assertion, not `test.fails`). |
| 13 | C1S/C2D range-circle dash pixel-subtraction classifier (row 9) is designed but deferred out of this lane: the fix must be per-course, per-basket circle fit (never an assumed radius) with pixel-level (not whole-component) subtraction, because z-order between the tee pad and its C2D ring is not fixed across courses. Screen-chrome pixel subtraction (the already-built `screenChrome.ts` classifier) IS wired into this lane's discovery as a stopgap known-occluder cut. | Design note inline at `g3.teeRecovery.ts` (above `buildTeeRecoveryCandidates`); screen-chrome wiring: `exactKnownPixels`/`visibleComponents` in the same file, receipts via `ctx.overlay('teeRecovery', {... reason: "component N: K pixels subtracted as screen chrome ..."})` and `ctx.measure('teeRecovery','chromeSubtractedComponents', ...)`. | DEFERRED (documented) | Do not build features on this until the circle fit lands. `metersPerPixel` measurement (row 9's bonus ask) is not emitted by this lane for the same reason -- it depends on the same fit. |

## Standing dockets awaiting receipts

- Axis-tolerance ladder (soft ceiling, target P100 5° then 3°): does any
  REAL shard need more than the strict gate once chrome is owned and
  discovery is unbounded? Null result is a legitimate verdict.
- The 8 missed Dev6 holes, classified per the invariant (claim 8).
- Minesweeper Index HIGH items (docs/minesweeper/): each fix must enter
  here with its before/after receipt.
