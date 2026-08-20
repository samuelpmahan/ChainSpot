# Course Memory: recognizing a previously-annotated course

Courses rarely change layout. A user replays the same physical course
repeatedly, but until this feature every new round upload started hole
annotation from scratch — the app had no way to tell "this UDisc screenshot
is the same course I already taught it" from "this is a brand-new course."

## The labeled-point insight

CV-detected hole-number badges already carry a **resolved hole number** (OCR
plus Hungarian assignment in `autoAnnotation/courseGrammar.ts`), and basket
ownership resolves to the same numbers. Two badge/basket point sets from two
different screenshots of the same course therefore have a *known*
correspondence — H1 -> H1, H2 -> H2, ... — rather than requiring blind
point-cloud registration. That sidesteps the usual hard part of "does this
shape match that shape" entirely: it reduces to feeding `(holeNumber, kind)`-
keyed pairs straight into the existing `alignment/` transform-fitting module,
the same machinery already used for source-image-to-basemap alignment in
Create Graphics.

## Two independent matching paths

`courseSignature.ts` exposes two ways to compare two badge/basket point sets:

- **`computeSignatureDescriptor` + `hashSignatureDescriptor`** — a coarse
  pre-filter hash. Translate to centroid, scale-normalize by RMS spread,
  rotate so the *smallest present hole number* lands on the positive x-axis
  (deterministic and unambiguous, since every point already carries a
  resolved hole number — no PCA sign-flip ambiguity to resolve), quantize,
  hash via the existing `sha256Hex`/`HashBytes` convention (native
  `crypto.subtle` only, no hashing package). This hash is **not** expected to
  match across two different screenshot sessions of the same course in
  general: a different crop changes which hole number is "smallest present,"
  which changes the rotation reference and therefore the hash even for a
  geometrically identical course. It exists purely to short-circuit the cheap
  case (re-detecting on the same or a near-identical image) before paying for
  a fuzzy scan, and as `upsertCourse`'s exact-match dedup key.

- **`matchSignatures`** — the primary, expected-to-fire path for the real
  product scenario: same course, a different round, a differently
  cropped/zoomed screenshot. Fits a similarity transform (falling back to
  affine on a large enough overlap) from one point set to the other, using
  `(holeNumber, kind)` as the correspondence key, then scores the residual
  against the target's own geometric spread. The `alignment/` module fits an
  ordinary least-squares transform over every supplied pair with no outlier
  rejection by design, so `courseSignature.ts` layers its own drop-and-refit
  pruning loop on top rather than modifying that module's tested contract.

Every numeric threshold (`MIN_SIGNATURE_HOLES`, `MIN_OVERLAP_HOLES`,
`MIN_OVERLAP_FRACTION`, `CONFIDENT_MATCH_NORMALIZED_RMS`,
`OUTLIER_PRUNE_MAX_ITERATIONS`, `AFFINE_FALLBACK_MIN_OVERLAP`, ...) is a
principled starting point picked from first principles, not a value
validated against real repeated-course fixtures. Treat them as mechanism, not
settled architecture — tuning against real data (once available) is a
follow-up, not a blocker to shipping the pipeline.

## Why badges live outside AnnotatedHole

`domain/annotatedRound.ts`'s header states the Done-boundary purity rule
verbatim: once an `AnnotatedRound` exists, every feature on it is simply
authoritative — no `source: 'cv'|'manual'`, no confidence score, no
provisional flag may ever appear. Badge anchors carry a detector confidence
and are signature-quality input, not round annotation, so they live as a
sibling `ProjectState.numberBadges` field (schema v4), never inside
`AnnotatedHole`.

That created a second wrinkle: Annotate Course's/Map Round's `holes` is
page-local `$state` (both share `AnnotationWorkspace.svelte`), not owned by a
`ProjectEditor` — only Create Graphics's `importAnnotatedRound()` writes to a
`ProjectEditor`, on a *separate* editor instance from either annotation
route's. So capturing badges in the annotation route alone isn't enough to
make them durable. `session.ts`'s pending course-badges slot is a minimal
sibling to its existing AnnotatedRound pending/active slot pattern, carrying
exactly the badge/basket payload the Done-boundary rule forbids attaching to
`AnnotatedRound` across the same `/annotate-course` or `/map-round` ->
`/create-graphics` navigation. Create Graphics's `importAnnotatedRound`
consumes it into durable `ProjectState.numberBadges` right alongside
`editor.setHoles(round.holes)`.

## The course library: a course, not a round

`courseLibrary.ts`'s `CourseLibraryEntry` is ChainSpot's first persistent
concept of *a course*, independent of any one round or project file.
Recognition is just its first consumer. It's stored via a narrow injectable
`CourseLibraryStore` (get all / put / delete over one IndexedDB object store,
no index) rather than the raw IndexedDB API directly, matching this
codebase's existing convention of injecting a narrow functional boundary
(`HashBytes`, `DecodeImageFile`) instead of a browser API. `persistence.ts`'s
own header comment explicitly scopes IndexedDB out as "not yet built" rather
than forbidden — this module fills exactly that gap and only that gap: no
cross-device sync, no eviction/quota policy (both flagged as known future
gaps), no generic ORM or query builder (a personal library is realistically
dozens of entries, so `getAll()` plus client-side filtering is enough).

`upsertCourse` dedups against the closest existing entry (exact hash falling
back to fuzzy match) rather than inserting a near-duplicate row on every
re-save of the same physical course.

**Scoping decision: no `shots` on a `CourseLibraryHole`.** Shots are one
round's ball landings, not course geometry. Pre-filling a brand-new round
with a previous round's throws would misrepresent that round rather than
help annotate it — the same "never silently corrupt data" principle behind
requiring an explicit confirm/dismiss banner (see below) rather than a silent
auto-import. Only `tee`/`basket`/`corridorBends`/`corridorWidthPx` carry
forward.

## Recognition is always explicit

A confident library match never auto-imports. `applyLibraryEntry` is only
ever reachable from Annotate Course's or Map Round's explicit "Import saved
holes" button click (both routes share the same recognition wiring in
`AnnotationWorkspace.svelte`) — the recognized-course state (`recognizedMatch`)
only ever renders a
confirm/dismiss banner, mirroring the existing Stitch Map handoff banner
pattern. A wrong auto-import onto the wrong course would silently corrupt
tee/basket placement; recognition is probabilistic, but authoritative
annotations never are.

## Future headroom

`CourseLibraryEntry` existing as a course concept independent of any
round/project is deliberately not maximized by this first slice. It's a
natural home for later, currently-unbuilt additions: saved/editable course
names, multiple source-image registrations per course (different UDisc
zoom levels or device orientations), progressively improving geometry as
more rounds get annotated, or per-hole CV hints seeded from a known course.
None of that is built here — the abstraction just doesn't trap the option.
