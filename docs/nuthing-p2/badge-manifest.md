# Badge observation manifest

Built by `scripts/nuthing/build-manifest.ts` from TS NuThing P1 badge observations over the deduplicated hydrated corpus (byte-identical `dev/Annotated/**` copies excluded). Two grounding channels: sha-verified annotation association (DashsTrack only — see below) and independent manual visual reads; disagreement or ambiguity stays UNRESOLVED. Fountain Hills is HELD_OUT: its manual reads are evaluation-only truth (`evalLabel`), never training labels.

| image | badges | grounded | unresolved | held-out | annotated holes |
|---|---|---|---|---|---|
| AlexClark-full | 16 | 16 | 0 | 0 | — |
| DashsTrack-full | 18 | 18 | 0 | 0 | 18 |
| FountainHills-1 | 10 | 0 | 0 | 10 | — |
| FountainHills-2 | 13 | 0 | 0 | 13 | — |
| FountainHills-full | 20 | 0 | 0 | 20 | — |
| FountainHills-lazy | 16 | 0 | 0 | 16 | — |
| HeritagePark-full | 14 | 14 | 0 | 0 | — |
| Lenard-1 | 7 | 7 | 0 | 0 | — |
| Lenard-2 | 7 | 7 | 0 | 0 | — |
| Lenard-3 | 4 | 4 | 0 | 0 | — |
| Lenard-4 | 6 | 6 | 0 | 0 | — |
| Lenard-5 | 7 | 7 | 0 | 0 | — |
| Lenard-full | 16 | 16 | 0 | 0 | — |
| NorthPark-full | 16 | 16 | 0 | 0 | — |
| TowneLake-full | 18 | 18 | 0 | 0 | — |

Provenance classes: {"REAL_GROUNDED":129,"HELD_OUT":59}

Grounded label histogram: 1×9, 2×6, 3×7, 4×8, 5×4, 6×8, 7×7, 8×8, 9×7, 10×7, 11×8, 12×5, 13×7, 14×8, 15×7, 16×8, 17×8, 18×7

## Grounding channels and what the audit found

1. **Annotation association** (sha-verified frames only). The preferred basket chain was measured first; on the one annotation whose sourceImage.sha256 matches its corpus raster (DashsTrack) the corridor **path midpoint** is the badge anchor (accepted claims at 5–70px with 60px+ margins), and nearest-basket association is strictly more ambiguous. The Heritage/Lenard/TowneLake annotations were made on different captures (1290×2012–2115 vs 1290×2796, sha MISMATCH) and AlexClark’s older schema has no sha: ungated association against those frames produced labels that a visual audit showed to be 13/13 **wrong**, so annotation grounding is hard-gated on the sha match.
2. **Manual visual reads** of every raw badge crop (`resources/nuthing-p2/manual-badge-labels.json`), independent of any classifier. On DashsTrack the two channels agree 14/14. Fountain Hills reads are stored as `evalLabel` (evaluation-only truth) and are never training labels.