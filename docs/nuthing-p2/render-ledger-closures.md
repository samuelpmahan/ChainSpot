# NuThing render-ledger closures

Experimental browser-lane closure pass. The frozen pair-matrix measurement and its dev72 replay corpus remain unchanged; `nuthingCourseDetection` opts into `coursePairingLedger.ts` so the new behavior can be validated without rewriting the historical oracle.

## Deliberately handled cases

| raster element / failure family | treatment |
|---|---|
| normal corridor | existing paired-edge support + bestTheta remains primary |
| bright/dark underlay polarity flip | four luma buckets learn signed inside-minus-outside lift from geometry-self-consistent straight triples |
| one edge hidden by badge or basket sprite | visible flank is scored against the signed bucket model; hidden flank is unknown, not negative evidence |
| short RibbonExit between healthy spans | low-support cells may be raised only when healthy paired support exists before and after along the local ribbon direction and one flank agrees with the learned lift |
| BTD walking path / narrow linear confusers | routing is frozen first; pair-scoring support is then mildly discounted where a strong linear ridge fails the corridor-width lift test |
| normal tee | existing hollow-ring / component render-identity detector |
| tee touching known basket furniture | existing masked-NCC tee recovery runs locally around unresolved basket occluders and adds only high-score, physically-overlapping `recovered` tier candidates |
| basket/C1/C2 zones | existing pairScoring foreign-zone attribution remains authoritative; the new linear discount skips the basket-zone neighborhood to avoid double-taxing it |

## Calibration contract

No course label or truth is used. A calibration triple is admitted only when a ring-tier tee's measured long axis points at a numeric badge, the same badge lies on a nearly collinear tee-to-basket chord inside the measured 0.16..0.56 longitudinal band, the basket has solid sprite identity, and the frozen paired-edge matrix already gives that same pair healthy baseline evidence. Ambiguous triples are rejected.

Four outside-ground luma buckets (0-63, 64-127, 128-191, 192-255) retain count, mean signed lift, and MAD. Sparse buckets fall back to the course-global distribution.

## Safety shape

The new support is additive only for known occlusion or short continuity-backed gaps. It never replaces healthy paired-edge evidence. Walking-path handling is deliberately scoring-only: the routing cost surface is copied before the narrow-linear consistency discount, so the new discriminator cannot steer Dijkstra onto a novel route.

Runtime counters are returned under `result.nuthing.ledger`: calibration triples/samples, bucket counts/means, patched cell counts, recovered tee count, consistency-discount count, and whether a second routing pass was required.

## Validation required before merge

1. `npm run check` and the unit suite.
2. Run `scripts/nuthing/browser-producer-dev-replay.ts` on DashsTrack, HeritagePark, Lenard, and TowneLake so the actual `detectCourseWithNuThing()` path—not just the historical replay—must reproduce dev72.
3. Re-run The Rec through that same browser producer and visually inspect 1-9.
4. Confirm no regression on the frozen offline oracle.
5. Inspect every newly added runtime recovered tee; masked NCC is intentionally conservative but remains the highest-risk closure.
6. Compare route/assignment deltas separately: RibbonExit repair is allowed to reroute; walking-path consistency is not.
