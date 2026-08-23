# TBS port — deterministic known-badge transit

Branch: `codex/ab-tbs-badge-transit`. Port ONE bounded behavior from `codex/three-factor-dev72-lab:src/lib/nuthing/fourLaneRibbon.ts`: deterministic transit through the starting known occluder. Do not port four-lane sensing or heading search here.

Use the straight-test gate available on current base (`TBS`, `GS`, etc.). Deviation, default OFF.

## Exact geometry
State has center `(x,y)`, heading `h`, corridor width (width is carried but irrelevant to the exit calculation). Known occluder is axis-aligned bbox `(x0,y0,w,h)`.

If state center is outside bbox, exit distance = 0.

Let `dx=cos(heading)`, `dy=sin(heading)`, epsilon `1e-9`.
Candidate forward distances:
- if `dx>eps`: `(x0+w-x)/dx`
- if `dx<-eps`: `(x0-x)/dx`
- if `dy>eps`: `(y0+h-y)/dy`
- if `dy<-eps`: `(y0-y)/dy`
Keep finite distances >=0. Exit distance = minimum kept distance, clamped >=0; if none, 0.

Old tracker lock: when the starting center lies in a known occluder, deterministic span = `exitDistance + one complete tracker step`. During that span:
- advance only on frozen incoming heading
- heading delta exactly 0
- no heading/lateral optimizer
- no lookahead reward
- hidden/partial observations may be recorded but DO NOT increment evidence-loss/unknown failure state
- search resumes only after the deterministic remaining distance reaches zero

Expose actual tuning constants as knobs. `extraLockSteps=1` is the behavioral default. If `stepPx` already belongs to another registered straight-test feature, consume that knob rather than duplicate it; otherwise expose `stepPx=6` here temporarily and document the ownership.

Pure tests must cover horizontal exit, 45-degree exit (`10*sqrt(2)` for a centered 20x20 box), already-outside =>0, and the old regression: start x=50 in bbox x=40..60, heading right, step=6 => transitions to 56,62,68 are deterministic; next transition is optimizer-owned.

Do not patch pixels/support here. Existing `badgeOcclusionPatch` is a different behavior: this feature constrains CONTROL while evidence is knowingly hidden. Follow `docs/abfeature-contract.md`; parity pin must not move.
