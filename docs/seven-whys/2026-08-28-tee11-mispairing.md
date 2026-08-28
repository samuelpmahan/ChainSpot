# Seven Whys: how a correctly-detected tee was assigned to the wrong hole at 2.4e-13

Method: iterative root-cause ("5 Whys", Taiichi Ohno / Toyota, adopted by
Amazon's Correction-of-Errors process). Owner mandated seven levels — the
extra two push past mechanism into incentive design, which is where this
one actually lives.

**The defect** (Claims Ledger rows 10-13, receipts from the instrumented
NorthPark run at `dc96000`): NorthPark H16's tee pad was correctly detected
by G3 and registered as `tee-11`. Assignment paired `tee-11` to badge-4
(hole 12) at score **2.428394544561205e-13**, leaving H16 unassigned. Two
independent diagnostic teams then spent a day looking for H16's tee in G4
recovery — which could never have found it, because it was never missing.

---

**Why 1 — Why was H16 unassigned?**
Because its tee (`tee-11`) was already taken: the global selector had
paired it with badge-12. Receipt: pre-fix assignment table row
`badge-4 → tee-11` at 2.4e-13; H16 absent.

**Why 2 — Why did the selector give tee-11 to badge-12?**
Hole 12's true tee was invisible (no candidate existed for it), the
selector enforces strict 1:1 exclusivity under scarcity (16 tees, 18
badges), and a pairing with ANY positive score beats leaving a badge
unassigned. Badge-12 took the best scrap available; the scrap happened to
be another hole's tee.

**Why 3 — Why does the selector accept a 2.4e-13 pairing at all?**
There is no minimum-viability floor in `assignment.selection`. Zero is the
only rejected score; anything positive is a legal pairing. Note the irony:
the concept already exists one stage later — `phantomTee.minViableScore`
treats a hole "whose best assignment score is at or below this" as
tee-less. The selector itself never learned that lesson.

**Why 4 — Why does a garbage route score positive instead of zero?**
Corridor/support scoring returns continuous products that floor near-but-
above zero for almost any geometry; `scoring.ts` can say `unreachable`,
but "reachable through 12 orders of magnitude of implausibility" is
represented as a number, not a verdict. No epsilon separates
"weak evidence" from "no evidence wearing a float".

**Why 5 — Why did no receipt flag it?**
Receipts enforce provenance-of-values (where a number came from), not
plausibility-of-values. An assignment score 12 orders of magnitude below
the median of its 15 siblings (0.15-0.63) printed as just another row.
The receipt contract's own rule — "every number with provenance or a loud
UNKNOWN" — was satisfied in letter and violated in spirit: 2.4e-13 IS an
unknown wearing a number.

**Why 6 — Why was there no plausibility rule?**
Because thresholds are treated as dataset-fit estimates and "the first
suspect when a gate misbehaves" (WORKFLOW.md), the system learned to avoid
hard floors — but over-generalized: it never encoded that SCORES HAVE A
NOISE FLOOR, even a receipt-only advisory one. Avoiding footgun thresholds
became avoiding anomaly detection entirely.

**Why 7 — Why did the system's incentives permit this for a full day of
diagnosis?**
Because the success metric during buildout was COUNT-COMPLETENESS
(assignments: N/18). A forced garbage pairing INCREASES the metric; an
honest "badge-12: no viable tee" DECREASES it. The metric rewarded the
selector for hiding scarcity, and rewarded every later reader for trusting
the count. Systemic root cause: **counts without confidence are a metric
that pays for silence** — the same silence WORKFLOW.md says destroyed tee
detection three times before.

---

## Corrective ladder (one fix per level; * = already landed)

1. *Discovery rebuild (`ae68617`): new recoveries entering the pool let
   global reassignment re-pair tee-11→H16 — symptom cured.
2. Represent scarcity honestly: when candidates < badges, an unassigned
   badge with reason beats a forced pairing (needs Why-3's floor).
3. `minViableAssignmentScore` knob on `assignment.selection`: below floor,
   leave the badge loudly unassigned (`no viable tee (best score X below
   floor Y)`); phantom completion then owns it explicitly under its
   maxCompletions budget.
4. `scoring.ts`: an `effectively-unreachable` verdict below an epsilon,
   with the epsilon knobbed and provenance-noted.
5. Receipt anomaly line: HOLE ASSIGNMENTS prints the score distribution
   (median, min) and flags any row ≥ N orders of magnitude below median —
   advisory, never a filter.
6. Policy line for the engrams: plausibility checks are receipt content,
   not gates — an advisory anomaly flag cannot footgun a legal course.
7. Metric change: scoreboards report `assignments: viable K + forced J of
   18`, never a bare count. A forced pairing is no longer indistinguishable
   from success.

Levels 3-7 are open work; entered as a standing docket in the Claims
Ledger.
