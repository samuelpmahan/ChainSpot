# The Scene-Reading Contract — DRAFT 1, for owner red pen

Status: DRAFT. Nothing builds against this until the owner has marked it up.
Motivation, in one paragraph: on DashsTrack, hole 2's true pairing was
out-scored by `tee-1 → basket-2` — a pairing that is geometrically
impossible under a renderer law measured nine days earlier (the badge
window), because the scorer evaluates corridor paint between arbitrary
endpoints and never uses the one segment the renderer guarantees. The same
season: Heritage H5's pad remnant was discarded by four layers for four
different reasons, a proximity prune built on a reward-hacked sample deleted
true pairings, and every threshold was a bell-curve tool aimed at data whose
designer's job is variety. This contract replaces detection-by-heuristic
with reading the rendered scene.

## W — World laws (each cited to its measurement; each number ratchet-governed)

- W1 **Pads are always painted.** One per hole; a hole count comes from the
  badges actually read, never a literal 18 (MVP corpus includes 20/21/22/27).
- W2 **The pad glyph is one fixed design**: hollow rectangle, bright rim,
  interior elongation ~2:1 (separates it from C2D diamonds at ~1:1).
- W3 **Everything that can cover or dim a pad is a known UI layer**: badge,
  basket sprite, C1/C2 rings and filters, screen chrome, and the hole-path
  ribbon/cap — translucent gray, per-course alpha 0.61–0.90, color
  ≈[150,155,145]; cap paint persists BEHIND the tee. A white rim under cap
  paint composites to ≈180s — dim pads are predicted, not anomalous.
- W4 **The pad's long axis aims at its own badge** (median 1.1°, p90 2.65°,
  recorded max 11.3° — Step-0 verification OWED on that max; the owner is on
  record predicting it is a bad rectangle fit).
- W5 **The badge projects onto the tee→basket chord at 0.17–0.54, always
  before any bend** (n=72, four courses).
- W6 **Straight holes: tee/badge/basket collinear to ≤1.4°** (median 0.5°).
- W7 **Zoom changes rendering prominence, not just scale** — every measured
  constant is per-zoom until cross-checked.
- W8 **Statistics law**: per-hole quantities are intentionally varied
  (150ft holes and 1700ft holes on one course is the product). No
  central-tendency-derived bound (median×k, mean±σ) over per-hole
  quantities, ever. Extremes-based checks and per-hole evidence only.

## C1 — The tee predicate (the owner's three clauses)

```
Tee(f, h) ⟺  PadPaintShaped(f)                                   -- could be a shard
           ∧ ¬∃q ∈ Outline(pose(f)): Contradicts(q)               -- no contradicting pixels
           ∧ padAxis(f) aims at badge(h)                          -- points at the damn hole number
where Contradicts(q) ⟺ confidently-not-paint(q) ∧ ¬∃L ∈ W3: Covers(L,q)
```

"Confidently not paint" is composite-aware: a pixel matching
`α·ribbonGray + (1−α)·padWhite` is EXPLAINED, not contradicting. No V
literal anywhere. The axis gate's limit is ratchet-governed and blocked on
the 11.3° verification.

## C2 — Pair feasibility precedes scoring

```
FeasiblePair(t, h, b) ⟺ projFrac(badge_h, chord t→b) ∈ [0.17, 0.54]   -- W5, ratcheted
                        ∧ padAxis(t) aims at badge_h                    -- W4
```

Infeasible pairs are never generated and never scored; the receipt counts
them per hole. This kills the off-by-one chain confusion (tee-n pairing
with basket-n±1) course-wide with zero distance reasoning.

## C3 — Trace, don't shop

Association = following the hole's own paint: leave the pad along its axis,
follow the corridor (bends allowed only after the badge, W5), terminate at
the cap/basket. The pairing is read off the ribbon; the score is the paint
continuity of THAT object. BTD chains and label sequence corroborate only —
never load-bearing (BTD is reliable only where things are already obvious).
No cost comparison across baskets anywhere in association.

## C4 — Fill-first residual solving

The solver's only job is genuine ties and abstentions:
maximize holes-assigned first, quality second. No distance terms. A hole
that ends empty prints one human sentence saying exactly which clause
failed and on what evidence.

## C5 — Receipts in human sentences

Per-hole receipt must read like a person explaining the hole ("H1: pad at
(x,y), axis at badge 1 within 1.4°, cap behind pad, paint continuous to
basket 1"). Winners print their full audits — no acceptance without a
receipt (the winner-exemption gap is how a fabricated distribution went
unchallenged). Every discarded candidate is named with the deciding rule
and measured values. Verbosity: confirm-level default, --dig for full.

## C6 — What dies

The proximity prune and geometric claims (all Euclidean matchmaking); every
median×k bound; `brightVMin=210`; the 1–18 caps; solver-derived hunt sets
and both 2.4a/2.4b mechanisms; "phantom" as a category (a dim pad is a
LOCATED pad with low evidence — the phantom budget survives only until
composite-aware detection is proven on AlexClark H12, its first test).

## C7 — Instruments and acceptance

- Instrument BEFORE fix: a scoreboard lane for this contract lands first
  and is untouchable by builder lanes.
- Acceptance cases: DashsTrack H1+H2 (receipts must read as human
  sentences); Heritage H5 (the L becomes a located pad); AlexClark H12 (dim
  detection); Lenard + truth courses arbitrate; byte-diff against baseline
  for every course that is already right.

## C8 — Ratchet rows opened by this contract

Window edges 0.17/0.54; axis max (pending Step-0 on 11.3°); alpha range
0.61–0.90; all verification-gated per docs/RATCHETS.md law — a bad
measurement is a measurement defect, never a threshold move.

## Lanes (per the delegate skill: OSS triangle, fences, waiting room)

1. Instrument lane (Sonnet): contract scoreboard + human-sentence receipt
   renderer. Lands first.
2. OSS-A (Opus + 2 Sonnets): C1 predicate + composite-aware paint model.
3. OSS-B (Opus + 2 Sonnets): C2 feasibility + C3 trace + C4 fill-first.
4. Step-0 verification lane (Haiku/Sonnet): the 11.3° hole, the window-edge
   holes, ratchet cell updates.
Fences: no lane touches the instrument; no lane moves a ratcheted number;
waiting-room merge; cross-review per the triangle.

## Owner decisions embedded here (mark up freely)

- The [0.17, 0.54] window edges: use as measured, or widen for safety
  margin pending Step-0 of the edge holes?
- Phantom budget: retire immediately or after H12 proves dim-detection?
- The frozen §2.5 gate: absorbed into C1's contradiction clause (its
  ownership-order bug and winner receipts fixed in OSS-A) — confirm.
