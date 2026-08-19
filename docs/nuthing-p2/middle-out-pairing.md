# Middle-out pairing — current state (in progress)

Goal: from each badge (hole number known via digits), pick the hole's own
tee and basket among the ribbon-reachable candidates.

Current consolidated pipeline (scripts/nuthing/middle-out-pair-eval.ts):
production auto-crop -> badge stage -> digit reading -> ribbon support field
(with per-pixel winning orientation) -> orientation-gated C2D dashed-ring
suppression in the middle-out cost channel only (per Linear doc
"Basket-Zone Rendering Layers"; tangential ring pixels walled, radial
ribbon crossings stay open) -> candidate hygiene (badge digit glyphs
excluded - they mimic tee rectangles) -> per-badge flood pools ->
chain DP over digit-ordered holes (assignCourseEndpointsChain).

Dev truth results (tolerance 10px, at registered-truth precision):

| course | pair correct | pool recall |
|---|---|---|
| DashsTrack | 13/18 | 18/18 |
| HeritagePark | 7/14 | 14/14 |
| Lenard | 12/16 | 16/16 |
| TowneLake | 17/18 | 18/18 |
| **total** | **49/66** | **66/66** |

Measured-and-rejected variants (kept for the record):
- greedy per-badge nearest / balance-led / midpoint-only pairing: 21-42/66;
- blanket C2D+C1S annulus cost walls: 14/66 (walls sever baskets);
- support-gated C2D-only wall: 29/66 (ribbon ends live on the ring);
- chain-DP + cheapest-claimant uniqueness banning: 43/66;
- chain-DP + regret banning: 45/66 (TowneLake 18/18, Lenard 14/16, but
  Heritage collapses - its badges anchor near tees, so its true claims are
  expensive and lose regret fights).

Open problem: cross-hole uniqueness. The remaining failures are dense-
cluster double-assignments (a component serving two holes) and their
knock-ons; both banning strategies tried so far lose more than they fix.
Failure lists print with every oracle run; annotated overlays land next to
the numbers per run.
