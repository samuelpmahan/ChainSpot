# Frontend CV audit — 2026-08-20

Scope: every CV module that ships to the browser — `src/lib/autoAnnotation`
(~25k lines: Pancake P1–P6, tee/basket detectors, ribbon/corridor evidence,
calibration, workers, facade), `src/lib/nuthing` (render-identity pipeline),
`src/lib/stitch` (AutoCrop/AutoStitch), `src/lib/cv`.

Method: five parallel auditors, each briefed with the measured render-identity
facts (screen-space sprite 42×66 / badge frame vs geographic zones, corridors,
pads — CX-058) and the CX-059 lesson (a single dev-zoom-tuned gate silently
cost three holes). Lenses: scale coupling, coordinate-frame correctness,
determinism, worker protocol, dead code, duplication, perf. The top findings
below were re-verified by hand against source before being signed; line
numbers are as of this commit.

Status legend: **[open]** needs a fix, **[fixed]** fixed in the audit commit,
**[by design]** verified intentional, documented here so it stops looking
like an oversight.

---

## High — correctness

**H1. [open] P6 forward gate scores each basket against a different Y than
its ranking score.** `p6LowParBasketAssignment.ts` passes the whole
`RawMaskBasket` into `forwardGateForBasket`, which reads `basket.yPx` —
defined in `rawObjectMask.ts:728` as `component.maxY` (bbox **bottom**) —
while `scoreLowParBasketCandidate` on the same candidate gets
`centerXPx/centerYPx` (bbox **center**). On the fixed 42×66 sprite that is a
~30px vertical disagreement inside one scoring pass; the 80° forward-angle
gate can pass a basket the score rejects and vice versa. Same bug family as
sprite-center-vs-pole-tip (CX-038). Fix: pass
`{ xPx: basket.centerXPx, yPx: basket.centerYPx }` to the gate.

**H2. [open] Single-image AutoCrop demotes nearly every import to
'review'.** `autoCrop.ts:584`: `if (margined !== detected) anyWeak = true`
compares the **margin-adjusted** inset (`clamped + DEFAULT_CROP_SAFETY_MARGIN_PX`,
margin defaults to 2) against the raw detection, so `anyWeak` fires on every
clean, unclamped detection. `stitchPipeline.ts` then maps crop confidence
'low' → pipeline confidence 'review' + a user-facing warning, defeating the
auto-first premise for every N=1 import. The batch path
(`proposeCropDetailed:474`) compares `clamped !== shared` — correct. Fix:
compare `clamped !== detected` before the margin is added.

## High — scale coupling (the CX-059 class, in the legacy stack)

**H3. [open] Legacy P1 tee gates are anchored to zoom-invariant sprite
medians.** `rawObjectMask.ts:651-663`: tee candidates are gated by
`areaVsBasket` (0.06–0.35 × basket median area), `minDim`
(0.3 × badge median height), `maxDim` (2 × basket median width). Baskets and
badges are screen-space (fixed size at every zoom); tee pads are geographic.
At 2× zoom real pads grow past the ratio ceilings exactly the way CX-059's
fill floor rejected large/rotated pads. No scale pathway inside the module.

**H4. [open] `teePadDetection.ts` sizes every search window from
`uiScalePx` — the axis `worldScale.ts` itself documents as wrong for
terrain.** All four detector families (gray-center, edge-loop, occluded
edge-loop, dashed-path) and the fusion dedupe radius key off
`uiScalePx / raster.sourceScale`. The only correction is external:
`cvCalibratedDetectors.ts` pre-downscales the raster by `1/worldScale`, and
only when `worldScale > 1 + band` — captures with `worldScale < 1` pass
through unnormalized (its own comment says so). Fix direction: make the
world-scale factor an explicit required input rather than an invisible
upstream raster contract.

**H5. [open] The live, authoritative corridor-bend detector's tube radius is
dev-zoom hardcoded.** `corridorBendDetectionCapsule.ts`:
`capsuleRadiusSrcPx: 21` (7 grid px × the Python probe's fixed 1/3 scale).
`evidenceGrid.scale` corrects for the local crop's resolution, never for
capture zoom; at 2× zoom the true corridor half-width (~37px) nearly doubles
the tube, diluting evidence below `capsuleMarginScore` — bend proposals
silently degrade on higher-zoom captures. This is the module invoked by
Annotate Course's eager bend detection.

**H6. [open] The zero-bend chord gate is 3px at any zoom.**
`zeroBendChord.ts:42` (`maxDistancePx ?? 3`, flag-toggleable to 4): the
perpendicular offset of a geographic badge position from a geographic chord,
gated at a fixed pixel count. Feeds P3's `zeroBendConfirmed` and P6's
`computeZeroBendLocks` — a wrong lock at the wrong zoom steals a basket.
`worldScale` never reaches it.

## Medium

**M1. [fixed] NuThing producer: near-1 `geoScale` shifted every emitted
coordinate.** `resampleToGeometryFrame` treats |geoScale−1| < 2% as identity,
but `nuthingCourseDetection.ts` divided by the raw option anyway — a
console-set `nuthingGeoScale` of 0.99 would shift all output ~1%. Fixed in
this commit: all frame mappings use the scale actually applied
(`appliedGeoScale`); producer probe re-verified (The Rec 9/9, Dashs 18/18).

**M2. [open] `ribbonMass.ts`'s doc contract is stale — it gates production.**
The module header says it "never gates any production decision", but
`p4RibbonOwnership.ts` feeds `segmentRibbonMass` output into tee-resolution
status on both production paths, which gates P5/P6. A tuning change made in
reliance on that comment would silently change ownership. Fix the comment
(and its copy in `corridorBendDetectionRibbonMass.ts`).

**M3. [open] The whole-course ribbon-mass segmentation runs twice per
detection.** `sourcePriorCourseDetection.ts` / the legacy worker compute
`segmentRibbonMass`, then `ribbonMassShadow.worker.ts` recomputes the
identical pass (same params, same badges) on every detection purely for the
shadow record. Also: `ribbonMass.ts`'s box-mean is O(n·window) (window 41 over
the full-course grid, ~51M ops ×2 passes ×2 runs) while
`corridorBendDetectionCapsule.ts` already has the O(n) prefix-sum
implementation. Pass the computed segmentation into the shadow instead;
share the prefix-sum box mean.

**M4. [open] `p5SparseAssignment.ts:270` hardcodes an 18-hole course.**
`perfectMatchingFound: assignedTees === 18 && …` corrupts the diagnostic on
9-hole (The Rec) or any non-18 course. Compare against `tees.length`.

**M5. [open] `middleOutRibbon.ts` production caller never overrides the
dev-tuned widths (24–64 src px).** At 2× zoom (~74px corridors) the largest
tested width still lands inside the ribbon, collapsing paired-edge contrast.
Diagnostic-overlay-only today, but user-visible and silently wrong at non-dev
zoom.

**M6. [open] `activeReview.ts` clamps its self-scaling link radius to fixed
[80, 320]px, and `recommendNextAnchor`'s manual-placement fallback bypasses
the adaptive radius entirely** (filters on the raw 320 constant).

**M7. [open] `teePadOrientation.ts` hardcodes a 24–36px world-size template
bank (two dev courses) and discards the sweep's measured winning size —
`fittedPadFromSweep` fabricates pad extents from `uiScalePx`, the axis the
file's own header says is wrong. Production-dead (see D4) but live in two
scripts.**

**M8. [open] `smartImport.ts:analyzeInWorker` leaks listeners on synchronous
`postMessage` failure** (dangling `onMessage` on the shared worker per
occurrence).

**M9. [open] NuThing grammar output populates tee `detectorConfidence` with
pair confidence** while the basket branch correctly uses the sprite score —
cross-lane consumers reading `detectorConfidence` generically get a
differently-sourced signal. Surface a tier-derived per-tee signal or document
the deviation.

## Dead code / genealogy map

| Module | Verdict |
| --- | --- |
| `corridorBendDetection.ts` | live as shared infra (`cropSourceRasterAroundHole`, types); its own shortest-path detector superseded |
| `corridorBendDetectionCapsule(.worker/Worker).ts` | **live production** bend detector |
| `corridorBendDetectionRibbon.ts`, `corridorBendDetectionRibbonMass.ts` | eval-only by their own headers, test-imported only |
| `corridorBendDetectionCapsuleRibbonMass.ts` ("arm D") | dead — underperformed shipped arm C |
| `corridorEvidenceGridRibbonMass.ts` | split: ring-radius half **live** via P4; `buildModernCorridorEvidence` half dead (only arm D imports it) |
| `p4RibbonOwnership.ts` P4.5 block (~180 lines: `deriveP45EndpointBridgeExperiment` + helpers + `P45_*` constants) | dead, zero importers |
| `annotationCriticalPath.ts` | tested but unused by the real worker path (planning artifact) |
| `teePadOrientation.ts` | production-dead; superseded by `teeBootstrapPolicy.ts`'s calibrated reimplementation; still used by 2 scripts + tests |
| `ribbon.ts` `discoverBadgeEndpoints`, `assignCourseEndpoints` | dead (superseded by `scoreEndpointComponents`/`assignCourseEndpointsChain`) |
| `renderScale.ts` `estimateRenderScale` | probe-only (scripts), not wired — matches the open CX zoom-estimator item |
| `collinearityStraightnessTest.ts`, `basketBendPolarity.ts` | **[by design]** eval-only / validated-but-unwired, honestly documented |

Duplication worth one extraction: the hollow rotated-pad template synthesizer
exists four times (`teeOcclusionRecovery`, `teeBootstrapPolicy`,
`teePadOrientation`, `teeMetricBattery`) with drifting constants
(three use aspect 1.45, one still 13/8).

## Systemic reading

The codebase already knows there are two scale axes — `uiScalePx`
(screen-space chrome) and `worldScale` (geographic terrain) — and
`worldScale.ts`'s header states the distinction precisely. But the world axis
reaches exactly one consumer (tee-detection raster normalization, and only
for `worldScale > 1`), while H3–H6 show geographic thresholds keyed to the
wrong axis or to no axis across P1, P6, zero-bend, and the live bend
detector. The NuThing dual-scale design (CX-058: screen-space stages on the
native raster, geometry on a scale-normalized raster, one explicit
`geoScale`) is the generalization the legacy stack needs; the practical fix
order is H1/H2 (pure correctness, small diffs), then thread one capture-scale
value through H3–H6 rather than patching each constant separately.

Shared limitation, already tracked (task #22 / CX-034): both live corridor
evidence builders (`buildClassicCorridorEvidence`, `segmentRibbonMass`) are
brightness-differential with flat divisors — canopy dimming thins them
exactly where trees shade the corridor. The audit confirms no compensation
exists anywhere in the live paths.

Everything the audit verified as sound is worth naming too: `cvMatch`'s
coarse-to-fine matcher, the pose graph, `renderComposite`'s determinism
(byte-parity with the headless harness is now e2e-tested), the semantic
landmark scan, the worker token protocol, the badge glyph classifier's
self-relative resampling, the `basketDetection.ts` lane fallthrough, and the
evidence-event contract (no `locked` emissions, descriptive operator names).
