# Stage-aware Dev4 investigation — 2026-09-05

## Custody and permission

Source: supplied ChainSpot-Sweep-Ready-no-chromium bundle, manifest remoteHead 60f53cd9ae8ab210dc73aa884086e315dccbe0a2. All seven critical-file hashes matched. Workspace /mnt/data/ChainSpot-Sweep-Ready/chainspot. Node v22.16.0; npm 10.9.2. No dependency installation or code edits during contact. Working branch lab/stage-aware-dev4 starts at the manifest commit, not the subsequently advanced lab/dev-pathfinding branch.

Owner explicitly permits ground truth use in any way in THIS run. Truth-assisted measurements must still be distinguished from source-only ALG outputs. Do not claim copied annotations are detector success.

## Contact

Executed `timeout --signal=TERM --kill-after=2s 55s ./lab sweep --through S0 ../chainspot-corpus/dev/NorthPark/NorthPark-full.png`.
Opened actual artifacts/sweep/stages/NorthPark-full-through-S0/progression.png. S0.full-to-cropped / source.cropUDiscChrome preserves the recognizable map; 1290x2796 -> 1290x2111, upper 431 / lower 254 removed.

HUH: Maps attribution and MAP/SAT controls remain inside canonical pixels. Do not recrop later; investigate UI ownership/exclusion in the same frame. Bundled WORLD_BOOT requires Storybook, but current owner protocol explicitly allows Sweep. Used Sweep.

## Fresh S3 runs, not inherited claims

Executed `./lab sweep --through S3 --warm INPUT` on all six packaged dev images. Each action completed in roughly 5-6 seconds; upstream state and native panels are retained under artifacts/sweep/stage-experiments. Opened all six actual 07-tee-objects.png course-level outputs.

| Course | Badges | Baskets | Tees |
|---|---:|---:|---:|
| DashsTrack | 18 | 17 | 18 |
| Heritage | 18 | 15 | 14 |
| Lenard | 18 | 16 | 17 |
| TowneLake | 18 | 18 | 17 |
| AlexClark | 18 | 15 | 14 |
| NorthPark | 18 | 17 | 16 |

These are cardinalities, not semantic scores. DashsTrack has boxes over Maps/SAT letters and unboxed visible pads near H3/H5. Lenard has an unboxed partial pad near H12. NorthPark has a clear unboxed partial pad beside the basket near H18; H5's visible pad is boxed. No causal explanation is established merely by these observations.

The four fully annotated courses are DashsTrack, Heritage, Lenard, TowneLake. The supplied annotation ZIP also contains sparse AlexClark teaching data. NorthPark and AlexClark remain useful additional regression/visual cases.

## First seam

Discovered Stage contracts are S0-S3 only. Warm experiment lane is S3-only. Older threeFactor machinery has recovery/assignment/straight-test/routing implementations and tests, but is a separate execution path. Next: execute that existing full path across Dev4, inspect its actual output, audit stage-specific expectations before adapting later computations.

Questions: Does the grader confuse visible S3 output with all recovered/inferred tees? Does it grade only cardinalities or assignments too? Are crop-local annotation coordinates aligned through LAB? Can straight-hole/path reasoning consume partial local semantics before global assignment?

No Stage promoted or frozen. Frozen clean/ untouched.
