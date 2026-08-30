# Badge ↔ Basket Dual-Trace Experiment Checkpoint

**Pinned:** 2026-08-30  
**Branch:** `experiment/badge-basket-dual-trace`  
**Base:** `frozen108/posterior-tee-recovery @ c05521af628045818ec378f6b25b9110f6b28d66`

This document freezes the current pathfinding research state so work can pivot safely to canonical object-perimeter assembly and later resume without reconstructing the experiment from chat history.

## Hard pathfinding contract

Pathfinding does **not** receive basket ownership.

- Known input: sealed `tee -> badge` pose/ownership.
- Basket input: anonymous detected basket candidates / semantic basket tips.
- Pathfinding discovers basket ownership; basket ownership never supplies the answer.
- Known UI/object occluders are neutral/UNKNOWN where they hide expected pixels; they are not negative evidence.

## Straight Test

Physical primitive:

> A known-straight hole defines a finite directed playable corridor. The basket is the first detected semantic basket **TIP** that corridor encounters.

Use the accepted Tee→Badge direction and configured corridor width. For each anonymous basket tip, compute forward projection and perpendicular miss. Eligible tips are forward and inside the half-width; first physical tip wins.

Important semantic correction: preserve local Straight Test testimony. Do **not** globally veto a correct local straight hypothesis merely because another hole's long ray later crosses the same basket.

Observed controls:

- Lenard: 18/18 straight holes resolved.
- Dash's Track: all 9 zero-bend holes locally selected the correct basket tip; 0/9 bent holes selected their own basket under the straight hypothesis.

## Lane-follow lineage

Historical full tracker: `src/lib/nuthing/fourLaneRibbon.ts` from the Aug-23 lineage (`13111d9...`).

Recovered Four-Lane behavior:

- oriented corridor cross-section, not a point;
- paired / one-sided rail evidence;
- known occlusion = UNKNOWN;
- sustained local heading search;
- deterministic handling around the badge in the historical implementation.

A clean Three-Lane reduction (left rail / center interior / right rail) was A/B tested with identical steering constants.

Dash's first blind A/B, no tuning:

- Three-Lane bent holes: **4/9 correct basket tip, 0 wrong tips, 5 evidence-lost**.
- Four-Lane bent holes: **3/9 correct basket tip, 0 wrong tips, 6 evidence-lost**.
- Both solved the two-bend H18.
- Three-Lane additionally solved H14, where Four-Lane died around dashed C1/C2 furniture.

The exact historical Three-Lane implementation was not recovered; do not claim the reduction is historical code.

## C1 / C2 terminal compass

The basket-zone rendering contains useful reverse-heading evidence.

### C2

Absolute brightness is not the invariant. Straight-hole controls showed a course-local alpha/compositing effect: the same translucent path paint can brighten dark ground and darken bright ground.

Dash's straight-hole fit was approximately:

`path ~= 0.329 * background + 0.671 * [158, 171, 164]`

The effective paint is green-biased gray.

Useful terminal rule:

> Find at least one sustained C2 rail; verify that pixels on the inside of that rail resemble the **course-local expected path composite over their own local background**.

One rail is enough. A provisional `minRun = 10 px` worked well on Dash's straight calibration holes.

Dash's course-local C2 alpha + single-rail probe reached **17/18 within 20 deg**; H4 was the lone severe failure and visually contains essentially no clean terminal evidence.

At crossings, prefer orientation-clustered rail support (width / area under the support peak) over a single best angular sample. This fixed real crossing distractions in Alex Clark.

### C1

C1 provides polarity, not merely an axis. Think "basketball key":

- incoming side contains the stem / rail / altered composite entering the circle;
- opposite side is predominantly ordinary circular fill/boundary.

On NorthPark's blind straight calibration set, given the correct C2 axis, C1 selected the correct 180-degree end **14/14** in the experimental probe.

If C1 polarity is genuinely ambiguous, an optional fallback is to choose the end pointing away from the nearest detected tee candidate; this is only a fallback prior and must not supply basket ownership.

### Alex Clark

The current uploaded Alex annotation file incorrectly has `corridorBends=[]` for the three annotated holes. Historical frozen centerlines establish all three as one-bend holes:

- A1: tee `(603.7,437)` -> bend `(725.6,732.9)` -> basket `(864.5,794.5)`
- A2: tee `(738,72.2)` -> bend `(850.6,93.2)` -> basket `(1017.5,287.9)`
- A3: tee `(673.9,1846.1)` -> bend `(485.2,1691.9)` -> basket `(432,1586.2)`

Using course-local terminal evidence + orientation-clustered rail support, the experimental terminal-compass errors were approximately:

- A1: 6.9 deg
- A2: 4.5 deg
- A3: 3.3 deg

## Forward post-badge reacquisition — PIN HERE

This is the current intentionally bounded primitive. Do **not** over-build beyond it until object perimeter custody is fixed.

Question:

> Given sealed Tee→Badge pose + corridor width + canonical badge-owned pixels, can we reacquire the ribbon immediately after/through the badge occlusion?

State model:

`BADGE-HIDDEN -> PARTIAL-EMERGENCE -> REACQUIRED`

Then stop. **REACQUIRED does not grant steering authority.** Steering / TRACKING is a later state.

Why: at oblique crossings, the badge can hide a large fraction of the ribbon cross-section even after the centerline exits. Different rails emerge at different times. A real bend may also start while part of the cross-section remains badge-occluded.

Reacquisition rule tested:

- keep the sealed Tee→Badge heading;
- hidden samples are neutral;
- one expected rail sustaining the **incoming heading** for `minRun = 10 px` is enough to regain rail custody;
- do not rotate the rail anchor around the centerline to evade the badge;
- record what unconstrained steering *wanted* to do only as contamination testimony.

Full experimental sweep across 108 holes:

- **108/108** reacquired one sustained incoming rail.
- median reacquisition distance from badge center: ~19 px.
- median centerline exit: ~27.25 px.
- median full cross-section clear: ~30.5 px.
- **84/108** reacquired before the centerline had exited the badge approximation.
- **90/108** reacquired while some cross-section remained badge-occluded.
- 75 straight controls: if steering were allowed immediately, 60/75 would falsely want >=6 deg of turn, 41/75 >=12 deg, only 15/75 preferred straight.
- 31 bent holes with explicit bend coordinates: 31/31 completed the 10 px reacquisition run before the first true bend.

This is strong evidence that **reacquisition and steering are separate states**.

## Dual-trace direction after reacquisition

Once post-badge reacquisition is trustworthy:

### Forward

- starts from the sealed badge-side pose / reacquired rail;
- no basket target;
- follows raster outward until confidence dies or it physically encounters an anonymous basket tip.

### Backward

- starts from an anonymous basket's C2 axis + C1 polarity;
- the **known badge is its semantic target**;
- it does not need to reach the tee because Tee→Badge is already sealed.

### Preferred success

If both traces exist, prefer that they **meet**. This gives independent testimony from both ends and naturally localizes the bend(s).

Also-valid closures:

- backward trace reaches the known badge;
- forward trace physically hits an anonymous basket tip.

If both traces die leaving a bounded gap, a later seam-closure primitive may fit the smallest plausible 0/1/2-bend connection. Historical Z-fit is conceptually related but should be treated as a **seam closer**, not allowed to become the primary pathfinder.

## NorthPark notes

NorthPark was already complete in the older frozen tee→badge receipt, so the local exploratory work used that parity-equivalent endpoint inventory rather than rerunning `c05521a` in the sandbox. `c05521a` was separately verified to commit posterior-selected tee→badge parity into `assignment` when posterior is enabled.

Important correction from owner review:

- **NorthPark H5 is straight and already solved.** Previous interpretation of its badge-local evidence as a hidden bend is invalidated. That evidence may still be useful for studying badge occlusion/reacquisition, but H5 must remain in the straight/control bucket.

Do not promote exploratory NorthPark basket ownership claims from this checkpoint without rerunning them under the finalized perimeter/reacquisition contract.

## Why we are pivoting now: canonical object perimeters

The full-course reacquisition renders exposed a systematic Badge bbox error: the bbox bottom was too high because downstream code was effectively using detector-component geometry (black plate/core) instead of the physical badge perimeter.

The correct fix is **not another downstream mask heuristic**.

At object acquisition time, merge the detector-owned components that constitute the physical object and store one canonical object representation:

- exact owned-pixel mask;
- exact perimeter;
- semantic bbox derived from that perimeter;
- constituent detector components retained as provenance / subgeometry.

Then every downstream consumer — occlusion, overlap, post-badge reacquisition, rendering, receipts, pathfinding — consumes the same stored `Badge` / `Basket` object perimeter. Do not independently reinvent masks or bboxes.

This aligns with the root-object direction: detector components are evidence used to **acquire the object**; they are not themselves the canonical object.

## Resume checklist after perimeter work

1. Replace the badge bbox approximation in the reacquisition experiment with canonical badge-owned pixels/perimeter.
2. Re-run the 108-hole reacquisition sweep unchanged otherwise.
3. Verify the state conclusion still holds: hidden -> partial emergence -> reacquired, with no steering authority at reacquisition.
4. Re-run straight controls first; any post-reacquisition deviation is direct contamination testimony.
5. Only then reconnect the forward lane/ridge tracker.
6. Keep C2 course-local alpha/rail measurement and C1 polarity as the reverse terminal primitive.
7. Prefer forward/backward trace meeting; use seam fitting only after bounded evidence loss.
8. Keep feature-owned CLIReceipt + VisualRender testimony when this moves from spike math into an ABFeature/operation.

## Artifact custody

Generated PNG/CSV/receipt files from the local exploratory notebook were intentionally **not committed** as repository sources. The stable findings and experiment contract are captured here; future reproductions should emit generated evidence through LAB/feature-owned render/receipt infrastructure rather than checking ad-hoc artifacts into Git.
