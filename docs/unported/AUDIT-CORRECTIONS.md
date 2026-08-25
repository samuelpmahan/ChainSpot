# Corrections to AUDIT.md — verified 2026-08-25 by Claude (foreground)

AUDIT.md's three "most damaging" findings were checked against the actual
filesystem. **Two are false.** They have propagated into README.md's decision
list and regeneration order and should be struck there.

## FALSE — finding 3: `ChainSpot-rec-demo`

Claimed: 72.5 MB of untracked per-stage evidence images (`tee-raw` ->
`tee-deduped` -> `tee-assigned`, `basket-raw` -> `basket-assigned`) plus a
121 KB detection log with per-candidate rejection reasons.

**No such directory exists.** `ls -d /c/Users/tenni/workspace/ChainSpot-rec*`
and a workspace-wide glob for `*rec-demo*` both return nothing.

Consequence: README §5 item 6's "zero rendered evidence images" claim stands
UNREFUTED. Regeneration step 3's demand for rejection testimony is NOT already
satisfied. Nothing has been recovered here because there is nothing to recover.

## FALSE — finding 1 (partly): fountain-hills evidence

Claimed: `fountain-hills-results/` holding 16 rendered evidence PNGs,
`FINDINGS.md`, `metrics.json` (9,158 B), `intake.tsv` — and that FINDINGS.md
contains a per-capture badge threshold sweep at 40/50/60/70, "the exact
brightness-sensitivity measurement the spec says was never recorded."

**None of those files exist.** No `fountain-hills-results/` directory. No
`FINDINGS.md`, `metrics.json`, or `intake.tsv` anywhere in that worktree
(checked to depth 3, excluding node_modules). PNG count in the claimed
location: 0.

The threshold sweep at 40/50/60/70 is NOT recorded anywhere on this machine.
It remains an UNKNOWN. Do not cite it.

## TRUE — and rescued

**`.fountain-hills-input/`** in `ChainSpot-dsh-fountain-hills` does exist:
four raw captures (FountainHills-1, -2, -full, and "Fountain Hills-lazy"),
24 MB, untracked. Fountain Hills is **not** one of the five corpus courses
(AlexClark, DashsTrack, Heritage, Lenard, TowneLake), so this is a genuine
held-out course — useful for truth-blind work.

**Finding 2 — the Codex worktree** at
`C:/Users/tenni/Documents/Codex/2026-08-16/you-are-sol-lead-architect-for`,
branch `refactor/separation-of-concerns`: confirmed 4 modified + 3 untracked
new source files, uncommitted.

Both copied to `D:/LAB/rescued/2026-08-25/` (27 MB total). Purely additive —
nothing on C: was moved, modified, or deleted. The uncommitted refactor state
is preserved as `modified.patch` (795 lines) plus the three untracked files
verbatim.

## Standing lesson

The audit's two clean dimensions (numeric-constant fidelity, verbatim diff
reproduction) were checked and held. Its filesystem claims did not. An agent
reporting on files it read is more reliable than one reporting on files it
inferred should exist.
