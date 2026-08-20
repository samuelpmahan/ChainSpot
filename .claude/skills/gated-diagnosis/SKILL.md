---
name: gated-diagnosis
description: Protocol for diagnosing why a measured pipeline fails on a specific case — and for writing prompts that make a smaller/cheaper model do that diagnosis without fooling itself. Use whenever the task is "figure out WHY X fails/skips/misses" on a CV or scoring pipeline, whenever writing a prompt for another session to investigate a failure, or whenever a diagnosis is about to turn into a fix in the same breath. The deliverable of a diagnosis is a mechanism with numbers, never a patch.
---

# Gated diagnosis

A diagnosis session produces exactly one thing: a **mechanism** — a named,
measured explanation of why this case fails while others succeed — plus the
evidence images that let a human check it. It never produces a fix. The
protocol below is ordered; each step gates the next. The steps small models
skip are marked ⚠ — when writing a prompt for a cheaper model, spell those
out as numbered mandatory steps with an explicit STOP, because they are the
ones it will silently omit.

## 1. Gate Zero — prove your substrate ⚠

Before measuring anything, reproduce the pipeline's KNOWN-GOOD result in
your environment (fresh containers rebuild inputs; decoders and versions
vary). If the known-good gate does not reproduce, **stop and report** —
environment variance is now your finding. Never adjust anything to make
Gate Zero pass: a gate you tuned into passing proves nothing afterward.

This repo's gates: dev corpus must replay `ASSIGNED exact=72/72`
(`pair-matrix.ts` + `pair-matrix-replay.ts --zones --simple --invariants
--identity --assign`), The Rec must probe 9/9
(`scripts/nuthing/rec-producer-probe.ts`).

## 2. Facts before code

Read the measured-facts record first (`docs/nuthing-p2/cx-catalog.md`,
section A at minimum). Every hypothesis you form must be consistent with
the recorded physics; a hypothesis that contradicts a CX entry needs to
overturn that entry with a better measurement, explicitly, not ignore it.

## 3. Name your frames ⚠

Before the first measurement, enumerate every coordinate frame and unit in
play and write the conversions down: full-capture px vs viewport-cropped px
(subtract `viewport.top` — CX-038), field cells vs source px (multiply by
`field.scale`), geometry frame vs native frame (divide by `geoScale`,
CX-058), published transform vs rendered transform (animation lag). A frame
mixup produces confident, internally consistent nonsense; it invalidates
the whole session and is the most common way a diagnosis goes wrong
without noticing.

## 4. See the failure before explaining it

Render the failing case — annotated crops with the claim marked — and
confirm the reported failure actually reproduces in your own render before
measuring why. If it does not reproduce, the *report* is the subject now
(see step 8).

## 5. Competing mechanisms, each with a signature

Write down at least three candidate mechanisms BEFORE measuring, each with
the measurement that would distinguish it (its numeric signature). Then
measure all of them. Stopping at the first plausible mechanism is the
second-most common failure; plausibility is not evidence.

## 6. The control ⚠ — no control, no conclusion

Run every candidate mechanism against a **working control case** (a
sibling that does NOT fail). A mechanism that fires equally on the control
does not explain the failure, however good the numbers look on the failing
case alone. This is the single step cheap models skip most reliably —
without it, every mechanism "explains" every failure. In a prompt for
another session, make the control its own numbered step with its own
required output.

## 7. Diagnosis ≠ fix

The deliverable: mechanism named, numbers shown, control comparison shown,
annotated images attached, written in CX-catalog style — plus, separately
and clearly labeled **UNTESTED PROPOSAL**, what a fix might be and which
regression gates it would have to pass. Knobs stay frozen during
diagnosis. A "diagnosis" that lands as a patch has skipped the part where
it could have been wrong.

## 8. The instrument is a suspect

"The report/rendering/test is wrong" is an allowed and *valued*
conclusion. Check the instrument before the subject: a hollow-green test
(asserting something already true, clicking an element that is null), a
render with a frame offset, a screenshot taken mid-animation — all have
produced false failures in this repo. Finding one is a success, not an
anticlimax. Two named instrument traps, each of which has produced a false
"truth is wrong" in this repo:

- **Auto-normalized visualizations lie.** A heatmap scaled to its own
  global max makes moderate values look dark next to one outlier. Never
  conclude "absent/dark/unsupported" from a picture — sample the raw
  values point-wise at the disputed location and report the numbers.
- **When your computed numbers and your eyeballed picture disagree, the
  numbers win.** If your own deltas already say "near-equal" and the
  picture says "missing", the picture's rendering is the suspect, not the
  data.

## 8b. Claiming the oracle is wrong carries an escalated bar ⚠

Declaring the ground truth / human annotation wrong is sometimes correct
(truth files carry measured noise) — but it has been claimed falsely twice
in this repo, by two different models, from the same shape of error:
reading ABSENCE off a bad instrument. Before writing "truth is wrong":
point-sample the raw pixels and the field at the exact disputed location;
check for known occluders drawn OVER the evidence (badges are opaque
plates that sit on corridors by design — dark pixels within ~30px of a
badge center are the badge, not missing paint); and compare the disputed
case's deltas against the control's — a near-zero routed-vs-truth gap is
the signature of equally-real geometry, not of a mislocated annotation.

## 9. Hard stops for the oracle

When there is no ground truth, annotated screenshots to the human ARE the
protocol: render, send, state per-case belief and confidence, **stop and
wait** for verdicts. Do not proceed past an unjudged course. Every report
ships images; a claim without a render is not a report.

## Writing the prompt for another session

Skeleton, in order: (1) context — what works, what the observed weakness
is, one sentence on why it matters; (2) read-first list; (3) bootstrap +
Gate Zero with the exact commands and the literal instruction "if it does
not print X, STOP and report — do not fix anything to make it pass";
(4) the frames paragraph, spelled out; (5) evidence render step;
(6) mechanisms-with-signatures step, listing the candidates you already
suspect so the model measures rather than brainstorms; (7) the control
step, standalone and mandatory; (8) deliverable spec with the UNTESTED
PROPOSAL label; (9) the escape hatch sentence; (10) frozen-knob rule with
the named gates. Steps 3, 6, and 7 are the ones to make loudest — they are
the ones that vanish under cost pressure.
