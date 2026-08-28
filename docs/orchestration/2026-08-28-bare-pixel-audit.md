# Bare-pixel audit: badges 3 and 5, DashsTrack --through G4

Run under audit: `artifacts/test/lab-sweep-through-g4/run.receipt.txt`
(config `dev72-recovered-default`, source
`/home/user/chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg`, canonical
raster `artifacts/test/lab-sweep-through-g4/renders/input/g0.canonical.png`,
1290x2083). Crops referenced below live under
`artifacts/orchestration/bare-pixel-audit/`.

## Claim under audit, quoted

> "the REAL recovered pads for badge 3 and badge 5 measured 0.61 and 0.51
> bare with '0 occluded by named occluders' ... Garbage fragments measured
> 0.87-0.97."

## Finding 0 (receipt-reconcile step 1): the 0.61 / 0.51 numbers do not
## appear in this receipt, and badge 3 has no recovered pad at all

`grep -n "bare fraction" run.receipt.txt` returns 28 lines, every one of them
a `rejectionReason` for a candidate that was **not chosen**. Every printed
badge-3 and badge-5 CONTRAPOSITIVE line sits at bare fraction 0.860-0.966 --
i.e. inside the task's own stated "garbage" band, not a distinct pair of
numbers. The one printed value in the 0.5-0.7 range is a badge-5
badge-constrained localization candidate at **bare fraction 0.626**
(`run.receipt.txt:195`), and it too is logged as "not chosen."

The receipt's `HOLE ASSIGNMENTS` table settles what each badge's *real* pad
is:

```
H4 | badge-3 | tee-2            -> basket-6 | 0.336 | 1 | 0.993
H5 | badge-5 | tee-recovered-1  -> basket-5 | 0.266 | 1 | 0.988
```

`tee-2` (no `recovered` in the id) is a **G3 visible tee** --
`tees.exclusion.kept.bin` shows it as `{"detId":"tee-2","tier":"ring",
"onRing":true,"fill":0.884,"bbox":[420,630,18,25]}`. Badge 3's real,
final pad was never run through `auditSupportFootprint` at all -- it is not
a recovered pad, it is a plain ring detection. The 0.87-0.97 "garbage"
numbers logged under "badge 3" in this receipt belong to unrelated decoy
fragments the recovery hunt considered *before* the widened reassignment
step handed badge 3 its real, already-visible `tee-2` (see
`run.receipt.txt:205`: "badge 3: hunted -- no visible tee could claim this
badge" followed later by the reassignment that gives it `tee-2`). So as
this receipt stands, **there is no "0.61 bare real recovered pad" for badge
3** -- the premise doesn't hold against these pixels. If 0.61 was computed
elsewhere (a different config/run, or directly against a decoy candidate),
that computation is not about badge 3's real tee.

Badge 5 is different: its real pad, `tee-recovered-1`, **is** a genuine G4
recovery, and its accepted footprint-audit numbers are never printed in the
text receipt (only rejected "runner-up" candidates get a `rejectionReason`
line -- accepted candidates only surface as aggregate `measurement`
counts). Since `teeRecovery` unit `accepted=4` and this pad made the final
board, its true bare fraction must have been ≤ `maxBareSupportFraction`
(0.7) -- consistent with the task's cited 0.51. This is itself a receipt
gap worth flagging to the team: accepted contrapositive-audit numbers
aren't surfaced anywhere a human can read them; only the losers are.

## Minsky frame -- badge 3 (H4)

- **Looking for**: badge-3 / hole 4's tee pad.
- **It looks like**: a white rotated-rectangle *ring* (hollow outline),
  roughly 18-27px per side, matching this course's own measured tee
  components (`tees.exclusion.kept.bin` areas 340-470, bbox ~18-27px).
- **I know that because**: 17 other tee candidates on this same course/run
  measure in exactly that size/shape band, and the chrome-signature table
  rules out badge/basket/digit confusion at this size.
- **It may be near**: badge-3's centroid (443.7, 739.5) in canonical
  coordinates (component label 26 in `badgeStage.components.bright.bin`,
  matched by ordinal position in the top-to-bottom component-label order),
  along the badge-to-pad ray, ~100-200px away per this course's
  `padClaimMedianPx` (125.1px).

## Pixel receipt -- badge 3 / tee-2

- `badge3_tee2_visible.png` -- tight crop (6x zoom) at (428.6, 641.6), bright
  mask tinted green. The pad renders as a **complete, contiguous bright
  ring** around a gray (correctly non-bright) interior -- 590/14,400 bright
  px in the crop, forming a clean rectangle, not a scatter.
- `badge3_context.png` -- wider crop (3x) showing badge "4", the ray to
  tee-2, *and* a second nearby ring fragment above it (why the initial hunt
  had ambiguity here before the reassignment step resolved it to tee-2).

**What the bare pixels actually are, for badge 3**: there aren't any of
consequence at the real pad. Direct ASCII/pixel dump of the ring band shows
it fully above the `V>=210` bright threshold on essentially every cell.
None of hypotheses (a)-(d) apply to badge 3's *real* tee, because the real
tee has no bare-pixel problem. The high-bare-fraction lines the receipt
prints under "badge 3" describe other, already-correctly-rejected
fragments elsewhere on the raster (e.g. the ones anchored near badge 12's
ray, `run.receipt.txt:172-174`) -- decoys, not badge 3's pad.

## Minsky frame -- badge 5 (H5)

- **Looking for**: badge-5 / hole 5's tee pad (a G4-recovered pad this
  time, per `tee-recovered-1`).
- **It looks like**: same family -- a white rotated-rectangle ring,
  ~18-27px per side, oriented along the badge ray.
- **I know that because**: same course-measured evidence as above; G4's
  own `axisErrorDeg` measurement for this run's 4 accepted recoveries is
  1-2 degrees off the badge ray, i.e. tightly ray-constrained.
- **It may be near**: badge-5's centroid (550.4, 808.4) (component label
  36); the accepted recovery's fitted center was located independently by
  clustering the red "opposite-corner X" pixels `run.visual.png` draws for
  every accepted recovered-tee pose (see Method note below) -- landing at
  (483.9, 849.0), ~78px from the badge, consistent with
  `padClaimDistancePx` (77.4-214.1px measured range for this run) and with
  the receipt's own text: badge 5 "holds a geometric claim (tee-4 at
  131.0px)" nearby, and a rejected badge-6 recovery sits at (436, 895) a
  short distance further on -- both bracket this location plausibly.

## Pixel receipt -- badge 5 / tee-recovered-1

- `badge5_teeRecovered1_sidebyside.png` -- raw color vs. bright-mask overlay
  at (483.9, 849.0), 10x zoom. **A real tee pad is unmistakably present**:
  same size, same rotated-rectangle-ring shape, same visual character as
  tee-2. A human looking at the raw panel sees a normal white tee pad.
- `badge5_context.png` / `badge5_ribbon_corridor.png` -- wider crops showing
  badge 5, the tee, and the tee->basket-5 ray; the pad sits on open fairway,
  **not** under any basket's C1S/C2D range-ring wash and **not** on the
  dashed cart-path border.
- ASCII brightness/mask dump (28x28 px band around the fitted center; `#`
  = bright-mask ON, `+`/`.`/space = descending raw V) shows the ring is only
  **partially** above the `V>=210` cutoff -- large stretches of the true
  outline sit in the `.`/`+` band (raw V roughly 160-200), well short of
  threshold, while tee-2's equivalent dump (badge 3) is solid `#` almost
  everywhere.

### Quantified pixel check (script in scratchpad, computed directly from
`g0.canonical.png` + `badgeStage.masks.bright.bin`, OpenCV-exact V/S per
`raster.ts`):

| region (26x26 box) | mean V | mean S | bright frac (V>=210 & S<=45) |
|---|---|---|---|
| tee-2 ring (badge 3, genuine) | 183.9 | 5.7 | 0.273 |
| tee-recovered-1 (badge 5) | 188.7 | 18.7 | 0.229 |
| plain nearby fairway (baseline) | 168.7 | 32.9 | 0.000 |

Saturation stays comfortably under the `brightSMax` cap (45) at badge 5's
pad (mean S 18.7, worst case still <45 for 99.3% of the box) -- so this is
**not** a colorful/translucent wash pushing S over the limit. The gate is
brightness (V), not saturation, and badge 5's pad sits only slightly higher
in mean V than the plain fairway baseline, nowhere near the crisp ~250+ V
that tee-2's ring hits at its border.

## Hypothesis verdict

- **(a) translucent ribbon wash** -- not supported. Saturation at the pad
  stays low (mean S 18.7, cap is 45); a ribbon/corridor overlay would be
  expected to lift S (color bleed-through), not just leave V short. No
  distinct semi-transparent stripe geometry is visible connecting this pad
  to anything at this zoom; the surrounding tone is uniformly pale, same as
  elsewhere on this course's render.
- **(b) genuine unnamed occluder (vegetation/shadow)** -- not supported. No
  localized darkening or a shadow-edge gradient is visible in the raw crop;
  the pad's *own* material tone is simply low-contrast relative to the
  hard-coded threshold, and the surrounding fairway on both sides of it is
  equally pale (a real shadow/vegetation edge would show a boundary the
  raw crop does not have).
- **(c) footprint drawn at the wrong place/size (fit/coordinate bug)** --
  not supported. The fitted rotated-rectangle sits exactly on a real,
  correctly-sized, correctly-oriented tee-pad-shaped object in the raw
  image (`badge5_teeRecovered1_sidebyside.png`). `auditSupportFootprint`
  in `g3.teeRecovery.ts` (lines 342-369) also only counts pixels the
  hollow-border predicate `pointExplainsTee` accepts -- the ring band, not
  the solid interior -- so there is no interior-counted-as-bare
  construction bug either.
- **(d) the pad is faint/eroded; the bright mask under-segments it** --
  **supported**. The pad is genuinely present and genuinely tee-shaped at
  the fitted location, but its raster brightness falls mostly short of
  `brightVMin=210` (`raster.ts:48`) across large stretches of its own
  outline, while a same-course, same-size, same-shape pad 200px away
  (tee-2) renders with a fully bright, contiguous ring. This is an
  image-fidelity / threshold-margin gap on this specific pad, not an
  occlusion and not a bug.

## Implication for the gate

The CONTRAPOSITIVE gate's classification machinery (white / occluded /
bare) is working as designed and is landing its hypothesized footprint in
the right place at the right size for badge 5 -- the accepted recovery
(`tee-recovered-1`) is correctly identified as a real pad and did clear
`maxBareSupportFraction`. But this pad's own bare fraction (~0.5, per the
task's figure, plausible given the accepted-vs-rejected pattern above) sits
close enough to genuinely-garbage fragments (0.86-0.97) that the margin
between "real, faint pad" and "decoy" is thin and threshold-driven, not
occluder-driven. That is a **mask-threshold gap**, not a named-occluder gap
and not the fit bug the audit's hypotheses (c) worried about: a pad can be
real, correctly localized, and still register mostly "bare" simply because
this course's raster renders it below `brightVMin` almost everywhere except
a couple of corner cells. The completeness invariant's two-state split
(non-occluded-and-visible vs. occluded-by-a-named-occluder) does not fully
cover this case -- a pad can be neither cleanly visible (G3's ring test
correctly fails to enclose it) nor occluded by anything named; it is just
dim. Recommendation for the owner to weigh (no knob changes made here per
the hard rules): either a softer/secondary brightness tier feeding the
contrapositive audit specifically, or corroborating the bare-fraction
signal with something size/shape-based before treating a ~0.5-0.6 bare
score as strong evidence either way.

Badge 3 needed no such judgment call: its real pad was never a recovery
candidate, never audited by `auditSupportFootprint`, and shows no bare-pixel
problem in the pixels at all -- the 0.61 figure attributed to it in the
audit request does not describe badge 3's real tee under this receipt.

## Method notes (how the coordinates were derived, for reproducibility)

All coordinates are in **canonical raster space** (the run's stated
transform is `canonical = original + (0,-4)`).

1. Badge and basket centroids: read directly from
   `artifacts/componentSet/badgeStage.components.bright.bin` (JSON), filtered
   by the badge-plate signature (area ~450px, bbox ~54x42) and the basket
   signature (area ~1746px, bbox 42x66) from the CV engrams. Both filtered
   lists come out already sorted by `cy` in increasing `label` order,
   consistent with the component extractor's top-to-bottom raster-scan
   labeling, giving badge-0..17 / basket-0..17 ordinal = position in that
   sorted list.
2. Visible tee coordinates: read directly from
   `artifacts/candidateSet/tees.exclusion.kept.bin` (JSON, `detId` field is
   exactly `tee-N`).
3. Recovered tee coordinates are **not** written to any JSON artifact in
   this run (no `componentSet`/`candidateSet` artifact covers
   `recoveredTees`). They were located by rendering
   `renders/run/run.visual.png` and connected-component-clustering its pure
   red pixels (`visual contract: "red: thinnest opposite-corner X;
   intersection is fitted center"`), then matching each unmatched cluster
   (i.e. not coincident with a `tees.exclusion.kept` center) to the nearest
   plausible badge by distance and by cross-checking against text clues in
   the receipt (e.g. "bound recovery at (436,895) discarded as redundant"
   matched a cluster at (436.5, 895.4) almost exactly, confirming the
   method).
4. Bright mask: `artifacts/mask/badgeStage.masks.bright.bin` is a raw
   width*height byte array (0/1), row-major, matching
   `packages/alg/src/detectors/threeFactor/raster.ts`'s `Mask.data`
   contract (`maskBytes()` passes it through unchanged) -- confirmed by
   byte count (1290*2083 = 2,687,070, exact file size).
5. All crops/composites/ASCII dumps were produced by small numpy/PIL
   scripts in the scratchpad, reading only the canonical PNG and the mask
   `.bin` -- no package import, no build, no sweep.
