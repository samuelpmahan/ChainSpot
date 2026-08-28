# The Render-Stack Reading Contract — DRAFT for owner red pen

Status: SIGNED by owner 2026-08-28 (red pen applied: S2 tee-aims-at-badge directionality; S7 demoted to awareness-tier distractor). BINDING. Supersedes, on signing:
the proximity prune (already convicted), the contrapositive gate's literal
thresholds, the axis gate's fixed 3°, the "18 holes" and "badges at tees"
lore, and every constant called out in §N below.

Motivation (one paragraph, receipts in docs/CLAIMS-LEDGER.md and the
2026-08-28 orchestration reports): the pipeline repeatedly failed by
importing assumptions the world never made — distance-minimization on a
sport that maximizes distance variety, bell-curve statistics on data
designed to have no bell, constants measured once at one zoom under one
app version. DashsTrack H2's top-scored pairing was another hole's basket
because scoring ignored the one segment the renderer guarantees. The fix
is not smarter tuning; it is reading the screen the way it was drawn.

Acceptance cases: DashsTrack H1 and H2. The shipped receipt for each must
read as one human sentence (see C5). If a trivial hole's receipt cannot be
written in one sentence, the machinery is wrong regardless of scores.

---

## W — The world law

Everything read is one render stack drawn over a satellite photo: pads,
badges, baskets, hole-path ribbons, C1S/C1F/C2D/C2F, BTD dashes, screen
chrome — all of it synthetic UI, composited in some z-order, over a photo
that is never itself course furniture. Nothing in the photo (trees, roofs,
shadows) can occlude UI; only stack members occlude stack members.

## The governing split — STRUCTURE IS LAW, NUMBERS ARE ESTIMATES

- Structural invariants (S-laws below) are QUALITATIVE: ordering, aiming,
  interiority, hollowness, termination, membership. They express what the
  UI means and survive app updates, zoom changes, and representation
  drift. A measurement-verified real violation of an S-law is a
  stop-the-world event (ratchet: the world model is wrong).
- Every NUMBER — glyph sizes, interior ratios, alphas, colors, angular
  tolerances, interior margins, widths — is estimated PER IMAGE from the
  objects confidently read in that same image, printed with provenance,
  and applied to the uncertain objects. No imported constants. Prior
  measurements (badge fraction 0.17–0.54 n=72; pad interior ~2:1; ribbon
  alpha 0.61–0.90 ≈[150,155,145]; compass median 1.1° max 11.3°) are
  ILLUSTRATIONS that the structure holds and sanity anchors for the
  estimators — never gates, never fence posts. The representation beneath
  us may slip; the estimators must move with it.

## S — Structural invariants (plain English above each formula)

-- Every hole has exactly one pad, painted; hole count comes from the
-- badges actually read on this course, never a literal 18.
S1  ∀h ∈ Holes(course): ∃! pad(h)      where Holes = labels read by G1

-- The TEE aims at the badge: a tee pad is a hollow glyph whose long
-- axis aims at its own hole's badge. The relation is directional — the
-- tee is the compass, the badge is what it points at.
S2  Hollow(tee(h)) ∧ Aims(axis(tee(h)), badge(h))

-- The badge lies strictly interior on the tee→basket chord — away from
-- both ends — and always before any bend in the path.
S3  Interior(proj(badge(h), chord(tee(h), basket(h)))) ∧ BeforeBends(badge(h))

-- The path leaves the tee (its cap sits behind the pad) and terminates
-- at the basket; bends occur only after the badge.
S4  Starts(path(h), pad(h)) ∧ Ends(path(h), basket(h))

-- Only render-stack members occlude; z-order is per-course, observed.
S5  Occludes(x, y) → x ∈ Stack

-- No contradiction: every pixel of a claimed pad's outline is pad paint,
-- or covered by a stack member, or the composite of pad paint under a
-- translucent stack member. A pixel that is confidently none of these
-- refutes the claim. Dimness alone never contradicts (compositing).
S6  Claim(f, h) → ∀q ∈ Outline(pose(f)):
        PadPaint(q) ∨ (∃m ∈ Stack: Covers(m, q)) ∨ Composite(pad, m, q)

-- BTD dashes exist and chain basket(n) → tee(n+1). They are LARGELY
-- USELESS as evidence — recorded here for completeness and so every
-- reader knows they occasionally act as a DISTRACTOR (dash rides pulling
-- routes toward adjacent holes). Awareness tier: never evidence.
S7  BTD(n) connects basket(n) to tee(n+1)     [awareness tier: distractor]

-- WITHIN-IMAGE UNIFORMITY (the owner's canonical example of the whole
-- contract): one photo = one renderer configuration. Within a single
-- photo, every instance of a glyph class is drawn identically — all
-- hole-path ribbons share the same width W, all pads the same size, all
-- basket sprites the same (byte-stable) template, all badge plates the
-- same geometry. The VALUE of W (and every class parameter) varies photo
-- to photo and is never imported. Uniformity cuts both ways: measure the
-- class parameter once per image from its clearest instances, apply it
-- everywhere — and a candidate that deviates from its class value is
-- thereby evidence AGAINST membership (or FOR occlusion), which is a
-- detection signal, not noise.
S8  ∀ class g ∈ Stack, ∀ instances a,b of g in one photo: params(a) = params(b)
    params(g) varies photo to photo — always measured, never imported

## N — The numbers policy

N1  Every estimator publishes: the value, the confident-read set it was
    derived from, and the spread. Estimators exploit S8: one measurement
    per glyph class per image, from the clearest instances, applied to
    all — a tight spread is uniformity confirmed; a wide spread is a
    loud receipt warning that the image may mix configurations (stitch,
    zoom seam) and must be re-estimated per region. A receipt line without provenance is a
    contract violation.
N2  Per-zoom and per-course always. Multi-source stitches estimate per
    source region.
N3  Degenerate calibration sets (too few confident reads) degrade to
    wider tolerances with a loud receipt statement — never to imported
    constants.

## C — Pipeline clauses

C1  Read the stack chrome first: badges (with digits), baskets, rings,
    ribbons, screen chrome. These confident reads ARE the calibration set
    for everything after (self-calibration).
C2  Pad candidates: hollow-glyph fit using per-image calibrated geometry;
    S6 no-contradiction (composite-aware); S2 aim at the claimed badge.
    Acceptance is per (fragment, hole) pair — the proof travels with the
    pad (binding retained).
C3  Pair feasibility precedes scoring: a (tee, badge, basket) triple
    exists as a candidate only if S3 holds under this image's estimated
    interior margin. Infeasible pairs are never generated, and the
    receipt says how many were excluded and why. (DashsTrack H2's
    tee-1→basket-2 must die here.)
C4  Association is TRACE, DON'T SHOP: from each pad, leave along the
    axis, follow the ribbon paint through its bends, terminate at the
    cap/basket. The pairing is read off the paint. The global solver's
    only job is ties, abstentions, and conflicts — fill-first (no hole
    left empty while a feasible candidate exists), score second.
    Euclidean distance appears NOWHERE as evidence: geometry is used as
    protractor and projector, never as matchmaker.
C5  Receipts: one human sentence per assigned hole ("H1: pad at X, axis
    at badge 1 within [est]°, ribbon continuous to basket 1, cap
    verified"); every excluded pair, dropped candidate, and abstention
    named with its rule and measured values; winners print their audits
    (no survivor exemption); every estimator prints per N1.
C6  Acceptance: DT H1/H2 receipts read per C5; Dev6 scoreboard
    non-regressing vs the 2026-08-28 baseline; Lenard truth exact-count
    non-decreasing; all existing conformance/receipt tests green.

## Ratchet interface

The ratchet guards S-laws: a measurement-verified real violation is a
stop-the-world world-model event, entered in docs/RATCHETS.md with pixels.
Numeric extremes feed estimator sanity anchors only. Outstanding Step-0
verifications: the 11.3° compass outlier (owner on record predicting
shitty rectangle fit); the Heritage H17 ratio; axis 2.5° extreme.

## Deferred (tracked, not blocking)

Zoom-level recalibration captures; >18-hole and alphanumeric labels;
C1S/C2D metersPerPixel ruler; BTD attribution as ordering corroboration;
receipt verbosity levels.

## Team topology (delegate skill governs)

OSS triangle. Lane A (Sonnet): C1+C2 — stack reading, calibration,
pad predicate. Lane B (Sonnet): C3+C4+C5 — feasibility, trace
association, fill-first solver, receipts. Split is on context bounds;
territory fences absolute (neither lane touches the other's files or any
test asserting the other's behavior). Opus holds this contract, reviews
both lanes against it, final pass with bounce authority. Instrument
before fix: the C6 acceptance scoreboard lands first, from a lane that
touches no detector source. Baseline capture + byte-diff against the
2026-08-28 receipts. The lead (Fable) reviews outcomes and talks to the
owner; the lead never holds the code.
