# CHSPT-80 — Stitch → Annotate-ready critical path

## Finding

The historical unit of scheduling is wrong.

`AnnotationWorkspace` currently does two things for every source image: starts `prewarmBasketDetection()`, then automatically calls `detectCourseCandidates()`. The worker queues requests serially. `prewarmBasketDetection` is not basket-specific: worker `prewarm` calls `loadRuntime()` + `loadTemplatePack()`, and `loadRuntime()` itself loads OpenCV plus that same pack. The pack rasterizes **all hole-number templates and the basket template**.

On the current `PANCAKE_STACK_ONLY` path, `detectCourse` still performs that bootstrap before P1. But P1 raw-object masking, ribbon segmentation, and P3/P4/P5/P6 ownership are TypeScript stages. OpenCV/template pixels are needed for P2 badge glyph labeling and for optional/local basket-template operations; MiddleOut also uses CV but is explicitly diagnostic.

That means source landmark propagation can remove substantially more than “run basket detection in parallel.”

## Smallest plausible production critical path

With CHSPT-78 + CHSPT-79 available:

1. Decode/crop source captures.
2. Obtain semantic pose seeds (real provider later; fixture/injected now).
3. Verify each usable seed with one local `cvMatch.matchTranslationNear`; invoke the existing global pair search only for failed/missing seeds.
4. Solve pose graph / render composite.
5. In parallel with pose/render work, detect semantic badge/basket landmarks in each **unwarped source**. Once transforms exist, map them through CHSPT-51 and fuse them with CHSPT-79.
6. Hand the fused, named evidence to Annotate Course with the composite identity and full source provenance.
7. Run only residual annotation work:
   - source hole numbers complete + source baskets complete, tees missing: **pure-TS tee path only** (P1 tee localization + ribbon/P3-P5 ownership), then grammar;
   - source numbers + tees complete, one *named* basket missing/occluded: one **named targeted basket fallback**, then grammar;
   - all three semantic kinds complete: grammar/handoff only; no initial course-CV worker bootstrap;
   - expected basket set unknown: fail closed to the existing global basket-discovery/assignment behavior rather than pretending a targeted search is safe.
8. Keep local snap lazy and corridor-bend detection eager/per-hole after tee+basket exists. Move MiddleOut diagnostics off first-ready latency entirely.

The source landmark detector does not need to wait for the composite render. Source-space detection can run as soon as a source raster exists; only source→composite mapping/fusion waits for the pose. The timing harness in `annotationCriticalPath.ts` models this as a DAG so concurrent branches are `max(...)`, not a sum.

## Expensive work that can disappear entirely

When named source **hole-number + basket** evidence is complete (the expected Agent-A handoff shape), the initial annotation path no longer needs:

- OpenCV WASM bootstrap **for initial course detection**;
- eager number-template loading/rasterization;
- eager basket-template loading/rasterization;
- P2 composite hole-number glyph labeling;
- global basket candidate regeneration / semantic basket ownership;
- P6 global basket assignment;
- composite basket occlusion recovery for already-resolved baskets;
- MiddleOut diagnostic work before the page becomes useful.

Tee work can remain pure TypeScript. If source tees are also propagated, P1/ribbon/P3-P5 can disappear too and the initial course detector collapses to source-evidence fusion + grammar.

Important nuance: current P1 still recognizes badge/basket-shaped components while finding tees because those families are used as scale references. That does **not** justify treating those incidental composite components as new semantic basket detections. To realize the invariant cleanly, P1 should accept propagated landmark/scale evidence (or expose a tee-only mode) so its internal badge/basket materialization can eventually disappear as well.

## What does *not* disappear

- CHSPT-51 source→composite transform propagation: reused as-is.
- Composite rendering: still needed for the user-visible image/handoff, but it can overlap source-landmark detection.
- Pure-TS tee/ribbon ownership while tee evidence is missing.
- Explicit targeted fallback for a **named** missing/occluded basket.
- Fail-closed global basket discovery when the expected basket set itself is unknown.
- Course grammar / proposal assembly.
- Local snap when the user actually clicks to correct a point.
- Corridor bend detection after a hole has tee+basket geometry; it is a separate worker and should not block the first useful map state.

## `prewarmBasketDetection` conclusion

Do not preserve its semantics.

The current function is a generic course-CV worker bootstrap with an over-specific historical name, and even that generic bootstrap is conditional after source evidence exists. The production API should become dependency-driven, e.g. `prewarmCourseCv(plan)`, and should load only the assets required by the residual plan:

- `none`: do not create/warm the course worker for readiness;
- `number-only`: OpenCV + number templates only;
- `basket-fallback`: OpenCV + basket template only;
- `number-and-basket`: both.

Fail-closed **global basket discovery** on the Pancake path is pure-TS P1/P6 work and therefore does not itself justify loading the basket template; it only keeps the global discovery/assignment stages alive. A *named targeted fallback* does need the basket template.

The current worker cannot realize these bootstrap modes because `loadTemplatePack()` is all-or-nothing. That split is the smallest bootstrap refactor worth doing; eagerly warming the existing all-assets worker would preserve the very cost CHSPT-80 is meant to remove.

## Timing discipline

`CourseDetectionPerformance` already exposes most stage durations, and the worker additionally emits a `middleOutMs` field at runtime that the public main-thread type does not currently name. `classifyRemovableObservedWork` consumes a structural timing snapshot and totals only **whole measured stages that truly disappear**. It intentionally refuses to assign milliseconds to basket-only work embedded inside mixed P1/P3/P4 stages.

That sum is deleted CPU/work, **not** a wall-clock speedup. For latency, use `analyzeCriticalPath` with observed durations and real dependencies; independent source-landmark detection, composite rendering, and any speculative residual bootstrap may overlap.

No device/browser benchmark was fabricated in this ticket. The executable harness is ready to consume real fixture/browser timings; a production integration run is required before quoting end-to-end milliseconds.

## Integration seams to implement, not replace

- `poseGraph.ts`: accept optional semantic pair seeds and call CHSPT-78 around the existing pair-search fallback; do not create a second pose graph.
- `stitchPipeline.ts`: pass seeds/diagnostics through and retain per-pair timing/path selection.
- Stitch handoff/session: carry CHSPT-79 `SourceLandmarkHandoff` alongside existing provenance/source-capture bytes, keyed by exact composite identity.
- `AnnotationWorkspace`: resolve source evidence first, populate named baskets/badges, then execute the residual plan rather than unconditional `prewarmBasketDetection` + `detectCourseCandidates`.
- Course CV worker: split bootstrap assets and accept propagated basket/badge inputs; global P6 should not run for baskets whose hole identity is already known.

These are extensions of the existing CHSPT-51/provenance and `poseGraph.ts` architecture, not replacements.
