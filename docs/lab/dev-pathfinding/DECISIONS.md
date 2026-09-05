# Dev6 pathfinding — decision journal

## 2026-09-05 — checkpoint custody

Base: `lab/world` at `8d6ca111e6ff5a095950e228b61395dae29e2856`.
Working branch: `lab/dev-pathfinding`. Checkpoint pushed with GitHub as `59cf3a9b9bc13395c64560574f4d61ab5f59083a`.
Corpus reference: `samuelpmahan/chainspot-corpus` at `2b5913d3f1f6d8f97b0324721a4c5201bd3ed819`, `dev/`.

HUH: expected the preceding working checkout and dev-checkpoint receipt to survive, encountered selected source files, source images, rendered investigation images, the S3 contact packet, and the original packaged workspace. No new implementation or full Dev6 checkpoint receipt was recoverable locally. Do not describe lost work as committed code.

Restored the packaged workspace using its own bootstrap script. Fetched lab/world HEAD still matches the package. `tidy check` passes S0–S3 0.1.0. A pre-existing package-lock.json change and bootstrap logs are excluded from investigation commits. Shell git fetch cannot resolve github.com; GitHub connector writes work. Keep the source checkpoint on the isolated branch, not lab/world.

## Owner constraints

- Molecule means composition whose structure carries semantic meaning, not merely a UI component.
- Keep useful PxC pixels/objects/measurements warm; expose reusable semantic/statistical calculations; no stale code/input reuse.
- Experiments outside clean/. Preserve default computation and rejected experiments.
- Owner constraint: tee major-axis ray through centroid should pass within 5 degrees of its badge. Inspect measurement/annotation before rejecting that constraint. A useful angle alone does not establish identity.
- A basket can completely cover the next tee. No visible remnant means no claimed visual recovery. Separate inferred and observed endpoints.
- Course variety makes median-distance assumptions suspect.
- Alpha/antialiasing and exact owned-pixel subtraction matter. A basket bbox is not an ownership mask.
- Inspect every course and failure crop; separate observations from causal hypotheses.
- Goal: every ALG stage on dev/, then non-vacuous inboundsPathfinding. Geometric Perfection and Kerchoooo remain separate forks. No promotion before corpus proof.

## Visual inspection — retained source-overlaid S3 views

Opened all six retained full-course tee overlays in this session. These are prior artifacts, not new execution proof. New receipts must re-establish counts.

| Course | Visible observation | Causal question, not yet a conclusion |
| --- | --- | --- |
| AlexClark | Several visible white pads have no purple detection box, including the upper-left pad between baskets and the pad beside the basket near badge 17. Badge 18 overlaps a crowded basket group. | Was the pad lost before enclosed-ring discovery, at frame measurement, or at family selection? |
| DashsTrack | Purple tee boxes occur on letters in Maps and SAT. White pads near badge 3 and badge 5 are unboxed; nearby dashed circles intersect pad outlines. | Chrome identity and circle/tee connectivity must be inspected separately; count alone hides false positives and misses. |
| Heritage | Pads are substantially smaller in raster pixels than on the other courses. Several badges/baskets overlap; a faint pad near badge 15 is difficult to judge at overview scale. | Fixed raster-size/frame gates or alpha may explain loss; no median hole length inference. |
| Lenard | An unboxed white remnant is visible left of the basket near badge 12. Several baskets overlap. | Is the remnant identifiable after exact basket subtraction? |
| NorthPark | The pad near badge 5 is visibly boxed. A white unboxed remnant is visible beside the basket near badge 18. | Tee 5 is not a recovery target. Inspect the actual remnant and preserve per-pixel ownership. |
| TowneLake | Badge 2 overlaps a basket group; one potential pad remnant is hard to distinguish there. Many intact pads are boxed. | Inspect occlusion before making any claim of invisible or missing geometry. |

## Next experiment — retain state and expose the existing selector

Decision: add an opt-in LAB Stage lane with a disk-backed snapshot of the declared S0–S2 addresses. Use existing production Stage contracts and real gateway calculation functions. Restore a fresh PxC for each candidate to prevent cross-experiment mutation. The cache key must include input bytes, source identity, compiled ALG bytes, dependency lockfiles, runtime identity, and the snapshot adapter implementation. Do not serialize calculation closures: downstream Stages register their own functions.

Expose the already-written `S3/exp/fill-consistent` selector, preserving clean/ exactly. Compare selected frame membership over Dev6. This is a selector experiment, not recovery and not a declaration that the modal family is true. Falsifier: visible real pads are removed or chrome retained; fewer candidates alone is not success.

A warm snapshot is a retained declared-address bundle, not a claim that every hidden PxC address or closure is persisted. Binary values are cache/artifact data; source, notes, commands, and compact receipts belong in Git.

## Isolation falsifier caught and fixed

The initial restore implementation called V8 deserialize on the same serialized buffer for two candidates. The mutation test failed: changing one candidate's Uint8Array changed the second candidate. V8 can return views backed by the serialized buffer. Restore now copies the buffer before deserializing; the test and alias-within-one-candidate test both remain required. This is why frozen source hashes alone are not a baseline-isolation proof.

The first test attempt ran no tests because the package lacks generated .svelte-kit/tsconfig.json. Ran the existing svelte-kit sync command (no dependency installation); the next attempt exposed the real isolation failure above.

## Whole-course selector comparison and downstream contact

All six clean and fill-consistent S3 runs completed. A shell time limit interrupted the first .lab invocation after Lenard; the four-command retained resume Script completed NorthPark and TowneLake. NorthPark's prefix cache had already been written before that time limit; the completed receipt correctly reports cache hit, not a new prefix execution.

ONE-SHOT WARRANT: compare membership and artifact bytes across the twelve retained Stage receipts | LAB gap: no registered cross-run Stage comparator yet. Use receipts/retained arrays only; no detector reimplementation. Keep the resulting census in this directory.

| Course | Badges | Baskets | Clean Tees | Fill-consistent Tees |
| --- | ---: | ---: | ---: | ---: |
| AlexClark | 18 | 15 | 14 | 14 |
| DashsTrack | 18 | 17 | 18 | 18 |
| Heritage | 18 | 15 | 14 | 14 |
| Lenard | 18 | 16 | 17 | 17 |
| NorthPark | 18 | 17 | 16 | 16 |
| TowneLake | 18 | 18 | 17 | 17 |

Decision: retain fill-consistent but do not promote. The extra dimension produces no selected-frame change on these inputs. DashsTrack's count of 18 includes Maps/SAT glyph false positives and is not completion. Recovery and pathfinding were not executed by these S3 runs.

Executed the existing default production plan on NorthPark using `northpark-legacy.lab`. It reports 18 baskets, 16 visible tees, two recovered tees, and 18 tee-to-badge locks. Opened its actual `renders/run/run.visual.png`: H14's cyan route runs off the course into the housing area at the top of the raster. The receipt also flags very low assignment scores for H14 and H5. This is a concrete counterexample to accepting cardinality as correctness.

Source inspection: `routing.ts` builds finite soft traversal costs and explores every in-image neighbor; its flood has no hard legal-path mask. That is an implementation boundary, not a claim that adding a mask would fix object identity or produce a semantically correct mask. `teeRecovery` testimony reports considering whole-raster unowned bright components. A constrained fitted axis does not independently prove those pixels are a tee.

Next active question: identify and reject the spurious recovered H14 endpoint from grounded object/path evidence without losing the genuine basket-adjacent remnant. The owner's 5-degree ray check remains a useful measurement constraint; do not use a fit constrained by that same ray as independent identity evidence. No median-distance filter and no forced invisible endpoint.


## WIP archive before continuation — 2026-09-05 04:22 CDT

Created `/mnt/data/ChainSpot-dev-pathfinding-WIP-20260905-0422.zip` outside the checkout before any further edits or pushes: 85,631 bytes, 13 actual changed/untracked source/document/config/test files plus Git status, HEAD, full binary-safe unstaged-and-staged diff, cached diff, and an archive manifest. ZIP listing/CRC checks passed and every archived source file matched the working bytes. SHA-256: `c2effc1a862b3ba1e2404fecfadda63ea637c7655ce0ab9a4c015150c77e56aa`.

HUH: the local packaged checkout still reports HEAD `8d6ca111`, while connector-created remote checkpoint is `59cf3a9`. Both are recorded in the archive; the complete current DECISIONS.md and other local files are retained as a safe superset, not a falsely labeled diff against a locally unavailable commit. The lockfile drift is included in the archive for custody but remains excluded from the source push.

After verifying the archive, reran the ALG build, the five focused test files (42 tests), and `tidy check`: all passed. No frozen S0–S3 source change. Source push should land the actual warm-PxC/experimental adapter and replay Scripts, not only this journal. The full suite, complete dev/ zoom coverage, recovery correctness, and legal-path completion are not established by these checks.
