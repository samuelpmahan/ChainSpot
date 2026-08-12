# Annotate Round: internal pipeline-clarity view (for Sam -- not shipped)

**Status**: design only, nothing here is implemented. Companion to
`docs/annotate-round-correction-log.md` (schema, storage, gating policy)
and `docs/annotate-round-ask-copy.md` (the shippable, end-user-facing
counterpart of this doc). **This view is internal-only and must never ship
externally** -- it exposes raw detector names, confidence scores, and gate
reasoning that are meaningless (and confusing) to an end user; that
vocabulary is deliberately excluded from the ask copy on the other side of
this split.

## What it's for

A separate, internal-only view of exactly what the end-user copy hides:
which detector produced (or failed to produce) each proposal, its
confidence, the gate decision and why, and -- once corrections exist --
whether the gate call turned out right in hindsight. This is the
correction log's own `priorProposal`/`gateDecision`/`reason` fields,
rendered plainly, per hole, per round.

This is the direct analogue of what `grayt_tune.py`'s diagnostic overlays
already do for the CV probes in this repo (main overlay = only what the
system would claim; diagnostic overlay = every candidate, gate-passed or
rejected, in context) -- same idea, pointed at real Annotate Round
sessions instead of the two labeled fixtures. It's what makes the gating
thresholds in `annotate-round-correction-log.md` (GRayT's 0.55,
courseGrammar's failure flags) something that gets *revisited against
real outcomes* instead of staying frozen at whatever the two-course LOOCV
pass found.

## Concrete layout

A table, one row per hole per endpoint, nothing fancier needed for a
first version:

```
Hole  Endpoint  Detector              Confidence  Gate          Reason                      User said
----  --------  --------------------  ----------  ------------  --------------------------  ----------
 1    tee       grayt-stage2          0.71        auto-accept   --                          confirm
 1    basket    courseGrammar-hung.   0.93        auto-accept   --                          --
 2    tee       grayt-stage2          0.48        flagged       below-gate-threshold         move (+62px)
 2    basket    courseGrammar-hung.   0.61        flagged       ambiguous-basket             replace
 6    tee       grayt-stage2          0.14        flagged       below-gate-threshold         place
14    basket    none                  --          no-candidate  missing-tee                  place
```

Columns map 1:1 to the correction log's `CorrectionEvent` fields
(`priorProposal.detector`, `.confidence`, `gateDecision`, `.reason`,
`userAction`) -- no new data needed, just a plain render of what's already
being recorded.

## Sortable/filterable by the two questions that actually matter

- **"Which gate calls were wrong?"** -- filter to rows where `Gate =
  auto-accept` and `User said` is `move`/`replace`. Those are false-accepts
  slipping through, the single most important row type to see, and tie
  directly to the LOOCV report's zero-false-accept priority
  (`scripts/cv-probes/grayt-tuning-report.md`).
- **"Which detector/reason combos are eating the most manual time?"** --
  group by `Detector` + `Reason`, count rows. Tells you which failure
  pattern from `docs/deferred-detection-experiments.md`'s GRayT section is
  actually costing clicks in the wild, vs. which were theoretical concerns
  from 2 fixtures.

## Color cue

Red only on the false-accept case above (auto-accepted, then corrected)
-- that's the one row type that should visually jump out, since it's
direct evidence a threshold is in the wrong place. Nothing else needs
color; a plain table is fine otherwise.

## Where it lives

A route gated behind a local-only dev flag (e.g. a `?dev=1` query param or
a `localStorage` toggle, checked the same way other internal-only surfaces
in this codebase would be -- no new build target needed), reading directly
from the `CorrectionEvent` IndexedDB store plus whatever live detector
output the current session already has in memory. Never bundled into
anything an alpha user's build would surface by accident.
