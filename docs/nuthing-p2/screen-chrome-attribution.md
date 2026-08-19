# Screen-chrome attribution — residual Apple Maps UI is not tee evidence

Status: experimental measurement on `claude/nuthing-p2-digit-recognition-zgs4lq`.

## Failure

The per-image viewport crop can leave a thin strip of Apple Maps UI at the bottom of an otherwise valid course raster. Individual white pieces inside that UI — especially the Apple/Maps attribution and the MAP/SAT control — can satisfy tee hollow-ring or component-fallback geometry.

Those are not interesting tee false positives. They belong to a known higher-level render family: screen-space chrome.

The fix is therefore attribution, not a tighter tee threshold.

## Rule

`src/lib/nuthing/screenChrome.ts` groups nearby bright components only inside the last `max(96 px, 5% of image height)` of the raster. Bboxes are expanded anisotropically (10 px horizontal / 2 px vertical) so text/control glyphs on one screen-space baseline join their parent UI control without swallowing course geometry above it.

A group is tagged as residual screen chrome only when all of these hold:

- at least 5 bright components;
- parent width >= 140 px;
- parent height 16..90 px;
- anchored to the left or right screen edge (within 32 px);
- anchored to the bottom edge (within 32 px), unless it is extremely wide (>=220 px).

A tee-like child whose center falls inside one of those parent regions is attributed to chrome and removed from the free tee candidate pool. This is deliberately not a blanket edge strip: real tees may sit near image edges.

## Five-course endpoint rerun

Behavior-equivalent local rerun against the current corpus rasters, with screen-chrome attribution applied before the free tee pool. The existing 57d6ac4 occlusion recovery is then applied, followed by the transparency-aware >=50%-normal-tee consensus supplemental tier for the Heritage H6 case.

| course | checked truth | raw tee candidates | chrome suppressed | free tee pool | baseline recall | after 57d6ac4 recovery | + transparency/consensus | unexplained recovery FP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| AlexClark | 3 | 34 | **13** | 21 | 3/3 | 3/3 | 3/3 | **0** |
| DashsTrack | 18 | 30 | **11** | 19 | 18/18 | 18/18 | 18/18 | **0** |
| Heritage | 18 | 54 | **8** | 46 | 15/18 | 17/18 | **18/18** | **0** |
| Lenard | 18 | 63 | **7** | 56 | 18/18 | 18/18 | 18/18 | **0** |
| TowneLake | 18 | 32 | **3** | 29 | 18/18 | 18/18 | 18/18 | **0** |

Totals on the four fully annotated 18-hole dev courses: chrome attribution removes **29** tee-like children and preserves baseline truth recall **69/72 -> 69/72**. With the existing H5/H10 occlusion recovery and the transparency-aware H6 consensus tier, endpoint availability is **72/72**.

Across all five rasters, **42** raw tee candidates are attributed to screen chrome.

AlexClark has all 18 holes visibly present, but the checked-in `dev/AlexClark/AlexClark-full.annotation.json` currently contains truth only for holes 1..3, so no 18/18 truth claim is made for Alex.

## Basket-overlap candidates are not counted as unexplained FPs

DashsTrack still produces two recovery hypotheses inside known basket footprints (one from the original bbox-occlusion fit and one from the transparency-aware supplemental fit). They are tagged basket-attributed, not free/unexplained tee candidates. This is intentional: Heritage proves that real tees can genuinely be hidden under baskets, so `inside basket bbox => reject` would destroy valid recovery.

The useful distinction is:

- `screen-chrome attributed` -> suppress from tee evidence;
- `basket attributed` -> retain/defer as an occluded-tee hypothesis for downstream pairing/invariant evidence;
- `unexplained` -> actual FP burden.

On this rerun the recovery stack has **0 unexplained new FPs** across the five courses.
