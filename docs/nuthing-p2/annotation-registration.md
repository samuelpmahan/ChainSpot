# Annotation registration into the corpus raster frame

Heritage/Lenard/TowneLake annotations were drawn on vertically-cropped variants of the corpus screenshots. Similarity transforms (uniform scale + translation) fitted from labeled correspondences — hole path midpoint (annotation frame) ↔ badge center whose digits read that hole number (raster frame) — with iterative outlier trimming. Label corroboration uses leave-one-out refits so the target hole never influences the transform that tests it.

## HeritagePark-full

Transform: scale 1.0080, t=(-14.0, 418.1); 14/14 inlier correspondences, residual median 41.0px, max 82.7px. Outlier holes: none.

Leave-one-out label corroboration: 6/14 holes associate (d<=40px, margin>=40px) to the badge whose manual read equals the hole number. h1: d=54 m=126; h4: d=65 m=135; h5: d=49 m=158; h7: d=97 m=66; h8: d=60 m=125; h9: d=59 m=48; h11: d=54 m=111; h18: d=44 m=143

Tee truth coverage (registered coordinates vs candidate pool):
- ABSENT: 14, CULLED: 4 of 18 holes
- hole 1: ABSENT
- hole 2: ABSENT
- hole 3: CULLED (rank 1032, score 0.000)
- hole 4: ABSENT
- hole 5: CULLED (rank 760, score 0.004)
- hole 6: CULLED (rank 993, score 0.000)
- hole 7: ABSENT
- hole 8: ABSENT
- hole 9: ABSENT
- hole 10: CULLED (rank 684, score 0.023)
- hole 11: ABSENT
- hole 12: ABSENT
- hole 13: ABSENT
- hole 14: ABSENT
- hole 15: ABSENT
- hole 16: ABSENT
- hole 17: ABSENT
- hole 18: ABSENT

## Lenard-full

Transform: scale 1.0002, t=(-1.3, 428.7); 16/16 inlier correspondences, residual median 3.5px, max 5.2px. Outlier holes: none.

Leave-one-out label corroboration: 16/16 holes associate (d<=40px, margin>=40px) to the badge whose manual read equals the hole number. 

Tee truth coverage (registered coordinates vs candidate pool):
- ABSENT: 17, CULLED: 1 of 18 holes
- hole 1: ABSENT
- hole 2: ABSENT
- hole 3: CULLED (rank 478, score 0.013)
- hole 4: ABSENT
- hole 5: ABSENT
- hole 6: ABSENT
- hole 7: ABSENT
- hole 8: ABSENT
- hole 9: ABSENT
- hole 10: ABSENT
- hole 11: ABSENT
- hole 12: ABSENT
- hole 13: ABSENT
- hole 14: ABSENT
- hole 15: ABSENT
- hole 16: ABSENT
- hole 17: ABSENT
- hole 18: ABSENT

## TowneLake-full

Transform: scale 1.0012, t=(-1.9, 529.6); 15/18 inlier correspondences, residual median 3.7px, max 5.4px. Outlier holes: 7, 11, 16.

Leave-one-out label corroboration: 15/15 holes associate (d<=40px, margin>=40px) to the badge whose manual read equals the hole number. 

Tee truth coverage (registered coordinates vs candidate pool):
- ABSENT: 18 of 18 holes
- hole 1: ABSENT
- hole 2: ABSENT
- hole 3: ABSENT
- hole 4: ABSENT
- hole 5: ABSENT
- hole 6: ABSENT
- hole 7: ABSENT
- hole 8: ABSENT
- hole 9: ABSENT
- hole 10: ABSENT
- hole 11: ABSENT
- hole 12: ABSENT
- hole 13: ABSENT
- hole 14: ABSENT
- hole 15: ABSENT
- hole 16: ABSENT
- hole 17: ABSENT
- hole 18: ABSENT