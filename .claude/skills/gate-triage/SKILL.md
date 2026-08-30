---
name: gate-triage
description: >
  Locate the earliest ChainSpot stage whose claim about the world becomes false.
  Use for any missing, misplaced, misidentified, stolen, or nonsensical endpoint
  or assignment. Start from pixels and object identity, then walk G1->G6. Never
  start by hunting for a desired object or by explaining a downstream symptom.
---

# Gate Triage

The job is not to "find the tee."

The job is to determine the earliest point where the pipeline stops telling the
truth.

A successful result may be:

- "G1 read the badge wrong";
- "G3 localized the tee correctly; assignment stole it";
- "these pixels are badge chrome, not tee evidence";
- "there is no identified visible tee evidence in this crop";
- "G4 rejected the correct remnant for this named reason."

All are better than inventing a tee.

## 0 — Identify before measuring

Before computing angle, PCA, fit, distance, support, score, or ownership on a
bright component, answer:

> **What physical/rendered object are these pixels?**

Use the canonical raster and a minimal crop. Compare against known renderer
objects/chrome and the course's measured object family.

Allowed identities:

- identified tee/pad evidence;
- identified badge/badge digit;
- identified basket;
- identified C1S/C2D or screen chrome;
- ambiguous / unknown.

**UNKNOWN is a valid answer.**

An unknown component does not become tee evidence because:

- it lies near a badge;
- its axis points somewhere useful;
- a constrained fit can pass through it;
- the downstream assignment improves;
- it is the only bright thing left.

If identity is ambiguous, stop the geometry and report ambiguity.

### Badge-digit hard stop

If a disputed component is inside or immediately associated with a badge's
rendered plate/digit region, treat badge chrome as the default hypothesis until
raw pixels/context disprove it.

Do not call a tiny component a shard first and ask what it is later.

The historical failure this prevents: mathematically consistent tee-angle
claims computed on badge digit glyphs.

## 1 — Ask the smallest visible question

Use LAB, not private scripts.

Start with the smallest view that answers the identity question:

`./lab scope hN`

Use broader context only when the object cannot be identified locally. Add truth
only when explicitly doing assisted diagnosis, and preserve truth-taint rules.

Do not begin by dumping every component or every metric.

## 2 — Walk from earliest gate forward

### G1 badge
- Is the hole label itself correct and confident enough to reason by hole number?
- Internal ordinals are not hole numbers.
- Garbage OCR means downstream "missing HN" reasoning may be invalid.

If G1 is wrong, stop. Do not repair G3/G4 around a bad label.

### G2 basket
- Is the basket localized?
- Is the evidence actually basket ink / semantic tip?
- Is ownership based on the drawn object, not empty bbox area?

### G3 visible tee
- Is an intact/non-occluded pad visibly present?
- Did ring detection produce it?
- Did teeFamily keep or reject it?
- If G3 found it, do not call it a detection miss merely because final
  assignment lacks it.

### G4 recovery
Only after identified occlusion/remnant evidence exists:
- what known occluder explains the missing pixels?
- what remnant remains after known-occluder subtraction?
- did G4 consider it?
- if rejected, print the one rejection reason and value relevant to the hole.

No identified remnant = do not manufacture a recovery theory.

### G5/G6 assignment/pathing
If endpoints exist but the hole is wrong/missing:
- inspect candidate ownership/assignment;
- look for stolen tees, garbage-score forced matches, or pool scarcity;
- distinguish localization success from ownership/assignment success.

## 3 — One failure class, not ten theories

Return the earliest supported class:

`G1 LABEL`
`G2 BASKET`
`G3 VISIBLE-DETECTION`
`G4 RECOVERY-DISCOVERY`
`G4 RECOVERY-REJECTION`
`G5/G6 ASSIGNMENT`
`G6 PATHING`
`UNKNOWN — insufficient identified evidence`

Then name exactly one next experiment that can falsify that class.

## 4 — Claims ledger

Any diagnosis that will steer code belongs in `docs/CLAIMS-LEDGER.md` with its
receipt. Retraction is expected and valuable.

Do not enter:

"component #123 is definitely the tee"

unless the receipt lets the owner visually establish that component #123 is
actually tee pixels.

## Anti-confirmation rule

A skill named "tee hunter" naturally rewards finding a tee. Gate triage does not.

Never search until something fits the desired story. Search until the earliest
pipeline claim is either upheld or falsified.

If the evidence says "I cannot identify tee pixels," that is the result.
