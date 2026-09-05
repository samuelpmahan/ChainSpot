# NorthPark recovered endpoint — identity and label reconciliation

Date: 2026-09-05. Source checkpoint: `9a6a69e1e5c6568fe1875faa8d303f7de4677824`.
No detector change, threshold change, or promotion in this observation.

## Correction to the overview interpretation

HUH: expected one coherent H14 route, encountered an overview that draws tee–badge lock polylines but labels endpoints from final assignment. The same objects disagree between those two records:

| Tee ID | Tee–badge lock hole | Final assignment hole | Lock axis error |
| --- | --- | --- | --- |
| tee-recovered-0 | 5 | 14 | UNKNOWN; angleRad null; ray degraded |
| tee-9 | 14 | 5 | 2.372873578562073 degrees |

RETRACT the earlier description of the cyan line as H14's final route. The orange H14 endpoint label is from final assignment; that long cyan path is the H5 tee–badge lock. This does not vindicate the endpoint or either association.

The retained H5 lock starts at canonical route-grid point `(837,60)` and ends at `(1074,1368)`. It has 445 polyline points and `rayDegraded=true`. This anchor is the sampled route start, not a claim to be the exact fitted tee centroid or owned-pixel set.

## Visual contact

Executed the existing LAB Scope command, without Annotation truth:

```bash
./lab scope '../chainspot-corpus/dev/NorthPark/NorthPark-full.png' 837,60 --name recovered-0 --context 300 --context-out 400 --full-out 400 --local-out 320 --fw 96 --fm 48 --ft 24 --forensic-out 192 --no-grid --out /mnt/data/northpark-recovered-0-scope.png
```

Scope reports `BLIND`, canonical `1290x2111`, StripChrome `single-phone-entropy`. Opened the actual image. The route-start neighborhood is satellite photography of residential roofs/yards; no recognizable drawn tee outline is visible in this crop. Treat the endpoint as unsupported photographic structure pending an exact owned-pixel recovery render, not as a geometrically established tee.

HUH: recovery reports fitted-axis measurements, but the downstream lock consumes this recovered endpoint with `angleRad null`, `axisErrorDeg UNKNOWN`, and corroboration-only scoring. Trace the publication/consumption of recovered orientation before proposing another geometric filter. Do not use an angle constrained by the badge ray as independent proof of pixel identity.

## Evidence and next discriminating action

Existing run directory: `artifacts/sweep/dev6-106-default/NorthPark-full/`.

- `artifacts/measurementTable/teeBadgeLock.evidence.bin`: JSON, locks and candidates.
- `run.receipt.json`: final assignments; recovered-0 -> H14 has score `0.000007094832779337275`, rank 127.
- `renders/run/run.visual.receipt.txt`: declares polylines from locks and orange numbers from final assignment.
- `/mnt/data/northpark-recovered-0-scope.png`: verified readable Scope percept.

Next: TRACE recovered pose/ownership and orientation into TeeEvidence and lock scoring; retain the genuine basket-adjacent remnant as a separate case. No median-distance cutoff, no fabricated tee, and no legal-path success claim.
