# ChainSpot rebuild — contracts & data flow

Derived from the behavior storyboard
(https://claude.ai/code/artifact/e2b21087-fd71-4f82-af76-076af5b38303).
The storyboard is the UX contract; this document is the code contract.

## The one-sentence architecture

Each page consumes a typed artifact produced by the previous page, enriches it
through (CV proposal → user confirmation), and hands a new typed artifact
forward; every CV/geometry module is pure TS over `GrayRaster`/plain data in
`src/lib`, provable headless; Svelte components only render state and report
user decisions; the RunRecord observes every confirmed decision silently for
the LAB.

```
File[] ──page 1──▶ CourseBlank ──page 2──▶ CourseMap ──page 3──▶ MappedRound ──page 4──▶ pixels/PNG
                        ▲                      ▲                      ▲
                 (crop+stitch+badges)   (holes+transform)      (walk+droplets)
```

## Shared kernel (exists or trivial)

| Module | Status | Contract |
|---|---|---|
| `lib/image.ts` | done | `loadImageFromFile`, `releaseImage`, `LoadedImage` |
| `lib/raster.ts` | done | `rasterFromFile`, `cropRaster`, `croppedObjectUrl`, `GrayRaster`, `CropInsets` |
| `lib/autoCrop.ts` | done | `proposeSharedCrop(rasters) → CropInsets \| null` |
| `lib/stitch.ts` | done | `findBestTranslation(a, b) → {dx, dy, score} \| null` |
| `ImageViewport.svelte` | needs slot | layers + pan/zoom + drag; ADD: overlay snippet (children) so pages pin controls top-right INSIDE the viewport; ADD: optional transition on layer transform (off during drag/nudge) |
| `lib/runRecord.ts` | to build | append-only event log of confirmed decisions; sha256 of inputs (Web Crypto); serializable JSON for the LAB. Not UI. |

Coordinate law (from the old app, re-earned in the storyboard when the badges
missed): **original image pixels are authoritative; display scale is applied
exactly once at render.** Every contract below speaks image-px unless named
otherwise.

## Page 1 — Stitch Map

UX (locked by storyboard): one upload → CV picks the thrown round → survivors
fly from their thumbnail spots (FLIP) → badges pop in colored → tiles settle at
the stitch offset → shared badges coincide through translucency → controls
top-right: Approve layout / Adjust stitch / Re-Select Thrown Round; crop is
pre-applied, "Adjust crop" tucked inside Adjust.

New lib contracts:

```ts
// lib/badges.ts — hole-number badge sprite detection (near-instant pass)
interface Badge { readonly n: number; readonly xPx: number; readonly yPx: number; readonly confidence: number }
detectBadges(raster: GrayRaster): Badge[]

// thrown round = the image whose badge set spans the full round (1..N) and/or
// carries the walk trace; heuristic v1: max distinct badge count wins
pickThrownRound(perImage: Badge[][]): number  // index

// lib/composite.ts — page-1 output artifact
interface TilePlacement { readonly xPx: number; readonly yPx: number }   // composite space
interface CourseBlank {
  readonly tiles: LoadedImage[]            // cropped display copies
  readonly placements: TilePlacement[]
  readonly insets: CropInsets | null       // what was removed (replayability)
  readonly badges: Badge[]                 // deduped, in COMPOSITE coordinates
  readonly thrownRound: LoadedImage        // uncropped original
}
```

Svelte work: FLIP row→viewport (`svelte/animate` flip + crossfade, keyed by
objectUrl — keys already correct); badge overlay markers with scale-in
transition; viewport overlay slot for the three buttons; existing
keyboard/drag adjust retained.

Proof: unit — synthetic rasters with painted badge glyphs round-trip through
detectBadges; known-offset pair recovered; composite badge dedup (shared badge
appears once, at the coincident point). Manual — real 2-tile UDisc captures
through the full choreography; badge coincidence visible.

## DECIDED 2026-08-21 — Import Data page + fair-use pixel discard

- Stitch Map and Annotate Course are ONE page ("Import Data"): a single
  fullscreen viewport whose phases are upload → select round → crop+stitch →
  annotate (GuidedReview) → pairs; it slides into a two-pane (blank |
  satellite) layout when annotation is confirmed.
- **Fair use rule:** the moment annotation is done, every UDisc-derived pixel
  is discarded — object URLs revoked, rasters dropped, detections' source
  images gone. Only vector data (CourseMap, MappedRound), the satellite
  imagery, and our own clean-course rendering survive. Consequence: any
  pixel-consuming extraction (walk trace, droplets from the thrown round)
  must run DURING import, before the discard point.
- Annotation algorithm plugs in Detector-shaped (per-image emissions +
  associations; placements-independent). No automatic re-runs when the user
  adjusts placements — instead targeted on-demand luxuries, each per-hole and
  user-invoked: bend detection on fix, snap-to-best-point (with an easy
  toggle off).
- Annotation carries no confidence values; detection is expected accurate and
  GuidedReview is the backup.
- Satellite source: geocode (course search) → US federal imagery (NAIP), with
  known raster bounds — correspondence pairs therefore get lat/lng from the
  imagery itself. Old-stuff's geocode/naip chain is the reference for
  rederivation.

## Page 2 — Annotate Course

UX (locked): opens with detection already run on the blank; GuidedReview
overlay walks holes 1..N (Accept / Re-place, confidence note per anchor, gold
ring on current); two panes in ONE viewport (blank | satellite), zero scroll;
pairs drop matched markers on both panes; at 2+ pairs the satellite pane
becomes the clean course — layout transferred in OUR icon set (triangle tee,
ring basket, dot bend, square chip).

New lib contracts:

```ts
// lib/courseDetect.ts — anchors per hole, seeded by page-1 badges
interface HoleProposal {
  readonly n: number
  readonly tee: Point | null; readonly basket: Point | null; readonly bends: Point[]
  readonly confidence: { tee: number; basket: number; bends: number }
}
detectCourse(blankRaster: GrayRaster, badges: Badge[]): HoleProposal[]

// lib/guidedReview.ts — PORT of old-stuff activeReview.ts (pure state machine)
// queue ordering, next-anchor recommendation, rejection memory
createReview(proposals: HoleProposal[]): ReviewState
accept(state, holeN): ReviewState
replace(state, holeN, anchor: 'tee'|'basket'|'bend', p: Point): ReviewState

// lib/geo.ts — correspondence + world transform
interface CorrespondencePair { readonly blankPx: Point; readonly latLng: LatLng }
fitTransform(pairs: CorrespondencePair[]): WorldTransform | null  // similarity fit, ≥2 pairs
toLatLng(t: WorldTransform, p: Point): LatLng
distanceFt(t: WorldTransform, a: Point, b: Point): number

// page-2 output artifact
interface CourseMap { readonly holes: Hole[]; readonly transform: WorldTransform; readonly blank: CourseBlank }
```

Open decision (user call, before slice starts): satellite source for MVP —
user-uploaded satellite screenshot (cheapest, keeps browser-only), vs
restoring an aerial provider integration. Storyboard is agnostic.

Proof: unit — guidedReview transitions (accept/replace/queue order, stale
rejection memory) ported against old tests' scenarios; fitTransform recovers a
known similarity transform from synthetic pairs; distanceFt against hand-
computed values. Manual — flawed-detection script (bad tee, bad bend) walks
correctly; clean-map transfer renders.

## Page 3 — Map Round

UX (locked): same two-pane workspace; blank fades out, thrown round fades in;
corresponding baskets light up staggered (badge colors); WalkLine pastes on —
thin, dashed, UNDER the markings; LandingDroplets (detected sprites, present
in the UDisc image) rain onto the clean course; confirm overlay.

New lib contracts:

```ts
// lib/roundDetect.ts — landmarks from the thrown-round screenshot
detectWalkTrace(raster: GrayRaster): Point[]         // ordered polyline (purple trace)
detectDroplets(raster: GrayRaster): Point[]          // blue pin sprites
// registration: badge/basket correspondence round-image → blank composite
fitRoundToBlank(roundBadges: Badge[], blankBadges: Badge[]): Transform2D

// page-3 output artifact
interface Shot { readonly from: Point; readonly to: Point }              // blank px
interface MappedRound { readonly walk: Point[]; readonly droplets: Point[]; readonly shots: Shot[][] /* per hole */ }
```

Shot derivation is pure geometry: split walk + droplets by hole (nearest
basket/tee), order droplets along the walk, pair consecutive lies into shots.

Proof: unit — synthetic trace/droplet rasters; shot derivation from a scripted
walk. Manual — the real capture (tests/fixtures candidate: the user's "The
REC" screenshot) projected onto its course.

## Page 4 — Create Graphics

UX (locked): three-plus views of the SAME data through view transforms — full
round, hole closeup (neighbors visible, blurred/faded — a crop, not a
diagram), single shot with shape selector (BH/FH × Hyzer/S-Line; hyzer bows
away from throw side, S-line crosses).

Contracts — no new detection, all pure rendering:

```ts
// lib/graphics.ts
interface ViewSpec { readonly kind: 'round' | 'hole' | 'shot'; readonly holeN?: number; readonly shotIdx?: number }
interface ShotShape { readonly hand: 'BH' | 'FH'; readonly shape: 'hyzer' | 'sline' }  // per-shot, user-set
flightPath(from: Point, to: Point, shape: ShotShape): Point[]   // v1 bezier; frispy later, SAME signature
```

Rendering = ImageViewport again: clean-course layer + round layers + view
presets driving zoom/pan. Neighbor de-emphasis is styling on the one scene.

Proof: mostly visual/manual; flightPath symmetry unit-testable (mirroring
hand flips the curve).

## Cross-cutting

- **RunRecord**: page components call `record.decision(...)` at each confirm
  (round pick, crop, layout approve, each accept/replace, pairs, projection
  confirm). LAB replays: same inputs + record ⇒ same artifacts, diffable.
- **Session survival**: artifacts (CourseBlank/CourseMap/MappedRound) live in
  an in-memory session module keyed per page (old session.ts pattern);
  reload loses them (acceptable now, zip persistence later).
- **Dev seeding**: "jump to stage N" — fixture screenshots + canned decisions
  replayed through the same code paths (the storyboard's tester buttons, for
  real).

## Slice sequencing (each = contract commit → impl → proof)

Referred to by NAME, not number:

1. **Manual stitch baseline** (in flight): page-1 manual flow (upload → crop →
   stitch → adjust → approve) verified & committed.
2. **Badge detection & choreography**: `badges.ts` + evidence store + worker
   pool (`evidence.ts`, `jobs.ts` — see cv-orchestration.md) + auto
   thrown-round pick + page-1 polish (FLIP fly-in, badge pop, viewport overlay
   controls). Storyboard stage 1–2 parity.
3. **LAB replay harness**: `runRecord.ts` tapping the evidence store + CLI
   (`node scripts/replay.ts`) that reruns algorithms on recorded inputs and
   diffs.
4. **Guided course review**: `courseDetect.ts` (badge-seeded, minimal) +
   `guidedReview.ts` (port of old activeReview) + two-pane annotate UI.
5. **World transform**: `geo.ts` + correspondence-pair UI + clean-map render
   (our icon set).
6. **Round projection**: `roundDetect.ts` (walk trace + droplet sprites) +
   registration + map-round choreography.
7. **Graphics views**: `graphics.ts` view transforms + per-shot shapes
   (frispy spike behind the `flightPath` signature).

Division of labor per the coaching arrangement: Claude writes lib modules and
docs; the user writes Svelte components/pages, coached, with COACH notes
in-file.
