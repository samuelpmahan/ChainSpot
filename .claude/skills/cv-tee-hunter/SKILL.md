---
name: cv-tee-hunter
description: Hunt down one specific hole's missing tee on a ChainSpot course — determine WHY it is missing (G3 defect / assignment theft / occluded-recoverable / truly invisible) and which gate owns the fix. Use when a course shows fewer than 18 assignments, when a specific hole number has no tee row in HOLE ASSIGNMENTS, or when deciding whether phantomTee's one-hole budget should be spent.
---

# CV Tee Hunter

The hunt that went 4-for-4 on 2026-08-28 (NorthPark H14/H16, Heritage
H5/H6), including catching one "missing" tee that was never missing at all
— it had been detected correctly and STOLEN by another hole's assignment
at score 2.4e-13 (docs/seven-whys/2026-08-28-tee11-mispairing.md).

## Step 0 — Frame (Minsky grounding; see receipt-reconcile step 0)

Looking for: hole N's tee pad. Looks like: a white rotated-rectangle
OUTLINE at this course's measured pad scale (median of the pads G3 already
found — never a remembered size). I know that because: this course's own
G3 receipts. May be near: badge N (badges are placed at tees), beside
basket N−1, possibly merged with chrome (C2D ring / basket glyph) per this
course's z-order. Held loosely — context is never a spatial filter.

## Step 1 — Rule out assignment theft FIRST (cheapest, and the sneakiest)

Read HOLE ASSIGNMENTS in run.receipt.txt. Is there a tee assigned to a
NEIGHBOR hole at an absurd score (orders of magnitude below the median
row)? Check the machine receipt's per-row scores. A stolen tee means: G3
worked, assignment failed under scarcity — the fix is candidate-pool or
selection-floor work, NOT detection. Receipt: the thieving row verbatim.

## Step 2 — Is the pad visibly present? (truth-free)

`./lab scope hN` (digit-derived viewport works on every course) and the
component forensics from receipt-reconcile: bright mask + extractComponents
around badge N and basket N−1. Identify every component by the chrome
signature table (chainspot-cv-engrams) BEFORE trusting it. Outcomes:
- A pad-shaped unowned component exists → class (a) or (b) below.
- Only chrome → possibly under an occluder or genuinely absent.
- Pad pixels merged INTO a chrome component (basket glyph, C2D) → the
  remnant after known-occluder pixel subtraction is the evidence.

## Step 3 — Classify per the completeness invariant

(a) **Non-occluded, G3 missed it** → G3 defect. Common causes: broken
    enclosed-ring (chrome dashes merged with the outline), teeFamily
    size-family exclusion (check the rejection's log-ratio lines), mask
    threshold on a dim pad. Fix belongs to G3; do not contort recovery.
(b) **Occluded by a known occluder** → G4 recovery case. It must appear
    in the G4 trace as a candidate (post-`ae68617` there is NO spatial
    prefilter — every unowned component is considered for every missing
    badge). If rejected, the reason names the rule and the measured value
    (support < 8, axis error vs the configured gate). Judge the FIT, not
    the fragment's PCA.
(c) **No visible evidence anywhere** → phantom territory. phantomTee is
    default-OFF and budgeted: `maxCompletions` (default 1 — owner policy:
    a scalpel, not a spray; a run wanting more phantoms has a detection
    problem). Spend the budget only after (a) and (b) are excluded with
    receipts, via the phantom-on A/B config, and verify the receipt shows
    `synthesized: 1` and WHICH hole.

## Step 4 — Ledger

Enter the classification with receipts in docs/CLAIMS-LEDGER.md (same
commit). A hunt that ends in "still missing" is a valid result IF the
class is proven; "couldn't find it" without a class is not a finished hunt.

## Known traps (each cost a real debugging session)

- Digit glyphs and badge plates masquerade as shards — identify chrome
  first (the 2026-08-28 retraction).
- A garbage digit read (e.g. "787"@0.002, colliding "17"s) makes a hole
  unhuntable by label — check `./lab scope holes` first; a G1 OCR defect
  upstream masquerades as a missing tee downstream.
- Fragment PCA ≠ constrained fit (44° fragment PCA can still fit on-axis).
- 18-hole label cap (measure.ts) — a legal hole number outside 1-18 is
  structurally unassignable today.
