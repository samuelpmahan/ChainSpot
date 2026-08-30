# Gate reorganization (owner directive, 2026-08-29)

Binding successor to the G4-G7 semantics used until today. G0-G3 are
unchanged (intake, badges, baskets, visible tees). The old model's
"G4 = assume all endpoints found" and "G6 = assignment as matchmaking"
are retired.

| Gate | Responsibility | Output |
|---|---|---|
| G4 | Tee → badge, including rail/shard recovery. No basket assignment. | Unique TeeBadgeClaim or named abstention |
| G5 | Straight-hole test; resolve straight badge → basket paths using pathfinder evidence only. | Straight routes + unresolved holes |
| G6 | Pathfind unresolved bent badge → basket routes. | Coarse bent routes |
| G7 | Refine and simplify bend geometry. | Final hole paths |

## What this settles (plain words)

- A hole is claimed by direction before it is completed by route: the pad
  points at its badge (G4), and only then do we ask where the painted path
  goes (G5/G6).
- The old G4↔G6 circularity (recovery consuming assignment to know which
  badges were unserved) dissolves: recovery lives inside G4 and consumes
  badges + rays + shard/rail evidence only. Baskets never inform tee
  recovery.
- Basket assignment as a scored matchmaking market (enumerate pairs, grade
  connections between assumed endpoints) is retired as the shipping
  mechanism. The basket is the terminus of a followed path (CL-6b of the
  compass-lane contract): G5 resolves the straight ones cheaply, G6 traces
  the bent ones, G7 cleans the geometry.
- "Straight" is a per-hole outcome of G5's test, never an assumption; holes
  G5 cannot resolve are handed to G6 by name (the unresolved list is
  receipt output, not silence).

## Migration notes (not itself a build order)

- The compass-lane contract's stage A (ray-first tee→badge) is the
  mechanism of the new G4; its stage B path-follower is the mechanism
  family of G5/G6.
- The rail/shard recovery landed from experiment/g4-shard-ray-only
  (clean prefix through cd77412) is new-G4 content.
- Existing units (assignment.*, straightTest, teeBadgeLock, zfit) keep
  running under their current names until a migration lane re-homes them;
  no silent behavior change rides in under a rename. Slicing (--through GN)
  follows the new table once the migration lane lands.
- The custody ledger keeps working across the reorg: chains reference
  producers by name, and gaps stay honest about anything the migration
  forgets.
