# Annotate Round correction log

**Status**: design only, nothing here is implemented. Written to unblock the
"semi-supervised" track of Annotate Round (auto-accept when confident, ask
the user when not, and treat every answer as reusable truth data) discussed
alongside `scripts/cv-probes/grayt-tuning-report.md`'s tuning work. That
report's headline limitation is N=2 labeled courses; this doc is the
mechanism for turning ordinary usage into more of them, without waiting on
a separate hand-labeling effort every time.

## What already exists (don't rebuild this)

Annotate Round (`src/routes/annotate-round/+page.svelte`) already has the
correction interactions this log needs to observe -- it just doesn't record
any of them today:

- **Frictionless-correction chip** ("PART C" in that file, ~L425-434,
  L1157-1214): clicking a detected tee/basket candidate opens a
  `CandidateAssignConfirm` chip with `replace | move | confirm` modes,
  anchored at the marker. A plain click accepts the CV proposal; a drag is
  "a deliberate location correction" (L1617-1620).
- **Drag-to-correct**: existing markers can be dragged; on release,
  `applyLocalSnap(...)` re-snaps to nearby detected geometry unless Alt is
  held (L1662-1663).
- **Confirmation tracking**: `activeReviewConfirmedCandidateIds` (L313)
  already records which CV candidates the user explicitly confirmed, it's
  just not persisted anywhere past the editing session.
- Per `docs/cv-clean-course-pipeline.md:129,156`, this is a deliberate
  architectural boundary, not an oversight: **CV confidence/provenance
  lives in Annotate Round review state only. After "Done," geometry in
  `AnnotatedHole`/`AnnotatedRound`/`project.json` is authoritative and
  carries no CV metadata** (the one exception, `numberBadges[]`, is kept as
  its own separate top-level array precisely because it's CV-only).

**Consequence for this design**: the correction log must not add fields to
`AnnotatedHole` or otherwise cross that boundary. It's a parallel record of
*what happened during review*, not a new property of the course.

## Event schema

One JSON object per correction-relevant interaction. `endpoint`/coordinate
shape deliberately mirrors `AnnotatedHole.tee?`/`.basket?` (`SourcePoint
{xPx,yPx}`) and `HoleNumberBadgeAnchor`'s existing `confidence: number`
convention (`src/lib/projectSchema.ts`) -- no new coordinate system, no new
confidence scale.

```ts
interface CorrectionEvent {
  schemaVersion: 1;
  eventId: string;               // uuid
  timestamp: string;             // ISO 8601
  appVersion: string;

  // Identity -- enough to reduce many events into one course's truth later,
  // nothing more. See "Identity and privacy" below before this ever leaves
  // the device.
  projectId: string;             // project.project.id
  imageId: string;
  imageSha256: string;           // denormalized from ImageAsset.sha256 --
                                  // event stays interpretable even if the
                                  // project is edited/renamed later

  holeNumber: number;
  endpoint: 'tee' | 'basket';

  // What the system proposed, if anything, and why it either did or didn't
  // auto-accept. This is the semi-supervised policy's own decision,
  // logged so it can be re-evaluated later against real outcomes instead
  // of re-guessed.
  priorProposal: {
    xPx: number;
    yPx: number;
    confidence: number;          // 0..1, source detector's own scale
    detector: 'grayt-stage2' | 'courseGrammar-hungarian' | 'tee-bootstrap'
            | 'number-badge' | 'none';
    gateDecision: 'auto-accepted' | 'flagged-for-review' | 'no-candidate';
    // free-text, only when gateDecision !== 'auto-accepted' -- e.g. the
    // courseGrammar failure kind ('ambiguous-basket', 'weak-tee-confidence',
    // 'missing-tee', ...) or 'below-gate-threshold' for GRayT's NCC gate.
    reason?: string;
  } | null;                      // null only for a hole the system never
                                  // proposed anything for at all

  userAction: 'confirm' | 'move' | 'replace' | 'place' | 'skip';
  // confirm: accepted priorProposal as-is (priorProposal must be non-null)
  // move:    dragged an accepted/placed marker to a new point
  // replace: rejected priorProposal, chose a different candidate the UI offered
  // place:   no priorProposal existed; user placed one from scratch
  // skip:    user explicitly declined to resolve this hole/endpoint --
  //          as valuable as a correction: tells the policy "don't force an
  //          answer here," and flags a hole worth investigating separately

  finalValue: { xPx: number; yPx: number } | null;  // null iff userAction === 'skip'

  // Weak, cheap precision proxies -- not authoritative, just enough to
  // downweight a rushed correction later if it turns out to matter.
  interactionMeta?: {
    zoomLevelAtInteraction?: number;
    dragDistancePx?: number;     // 0 for 'confirm'; large for 'replace'
  };
}
```

## Storage and lifecycle

**Local only, kept out of the shareable bundle.** Store as a new IndexedDB
object store alongside Course Memory (`src/lib/courseLibrary.ts:7-19`),
*not* as a new top-level array inside `project.json`/the `.chainspot.zip`
bundle. Two reasons, both from the research above:

1. It's CV provenance by definition (confidence, detector, gate reasoning)
   -- exactly the category `numberBadges[]` already keeps separate from
   pure geometry, and exactly what the "Done boundary" rule says shouldn't
   leak into the authoritative course file.
2. A `.chainspot.zip` is something a user hands to someone else. Raw
   correction telemetry (timestamps, drag distances, skip patterns)
   bloating every shared course file, or being shared without separate
   thought, is a worse default than keeping it local until there's an
   explicit reason to export it.

Lifecycle: append-only while a hole is open in Annotate Round. Never
mutated after write (a later correction to the same hole is a *new* event
referencing the same `holeNumber`, not an edit to the old one) -- this
keeps the log a faithful record of what actually happened, including
"user got it wrong twice before landing on the right answer," which is
itself useful signal about how hard a hole was.

## Export, revised: no sync needed for alpha

No backend/sync mechanism is needed to start -- alpha users can just send
whichever file gets asked for. So the only new surface is a plain **"export
corrections" action** in Annotate Round: serializes that session's
(or that project's) `CorrectionEvent[]` to a single JSON file the user
downloads/shares however they already share files. No auth, no upload
endpoint, no identity system -- just a file, on request, same as exporting
a `.chainspot.zip` today. This replaces the earlier "no export mechanism"
scoping-out below; it turned out to be the cheap part.

- **Identity**: still none needed. Since export is "send Sam the file,"
  not "sync to a shared corpus automatically," there's no de-duplication
  problem to solve yet -- a course's corrections are just whatever's in
  the file someone sent. A device ID only becomes worth adding if/when
  multiple alpha testers are correcting the *same* course and their
  files need reconciling; not needed for a first version.
- **Still out of scope**: anything automatic (background sync, opt-in
  telemetry upload, a shared server-side corpus). Those stay product/
  privacy decisions for later, not blocked on anything in this doc.

## Holeshape (corridor bends): deferred, and why specifically

Validate 18/18/18 (badge + tee + basket, all three, per hole) before
adding bend annotation, not just to sequence work but because bends have
**no confidence signal to gate on at all** -- there's no bend-shape
equivalent of GRayT's NCC gate or courseGrammar's confidence/failure
taxonomy validated this session. Adding bend annotation to the
semi-supervised UI now would mean 100% manual clicks with zero automation
credit, which actively muddies the "clicks the user didn't have to make"
metric this doc is trying to make legible (see below) by mixing in a
category that can never show a saving yet. Once endpoints are solid and
the correction log has real volume, bends become a natural second pass --
and the accumulated corridor-adjacent data (badge/tee/basket positions
across many real holes) might even be enough to attempt real bend
detection by then, rather than staying pure manual entry indefinitely.

## Three things to get right first

Per direction: tight focus on these three, ahead of anything else in this
doc.

### 1. Simple, clear user asks

The three-way split (confirm one / disambiguate between two / place from
scratch) from the gating-policy section above is the *mechanism*; this is
the *copy*. Each ask should be answerable in one glance and one tap, no CV
vocabulary exposed:

- **Confirm**: "Is this hole 6's tee?" + the marker shown on the image.
  One tap confirms, a drag corrects -- reuses the existing frictionless
  chip verbatim, just now logged.
- **Disambiguate**: "Which pin is hole 2's basket?" with exactly the two
  contested candidates shown, nothing else on screen competing for
  attention. Never more than two options -- if courseGrammar's candidate
  pool has more than one real contender beyond the top two, that's a
  `place`-from-scratch case instead, not a three-or-more-way picker.
- **Place**: "Tap hole 14's tee" with no candidate shown at all (per the
  isolated-badge pattern, showing a bad guess to reject is worse than
  admitting there isn't one) -- optionally centered/zoomed near the badge
  as a starting point, never a system-wide guess.

No hole should ever surface more than one of these at a time, and the
copy should never mention "confidence," "NCC," "gate," or any detector
name -- that vocabulary is for the next section, deliberately not this
one.

### 2. Clarifying the pipeline (internal only, for Sam -- not shipped)

A separate, internal-only view of exactly what the end-user copy above
hides: which detector produced (or failed to produce) each proposal, its
confidence, the gate decision and why, and -- once corrections exist --
whether the gate call turned out right in hindsight. This is the
`CorrectionEvent.priorProposal`/`gateDecision`/`reason` fields, rendered
plainly, per hole, per round.

This is the direct analogue of what `grayt_tune.py`'s diagnostic overlays
already do for the CV probes in this repo (main overlay = only what the
system would claim; diagnostic overlay = every candidate, gate-passed or
rejected, in context) -- same idea, pointed at real Annotate Round
sessions instead of the two labeled fixtures. Concretely, worth showing
per hole: `detector`, `confidence`, `gateDecision`, `reason`, and (once
available) `userAction` next to it, so a glance answers "was this gate
call right?" without re-deriving it from raw data. This is what makes the
gating thresholds in this doc (GRayT's 0.55, courseGrammar's failure
flags) something that gets *revisited against real outcomes* instead of
staying frozen at whatever the two-course LOOCV pass found -- not
shippable externally (raw detector names/scores are meaningless to an end
user), but exactly what's needed to know whether a threshold should move.

### 3. Quantifying "clicks the user didn't have to make"

Directly computable from the correction log, no new instrumentation
beyond what's already specified:

- **Per hole/endpoint**: 1 click saved if `gateDecision === 'auto-accepted'`
  and no `CorrectionEvent` exists for that hole/endpoint at all (never
  needed a second look), or a `confirm` with `dragDistancePx === 0`/absent
  (looked at it, it was already right). Not saved if `move`/`replace`
  followed an auto-accept -- that was a wrong auto-accept, not a saved
  click, and should count *against* the gate threshold, not for it.
- **Per round**: `clicksAvoided = autoAcceptedAndUnchanged / totalEndpoints`
  (out of up to 36 for 18 holes' tee+basket, before badges). Cheap,
  legible, and directly a validation-or-indictment of wherever the gate
  threshold currently sits -- a low number is itself a finding, not a bug
  in the metric.
- **Cumulative, across rounds/courses**: the same ratio over the whole
  correction-log history is the honest, ongoing answer to "is the
  automation actually saving anyone time," in a way that doesn't depend on
  re-running the LOOCV report by hand every time someone wants to know.

## Semi-supervised gating policy (the "when to ask" decision)

This is what actually sets `priorProposal.gateDecision`, using confidence
signals that already exist today, validated this session:

| Endpoint | Signal | Auto-accept | Flag for review |
|---|---|---|---|
| GRayT tee | NCC peak (`ray_template_fusion.py`) | >= 0.55 (LOOCV-validated zero-false-accept gate, see `grayt-tuning-report.md`) | < 0.55 |
| courseGrammar tee/basket | `.confidence`, failure kind | no `ambiguous-*`/`weak-*-confidence`/`missing-*` failure on that hole | any such failure present |
| Any endpoint | no candidate at all | never (nothing to accept) | always -- but see below, this is a `place` prompt not a `confirm` prompt |

Three UI treatments, not one, matching the failure patterns actually found
in this session's vision pass (`docs/deferred-detection-experiments.md`'s
GRayT section) rather than a generic "low confidence, please review":

- **Confirm/reject one candidate** -- flagged-for-review with exactly one
  plausible candidate (e.g. TowneLake-a hole 2/13: flagged, but
  unambiguously correct on inspection). Show it, let a tap confirm or a
  drag correct.
- **Disambiguate between candidates** -- specifically the *contested pin*
  pattern (TowneLake-b hole 2: a real basket stolen by a neighboring hole
  because that hole's own tee-bootstrap failed first). When courseGrammar's
  own runner-up cost is close to the winner's, or a `replace` interaction
  is available with a nearby second candidate, offer both rather than one.
- **Free placement, no candidate shown** -- the *isolated badge* pattern
  (NorthPark holes 6/14: badge sits 300-400px from any real candidate,
  nothing plausible to suggest). Don't force a confirm/reject on a bad
  guess; ask for a placement directly, optionally anchored near the badge
  as a starting hint.

Getting this three-way split right matters for the correction log's value,
not just UX: a `confirm` on a strong single candidate and a `place` with no
prior are very different signals about how hard a hole was, and collapsing
them into one generic "was this right?" prompt would throw that away.

## Path back to reusable truth data

The whole point: reduce a course's accumulated `CorrectionEvent`s into
exactly the shape `scripts/cv-probes/grayt_common.load_truth()` already
consumes, zero translation needed --

```python
# per hole: take the latest finalValue per endpoint (or, once multiple
# devices' corrections exist for the same imageSha256, a median/majority
# vote across them for extra robustness against one rushed correction)
{"tee": {"xPx": ..., "yPx": ...}, "basket": {"xPx": ..., "yPx": ...}}
```

which is precisely `project.json`'s own `holes[].tee`/`.basket` shape.
Once real correction volume exists, this is what would let
`grayt-tuning-report.md`'s LOOCV protocol move past N=2 -- and, per that
report's own retracted HeritagePark finding and the gate-threshold
overfitting finding, more real courses is the one thing that would
actually resolve most of that report's open "indicative, not proof"
caveats.
