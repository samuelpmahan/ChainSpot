# TBS port — orientation-preserving rail evidence

Branch: `codex/ab-tbs-orient-rails`. Port ONE bounded behavior from the Dev72 badge-disk study: preserve the best rail orientation instead of collapsing rail evidence to a scalar max. This is a local sensing primitive, not a path optimizer.

Use current straight-test gate (`TBS`, `GS`, etc.). Deviation, default OFF.

## Exact study math
For a candidate center, known width W, incoming Tee→Badge heading H:
- test `orientationCount=24` axial orientations: `theta = i*pi/24`, i=0..23
- normal `n=(-sin(theta),cos(theta))`
- half-width `W/2`
- edge delta `2.5px`
- lift reference `45`

Rail sample points at normal offsets `-(W/2-2.5)`, `-(W/2+2.5)`, `+(W/2-2.5)`, `+(W/2+2.5)`.

A side is badge-blocked if either its inside/outside sample lies in the known badge bbox.

Paired candidate orientation is eligible only when both sides are unblocked and valid. Left lift=`(leftInside-leftOutside)/45`; right lift same. Require both >0. Paired strength=`min(left,right)` capped at 1. Keep the orientation with maximum paired strength.

One-sided candidate orientation is eligible only when exactly one side is badge-blocked. Score the fully visible side with the same positive lift/cap. Keep max orientation and visible side (`-1=left`, `+1=right`, `0=none`).

Orientation is axial, modulo pi. Relative signed delta to incoming heading:

`d = ((theta - H + pi/2) mod pi) - pi/2`

Useful output representation from the grid search:
- paired strength
- `cos(2dP)`, `sin(2dP)`
- paired strength * those two
- one-sided strength
- `cos(2dO)`, `sin(2dO)`
- one-sided strength * those two
- visible side

Do NOT replace this with scalar `max rail strength`. That ablation was flat: image-only macro IoU ~0.695; +scalar strengths ~0.694. Preserving orientation improved the badge-disk model to ~0.732 IoU for both vectors and ~0.738 in the best small model grid. The behavior being ported is the deterministic rail observation/encoding, NOT the trained tree classifier.

Knobs: `orientationCount=24`, `edgeDeltaPx=2.5`, `liftReference=45`. If those already belong to the base four-lane sensor when this branch is implemented, resolve that registered feature rather than silently fork constants.

Export pure core. Tests: axial wrap, pi-equivalent headings, exact visible-side semantics, both-positive requirement for paired evidence, deterministic tie behavior. Follow ABFeature contract; parity must not move.
