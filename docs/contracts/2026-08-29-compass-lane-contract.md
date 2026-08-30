# Compass-lane contract (2026-08-29)

Binding for the compass lane build (glyph-fit axis at G3, ray-first
teeBadgeLock at G4). Extends, never overrides, the signed
2026-08-28 render-stack reading contract. Every clause below is judged by
the Opus reviewer against the diff and the receipts, not against intent.

## Why this lane exists (one plain sentence each)

- A tee pad points at its own hole number, so the pad's direction is the
  best clue for which badge it serves — but today we throw the good
  direction away and keep a bad one.
- DT12's conviction: the fit that GATED acceptance was 1.0 degrees off the
  badge bearing, but what got PERSISTED was raw fragment PCA at 9.66
  degrees off. What gates must be what persists.
- The 12-degree orientation sigma constant was convicted (real compass
  median 1.1 degrees, p90 2.65): one imported number cannot describe every
  photo, so each photo estimates its own.

## Clauses

**CL-1 — What gates is what persists.** When a constrained glyph-model fit
is accepted for a tee (visible or recovered), the persisted axis IS that
fit's axis. Raw fragment PCA may be recorded as evidence but never as the
tee's angle.

**CL-2 — No null angle when a fit exists.** A recovered tee whose accepting
fit produced an axis persists it (with its quality tag). `angleRad: null`
is only for tees where no fit was ever accepted — and then the receipt says
so as a loud UNKNOWN, not a silent null.

**CL-3 — Occluders excuse, never convict.** Fit residuals are computed
over visible pixels only; pixels under known stack members (badges,
baskets, C2 chrome) are excused from the fit, per the world model (only
stack members occlude). A pad may not be penalized for pixels something
else is standing on. The excused mask is drawable evidence.

**CL-3a — "Visible" is defined, then best rail wins (owner directives
2026-08-29).** Two parts:

(1) DEFINITION: a pixel under a known stack member (badge, basket, C2
chrome) is NOT VISIBLE. Full stop. "Explains every visible pixel" was
always the right rule; the defect is any code that counts covered pixels
as visible. Recovery's visibility mask subtracts stack-member footprints
before any fit is judged.

(2) MECHANISM for occluded/partial pads: extract the candidate straight
edge segments (rails) the fragment offers, rank by quality (length,
straightness, least interruption), take the BEST, LEAST-OCCLUDED rail, and
run the existing rail projection from it — every occluded pad still shows
at least one clean edge, and the clean edge is by definition where nothing
stands. Visible pixels must never CONTRADICT teepad; the receipt names the
chosen rail, its quality ranking, and the stack members subtracted from
visibility. Convicted motivating case: AlexClark H10 (pad component alive,
considered, rejected with 60-88 "unexplained" pixels that were largely
under a basket sprite — i.e. never visible; the rail path never fired
because the whole component is not a thin band).

**CL-4 — Per-image sigma, no imported constants.** The orientation sigma
used anywhere downstream is estimated per image from that image's own
good-quality fits. `teeOrientationSigmaDeg = 12` (g4.teeBadgeLockMath.ts
line 379 region) dies. Too few good fits to estimate → the receipt prints
a loud UNKNOWN and the consumer uses the stated conservative fallback
(named in the receipt), never a silent constant.

**CL-5 — Center uncertainty propagates.** Bearing uncertainty includes the
lateral-shift term: atan(centerShiftPx / badgeDistancePx) — a small
center error tilts the ray more when the badge is close (owner-verified:
~1.6 degrees of DT12's 9.66 came from a 3.9 px shift). Short-badge-distance
tees get honestly wider tolerance, not false precision.

**CL-6a — Ray first for tee→badge.** teeBadgeLock candidate selection and
ranking are driven by the pad axis ray (with CL-4 sigma and CL-5
uncertainty). Route factors demote to corroboration and tie-breaking. The
all-Hn resolver shell (lock / named orphan / named conflict, multiclaim,
abstention) is preserved unchanged.

**CL-6b — Follow the path for badge→basket (owner directive 2026-08-29:
"trace, don't shop" made structural).** Once a badge is claimed by a tee,
the basket is DISCOVERED by following the painted hole path onward from
the badge — away from the tee side — through the support field's testimony
until the path terminates; the object it terminates at is the claimed
basket. The known-basket assumption dies inside this feature: no
enumerating candidate baskets and grading pre-drawn connections between
assumed endpoints. A path that cannot be followed to a credible
terminus is a loud UNKNOWN carrying its partial trace as drawable
evidence — never a proximity-shaped guess (proximity-as-matchmaker stays
banned). One plain sentence per claim: "followed the path from badge N for
X px; it ends at this basket."

**CL-7 — Default-path changes are measured, not smuggled.** teeBadgeLock is
default-OFF; its scoring rewrite ships freely behind its config. Any change
that touches DEFAULT-ON behavior (G3 axis persistence per CL-1/CL-2, the
default scoring teeOrientation factor) lands with a before/after Dev6 sweep
comparison pasted in the lane report: per-course assignment deltas, named.
No default knob value changes silently; DEFAULT_SCORING_KNOBS.teeOrientationSigma
is not retuned in this lane — its per-image replacement applies where the
lane's features consume it, and full default-path adoption is a separate,
owner-gated step.

**CL-8 — Acceptance case: DT12.** After the lane, DashsTrack tee-12's
persisted axis agrees with its own gating fit (about 1 degree from the
badge bearing, not 9.66), and its receipt shows the excused-occluder mask
over the two occluded corners. This is acceptance evidence, not a fitted
target: no threshold may be tuned to DT12 specifically.

**CL-9 — Plain words and winner audits.** Every new formula carries a
one-plain-sentence comment a disc golfer could accept. Winning locks print
their audit (ray error, sigma used and its provenance, uncertainty term,
corroboration factors) in the receipt.

## Interface between the two build lanes (fixed before building)

G3 lane publishes on the board / evidence types; G4 lane consumes and may
not recompute:

- per-tee: `axisRad` (the gating fit's axis, CL-1), `axisQuality`
  ('good' | 'occluded-partial' | 'poor' | 'none'), `axisSource`
  ('constrained-fit' | 'component-pca-evidence-only'), excused-pixel mask
  reference, `centerUncertaintyPx`.
- per-image: `orientationSigmaDeg` + `sigmaProvenance`
  ({ goodFitCount, method } or UNKNOWN + fallback name).

Shape changes require amending this contract, not improvising a side
channel.
