# Rail-projection fit — DRAFT (owner design, 2026-08-29, unsigned)

> Owner's words, verbatim: "Stop trying to fit the whole damn thing!! If you
> have a rail: project along it. The tee size is known at this point. Instead
> of fitting to the badge using a pure angle, we'll project the tee's known
> width. Error becomes a perpendicular distance, and it's MUCH more obvious
> if that projection is incorrectly fit to the pad."
>
> DRAFT status: awaiting the owner's red pen. Nothing below is binding until
> signed. Where this draft and the owner's intent disagree, the intent wins.

## What it replaces

The recovery pose fit today is a 3-degree-of-freedom search (center x,
center y, axis angle) trying to explain every shard pixel with a hollow
rectangle. Three receipted failure classes come straight from that freedom:

1. **Scan-boundary angles**: accepted recovery fits report axis errors of
   exactly 2.4999999999999973 deg — the edge of the search window, a
   constructed value, never a measurement (NorthPark receipt, 2026-08-28).
2. **The pizza slice**: the fitter gates on a 1.0 deg constrained fit and
   then persists the fragment's PCA (9.66 deg off) as the pose axis;
   recovered tees ship `angleRad: null` (DT12 detector-state dump,
   commit 91f4cd7).
3. **The promiscuous predicate**: with rotation free, one 50 px fragment
   satisfied the strict fit for three different badges simultaneously
   (Claims Ledger row 29).

## The design

- **The rail**: the line from the candidate evidence toward the badge — the
  direction the tee's axis must point per the signed Render-Stack Reading
  Contract (S2: the tee is the compass, the badge is what it points at).
- **Known size**: pad width and length are course-measured by this stage
  (medians of this course's visible pads, with printed provenance).
- **The fit**: lock the pad rectangle's axis TO the rail (zero angular
  freedom) and slide it along the rail — one degree of freedom. Project the
  known width perpendicular to the rail.
- **The error**: perpendicular distance of evidence pixels from the
  projected pad profile. A wrong placement shows up as perpendicular
  residual immediately; there is no rotation available to hide it.

## Why this kills the failure classes by construction

- No angle search → no scan-window artifact angles, nothing to persist
  wrongly; the axis IS the rail, always, and prints as such.
- A fragment tested against different badges sits on DIFFERENT rails; its
  perpendicular residual discriminates between them where free rotation let
  it satisfy all three.
- The error is a pixel distance — directly comparable across candidates,
  directly receiptable, and its tolerance derives from raster geometry (the
  existing ±1.25 px allowance class), not from a fitted degree constant.

## Open slots for the signing pass

1. Rail anchor and search window: how far along the rail from the badge the
   slide is allowed to run (must stay footgun-law compliant — no absolute
   pixel caps; windows derive from course geometry or are receipted UNKNOWN).
2. Occluder handling: unchanged in principle (named-occluder pixel classes
   still explain missing evidence; bare pixels still contradict) — confirm.
3. Relationship to teeBadgeCompass: compass locks visible tees first; rail
   fitting is the recovery-side counterpart for holes the compass leaves
   loudly unmatched. Confirm the composition order.
4. Acceptance: perpendicular-residual bands (accept / reject) derived per
   course, printed with provenance; every candidate's residual profile in
   the receipt, winners and losers alike.
