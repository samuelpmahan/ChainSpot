# Tee / basket recommendation funnel

ChainSpot must never use one unqualified success count for multiple pipeline stages.

## Required vocabulary

- **detected** — a raw detector emitted an object hypothesis. This says nothing about hole identity.
- **candidate-present** — at least one retained candidate is available for the hole/object under the scored fixture.
- **correctly-assigned** — the endpoint selected for Hole N matches Hole N ground truth within an explicitly reported pixel tolerance.
- **recommended** — the course pipeline emitted a tee/basket endpoint choice for Hole N.
- **surfaced** — that recommendation crossed the CV-to-authoritative-state boundary and actually entered annotation state.
- **snap-attempted** — first manual placement invoked local snap.
- **local-detector-accepted** — the worker found an in-radius candidate above its score floor. This is not yet `snapped`.
- **snapped** — the asynchronous local-snap result actually settled into authoritative annotation state.
- **semantically-correct** — the final user-visible point matches the declared semantic anchor within the stated tolerance.

Every aggregate is `numerator / denominator` plus a count of `not-instrumented` rows. `not-instrumented` is never silently counted as pass or fail.

## Existing `18/18` compatibility metrics

`scripts/verify-course-detection.ts` historically passed when the detector emitted exactly 18 labeled number badges and 18 basket candidates. That is an **inventory gate**, not an accuracy gate. The script now reports candidate inventory and truth-backed assignment accuracy separately. Plain image inputs have no endpoint ground truth, so assignment is explicitly `NOT SCORED`.

The older CLI's `teeTruthEvaluation.correctHoles` and `basketTruthEvaluation.correctHoles` are stronger: for each truth Hole N they check the endpoint grammar assigned to Hole N against Hole N truth using the reported tolerance. They still do not prove browser surface or local-snap settle.

## Current staged Pancake score semantics

The staged course detector uses P1–P6. P5 tee assignment exposes axis-error cost. P6 basket assignment exposes LowPar score and P6.2 may swap P6.1 ownership after ribbon adjudication. Those scores are not interchangeable and are not calibrated confidence.

`pancakeCourseDisplay.ts` still has a numeric compatibility sentinel because the existing annotation UI expects a legacy `confidence >= threshold` field. The sentinel is now named `PANCAKE_UI_ELIGIBILITY_SENTINEL` and must never be reported as detector confidence. Structured funnel output uses the real P5/P6 score names instead.

## Assignment history

`courseLandmarkTrace.ts` records tee ownership at P3, P4 and P5. Basket history records ungated P6.0, reconstructs the exact gated P6.1 assignment from the P6.2 swap diagnostic, and records P6.2 final ownership when a swap occurs. Reports should not show only the final assignment when an earlier stage made a different choice.

## Semantic anchors

Basket has an explicit downstream contract: **basket stem/base**, not sprite center. The P1 raw-mask basket coordinate uses bbox-center X and max-Y.

Tee currently uses the retained component centroid. That is a stable localization coordinate, but the downstream semantic contract is still unresolved: ChainSpot has not formally specified whether geometry wants pad center, launch edge, or another launch point. Reports therefore identify the current anchor instead of calling centroid proximity a proven launch-point metric.

## Live browser observability

`acceptCandidate()` is the exact boundary where a CV recommendation becomes authoritative domain state. Pancake recommendations carry runtime-only kind/candidate footprint metadata to that function; it records a surface observation and then discards all CV metadata from `AnnotatedHole`.

A small `BroadcastChannel` bridges those surfaced observations to the existing detector worker. A later local tee snap can use the measured full-course tee footprint as evidence without directly snapping to the full-course point. The worker broadcasts each detailed local-snap result back, including candidate count, score, radius and first rejection reason. The existing worker request/reply protocol remains unchanged.

Worker `accepted=true` does **not** mean `snapped=true`; stale async results can still be refused on the main thread. Actual settle is established by authoritative state/correction-log evidence.

## Local tee scale

Local tee snap previously used one badge-derived UI scale even though the full-course tee work showed pad footprint is not reliably UI-scaled across the corpus. Local snap now searches a bounded scale bank (`0.75×, 1×, 1.5×, 2×, 2.5×`) around the badge-derived value, plus the measured full-course footprint when available. The local score floor remains explicit and marker movement remains hard-capped at 24 source pixels.

## The Rec fixture

`resources/cv-fixtures/the-rec.json` contains nine-hole tee/basket semantic truth extracted from the supplied `MorePreciseHole4Rec` bundle. The matching source is `TheRec-R-stitched.png`, 2244×2212, SHA-256 `9d95dc6dccc07ab4d62353efdacf74bba95c315acd881d56403643356b351343`.

The binary source is deliberately not duplicated in the repository. Any executable audit must verify the raster SHA before scoring. The fixture concerns endpoint localization/recommendation only; Hole 4 corridor/centerline geometry remains outside this audit.

## Required row schema

`funnelAudit.ts` emits one row per hole/object with:

`course | hole | object | detected | candidateRank | scoreConfidence | assignedHole | assignmentCorrect | recommended | surfaced | snapped | semanticPointErrorPx | userCorrect | failureStage`

Any stage that cannot be observed is exactly `not-instrumented`.
