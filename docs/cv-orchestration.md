# CV orchestration — evidence, identity, scheduling, caching

Companion to `rebuild-spec.md`. That doc says WHAT each page consumes; this one
says how the CV actually runs: fast, streaming, never redone, never
double-counted.

## The core split: observations vs entities

The whole design hangs on one distinction:

```ts
// An OBSERVATION is an immutable fact about ONE image, in THAT image's pixels.
// It is what a detector emits. It never changes and is never displayed raw.
interface Observation {
  readonly id: string
  readonly imageId: string            // sha256 of the source file bytes
  readonly kind: 'badge' | 'basket' | 'tee' | 'bend' | 'droplet' | 'walk-vertex' | 'purple-mass'
  readonly n?: number                 // badge/hole number when known
  readonly xPx: number; readonly yPx: number   // IMAGE-LOCAL pixels, always
  readonly confidence: number
  readonly algo: string; readonly algoVersion: string; readonly paramsHash: string
}

// An ENTITY is the resolved real-world thing. Its composite coordinate is a
// DERIVATION, recomputed from (observations × current tile placements).
interface Entity {
  readonly kind: 'badge' | 'basket' | 'tee' | 'bend' | 'droplet'
  readonly n?: number
  readonly observations: Observation[]          // ≥1, possibly from several images
  readonly compositePoint: Point                // derived — see resolution
  readonly confidence: number                   // combined
}
```

Why this answers the hard questions:

- **"Basket 7 in image A and image B count once, at the correct final
  coordinate."** Detectors emit two observations (one per image, image-local).
  The RESOLVER — pure function `resolve(observations, placements) → Entity[]`
  — projects every observation through the current placements into composite
  space and merges observations that (a) agree on `kind` + `n` when numbered,
  or (b) land within a merge radius for unnumbered kinds. The entity's
  `compositePoint` is the confidence-weighted mean of the projected points.
  Two tiles, one basket, one label, one coordinate — by construction.
- **"How do we make sure work doesn't get redone?"** Observations are keyed by
  `(imageId, algo, algoVersion, paramsHash)`. A user nudging a tile changes
  PLACEMENTS, not images — so no detector re-runs; only `resolve()` re-derives
  (it's cheap, synchronous, pure). Re-running a detector with identical keys is
  a cache hit. Detection work survives crop decisions too: detectors run on the
  uncropped raster; crop is an inset applied at projection time.
- **Disagreement is signal**: if image A and B's badge-7 projections DON'T
  land within the merge radius, that distance is a direct measure of stitch
  error — surfaced as a GuidedReview flag (and it is exactly the "badge
  coincidence" cue the storyboard shows the user).

## The evidence store

One per session, owning all observations + the current resolution:

```ts
// lib/evidence.ts — plain TS, observable
interface EvidenceStore {
  ingest(obs: Observation[]): void              // detectors emit here, any time
  setPlacements(p: TilePlacement[]): void       // stitch/nudge writes here
  readonly entities: Entity[]                   // derived view, re-resolved on change
  subscribe(fn: (entities: Entity[]) => void): Unsubscribe
}
```

- Detectors emit the moment they finish — the store doesn't care whether
  stitching is done. Early results (purple mass, badges) land while the heavy
  stitch search is still running.
- Pages subscribe and render PROJECTIONS of `entities`. Whatever page is open
  shows whatever is resolved so far; a page mounting late just reads the
  current value. (Svelte side: one thin `$state` wrapper around subscribe.)
- The store is also the RunRecord's tap: every ingest and every resolution
  snapshot is traceable for the LAB.

## Scheduling — cheap first, heavy behind, everything cancellable

Priority ladder (each rung emits to the store as it lands):

1. **P0 classifiers (ms, main-thread ok)**: purple-mass scan per image →
   `pickThrownRound` fires before the user finishes reading the thumbnails.
2. **P1 sprites (fast, worker)**: badge detection per image — powers the
   pop-in and seeds everything downstream.
3. **P2 geometry (heavy, worker)**: stitch translation search; then basket/
   tee/bend detection per image; walk trace + droplets on the thrown round.
4. **P3 derived (cheap, sync)**: `resolve()`, shot derivation — recomputed on
   any ingest/placement change.

Runtime contract:

```ts
// lib/jobs.ts — worker pool
interface Job<I, O> { readonly stage: string; readonly key: JobKey; run(input: I): O }
schedule<I, O>(job: Job<I, O>, input: I, opts: { priority: 0|1|2; transfer?: ArrayBuffer[] }): Promise<O>
cancelSession(sessionId: string): void
```

- Stages are pure `(input, params) → output` — the SAME functions the LAB CLI
  calls directly in Node. The worker wrapper is transport, not logic.
- `GrayRaster.gray.buffer` moves via transferables (zero-copy). Rasterize each
  image ONCE; every detector shares that raster.
- New upload / clear-all cancels the session's queued jobs (stale results are
  also rejected at ingest by sessionId — same sequence-counter pattern as the
  page's image loading).
- Determinism rules (LAB): stages take explicit params objects, no
  Date/random, versioned by `algoVersion` — identical inputs ⇒ identical
  observations, byte-diffable.

## Caching

```
key = (imageId, algo, algoVersion, paramsHash)
```

- L1: in-memory Map for the session.
- L2 (later, optional): IndexedDB keyed the same, so re-uploading the same
  screenshot skips detection entirely (imageId is content-hashed, so the same
  file from anywhere hits).
- Stitch search caches by (imageIdA, imageIdB, insets, algoVersion).
- `resolve()` is never cached — it's cheap and depends on live placements.

## What the user sees vs what exists

| Layer | Audience | Rule |
|---|---|---|
| Observations, scores, params, timings | LAB / trace only | never rendered in product UI |
| Entities | user | the only things drawn on maps |
| Confidence | user, indirectly | ONLY as GuidedReview ordering + "confidence LOW —
  reason" flags on the item being reviewed; never numeric, never global |
| Disagreement (merge-radius misses) | user | as the visual cue itself (badges not
  coinciding) + a review flag; not as an error dialog |

Principle (matches the storyboard's confident-UI rule): the user is shown
**decisions to make**, not evidence to admire. Everything else flows to the
RunRecord where the LAB can second-guess at leisure.

## Slice impact

- S4 grows: `lib/evidence.ts` + `lib/jobs.ts` land with `badges.ts` (they're
  the substrate the P0/P1 passes need). Worker setup once, reused forever.
- S5 (RunRecord/LAB) taps the store instead of pages — simpler than the
  page-calls-record design in rebuild-spec.md §Cross-cutting; that section is
  superseded by this doc.
- Later detectors (S6, S8) are pure stages + an `ingest()` call each — no new
  orchestration.
