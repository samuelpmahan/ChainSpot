# Distractor attribution — straight-hole ray test + per-failure classification

Status: test defined here first (documentation-before-measurement); results
sections are filled in by `scripts/nuthing/straight-hole-test.ts`, a pure
replay over the cached pair matrix (no re-detection, no re-routing).

## The invariant under test

Extends the validated P3 invariant one step further. Known so far, both
measured on dev truth:

- the teepad's long axis points at its badge (median error 1.1°, p90 2.65°);
- the badge sits before any bend, at 0.19–0.54 of the way tee→basket.

**Corollary for STRAIGHT holes (no recorded corridor bends): the tee→badge
ray, extended, passes through the basket, and the recovered path should run
straight down the middle of the hole.** On a straight hole the corridor IS
the chord, so any place the recovered route leaves the chord is, by
construction, not the hole — it is a distractor pulling the route sideways.
That makes straight holes a clean *distractor detector*: deviation location
→ which render element grabbed the route.

Straight-hole coverage from corpus bend truth
(`/workspace/chainspot-corpus/dev/Annotated/*/…annotation.json`,
`corridorBends` empty):

| course | straight holes |
|---|---|
| DashsTrack | 9 (h3 h6 h9 h10 h11 h12 h13 h16 h17) |
| HeritagePark | 2 (h6 h17) |
| Lenard | **18 — every hole** (the weakest pairing course gets full coverage) |
| TowneLake | 15 (all but h7 h11 h16) |

## Measurements per straight hole (from cached evidence only)

1. **Ray test**: angle between direction(tee→badge) and
   direction(tee→basket) for the TRUE triple. Invariant prediction: ~0°.
   A hole that fails this while its neighbors pass indicates a badge or
   endpoint mislocalization, not a routing problem.
2. **Chord adherence**: for the true pair's cached route, the perpendicular
   distance profile from the tee→basket chord; report max deviation, where
   along the hole it peaks (fraction 0..1), and the arc length off-chord
   beyond a corridor half-width (~22 px, half the median annotated corridor
   width).
3. **Deviation attribution**: classify the peak-deviation point (and every
   off-chord span) against the cached endpoint/zone geometry, in priority
   order:
   - `basket-zone` — within a foreign basket's furniture: sprite ≤35 px of
     a sprite center, C1S ring 44±8, C2D ring 84±12 (from cached sprite
     tips/centers);
   - `tee-glyph` — within 15 px of a foreign tee candidate;
   - `diamond` — within 15 px of a diamond (path/ring marker) candidate
     (requires diamonds cached; else folded into `unknown`);
   - `badge` — within a badge bbox +6 px;
   - `unknown/walking-path` — none of the above; on this render stack the
     dominant remaining oriented linear structure is the dashed walking
     path (verified visually in earlier failure zooms).

## Per-failure distractor classification (the 7 wrong assignments)

For each hole the final stack (`--zones --simple --invariants --identity
--assign`) still assigns wrongly, classify what beat the truth: attribute
the CHOSEN (wrong) route's support the same way as above, and attribute the
TRUE pair's weak windows (what suppressed the truth). Current wrong set:

- HeritagePark h4, h7, h16
- Lenard h3, h9
- TowneLake h2, h3

(DashsTrack is 18/18 exact after the exchange-move assignment fix.)

## Results

_Filled by the test script; every number ships with an annotated overlay._

### Straight-hole ray test

TBD

### Straight-hole chord adherence + attribution

TBD

### Wrong-assignment classifications

TBD
