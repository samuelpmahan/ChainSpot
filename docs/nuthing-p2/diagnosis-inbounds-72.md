# Diagnosis: the 7 in-bounds violations on dev72 (routes leave the fairway)

Status: DIAGNOSIS ONLY — knobs frozen. Gate Zero reproduced before measuring
(dev replay `ASSIGNED exact=72/72`, Rec probe 9/9). Substrate: pair-matrix-v5
cache, registered truth, corpus rasters.

## Metric under diagnosis

In-bounds: every point of the assigned route must stay within `W/2 + 8px` of
the truth corridor centerline (tee → corridorBends → basket), full-capture
frame. Baseline: **65/72**. Violations: DashsTrack h6 h14, HeritagePark h7
h14, Lenard h14, TowneLake h11 h16. All seven are route-shape errors —
endpoint assignment stays 72/72.

## Frames

Field cells ×3 → source px (viewport-cropped) → +viewport.top → full-capture.
Registered annotations are already full-capture (similarity transform,
`annotation-registration.json`; ty ≈ 423/429/532 — using raw corpus
annotations instead of registered ones produces uniform ~430px "violations"
on every hole; that instrument bug was hit and fixed during this session's
metric build).

## Pre-registered mechanisms and their signatures

- M1 false ridge: route-span support ≥ truth support, span RGB not
  corridor paint.
- M2 starved truth: sub-τ dips on the bypassed truth segment at an occluder.
- M3 length shortcut: supports comparable, truth path longer.
- M4 adjacent-corridor capture: span within W/2 of another hole's polyline.
- M5 truth wrong (escalated bar, CX-061 discipline).

## Measurements (raw field point samples, no normalization)

| case | maxDev | support route / truth (mean) | RGB route / truth | len route / truth | nearest other corridor | verdict |
|---|---|---|---|---|---|---|
| Dashs h14 | 43.0 | 0.48 / 0.43 | (102,110,97) / (145,155,143) | 114 / 133 | 69px | M1-dark + M3 |
| Dashs h6 | 29.1 | 0.70 / 0.45 | (187,194,194) / (148,157,153) | 47 / 44 | 57px | M1-bright (zone-fill edge clutter) |
| Heritage h7 | 38.9 | 0.50 / 0.42 | (85,86,68) / (137,139,125) | 138 / 146 | 24px | M1-dark (+6/73 sub-τ truth dips; badges excluded, 122px) |
| Heritage h14 | 27.6 | 0.76 / 0.67 | (99,109,104) / (123,138,133) | 35 / 57 | 83px | M1-dark + M3 |
| Lenard h14 | 40.9 | 0.78 / 0.49 | (171,176,168) / (155,161,145) | 116 / 96 | 30px | M5 CANDIDATE (see below) |
| TowneLake h11 | 42.4 | 0.86 / 0.53 | (168,166,165) / (138,140,140) | 84 / 103 | 41px | M1-bright (parallel bright band) |
| TowneLake h16 | 41.0 | 0.49 / 0.47 | (65,68,68) / (169,171,160) | 140 / 159 | 170px | M1-dark at parity + M3 |

Controls (passing siblings, same measurements): TowneLake h7 maxDev 14.3
(0.80/0.69), Heritage h4 11.4 (0.85/0.79), Dashs h3 8.6 (0.66/0.65), Lenard
h13 25.8 (0.69/0.42). No control shows the violation signature at violation
magnitude; Lenard h13 shows the same bright-band pull just under the bound —
dose-response consistent with the mechanism, not a counterexample.

## Mechanism (named, with numbers)

**False-support parity.** The true corridor is never starved — its support
stays ≥ τ (worst dips: Heritage h7, 6 of 73 samples) and its ground reads as
paint (RGB ≈ CX-004 composite (150,155,145)). The routes leave it because
impostor terrain matches or beats it in the paired-edge field:

- **Dark-ground flavor** (Dashs h14, Heritage h7/h14, TowneLake h16): dark
  forest/dark ground (RGB 65–110) earns 0.48–0.76 support — parity with real
  paint — so the shorter corner-cut wins on length (cost = 1+4(1−s)²).
- **Bright-band flavor** (Dashs h6, TowneLake h11): a bright non-corridor
  linear feature (zone-fill boundary clutter at Dashs h6; a parallel bright
  band at TowneLake h11) BEATS real paint 0.70–0.86 vs 0.42–0.53 — TowneLake
  h11's impostor wins despite the detour; Lenard h14's route even pays +20px
  length for its band.

M2 rejected as primary (badges 92–122px from all weak points). M4 rejected
(all spans > W/2 from any other corridor; Heritage h7 closest at 24px vs
W/2=15). This refines the earlier TowneLake finding: h16 is dark-flavor as
recorded, but h11's impostor is a BRIGHT band, not dark forest.

**Zone-furniture check (measured):** fraction of each deviating span within
12px of a C1S(r44)/C2D(r84) boundary around any detected basket — violations
41/20/19/73/61/56/35%, controls 0/0/0/69%. Elevated in 4 of 7 violations but
one control (Lenard h13, the 25.8px near-miss) rides edges at 69% without
violating, so furniture edges are an impostor SOURCE feeding the parity
mechanism, not a discriminator on their own. The discriminating signature
remains support parity: every violation has route-span support ≥ truth-span
support; what varies is the impostor (dark ground, bright band, furniture
edge) and whether the length saving crosses the bound — Lenard h13 shows the
same pull at sub-bound magnitude (dose-response, not counterexample).

## Lenard h14 — M5 candidate, needs the oracle

Lenard's truth has ZERO corridorBends on all 18 holes (annotation
incompleteness prior). h14's route bows right along a visible ribbon-like
band (support 0.78, bright), around h16's basket zone, while the straight
truth line cuts through that zone. Belief: the truth is missing a bend here;
confidence moderate. Escalated-bar work done: point-samples on both spans,
occluders excluded. Human verdict requested; do not score Lenard h14 as a
route failure until judged.

## UNTESTED PROPOSAL (not applied; knobs frozen)

Make support paint-specific instead of edge-generic — the existing task pair
covers both flavors: #22 contrast-keyed ribbon field with a color prior
toward the CX-004 paint composite (kills dark-parity), #21 one-sided edge
detector (kills zone-fill/bright-band edges that lack the paired-ribbon
profile, CX-008 lift +48/+33 vs walking path +17). Regression gates any fix
must pass: dev replay 72/72 exact, Rec probe 9/9, in-bounds ≥ 65/72 with the
7 cases individually re-measured, zero new violations.
