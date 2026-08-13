#!/usr/bin/env python3
"""Truth-scored spike for conservative basket ownership via ribbon flood fill.

Question: if basket *detection* is already good, can the ribbon component graph
lock obvious basket->hole ownership before global course grammar, while
abstaining on shared/split components?

This intentionally uses truth basket coordinates as an UNLABELED, shuffled
candidate pool. Truth is used only after association to score whether a lock
was correct. The association itself sees only:
  - labeled hole-number badge positions
  - unlabeled basket candidate positions
  - the image-derived ribbon connected components

Safe lock rule:
  one connected component touches exactly one numbered badge AND exactly one
  basket candidate -> lock that candidate to that hole.
Anything shared/split/no-hit is left unresolved for the existing grammar/UI.

Usage:
  python scripts/cv-probes/basket_floodfill_ownership.py
"""
from __future__ import annotations

import io
import json
import random
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.optimize import linear_sum_assignment
from skimage.color import rgb2lab
from skimage.measure import label as cc_label

REPO = Path(__file__).resolve().parents[2]
SCALE = 3
BOX_MEAN = 41
EVIDENCE_DL = 10.0
OPEN_SIZE = 7
EVIDENCE_THRESH = 0.2
SEED_RADIUS_PX = 40.0
BADGE_HALF_W = 40.0
BADGE_HALF_H = 30.0

GOLDEN_TRUTH = [
    (1,884.8377,431.9287,520.9098,426.5199),(2,458.1891,572.3709,764.8910,561.3106),
    (3,736.6058,714.6226,495.1454,627.0996),(4,430.7484,644.5234,432.3185,863.8528),
    (5,491.5658,853.0390,685.3405,796.3448),(6,680.3815,850.5247,438.8389,914.8063),
    (7,368.6596,982.3337,618.8090,950.4393),(8,514.9311,1010.8689,423.5378,1176.3405),
    (9,372.5817,1181.7863,306.8775,1413.0335),(10,260.3491,1463.0892,138.4361,1640.5877),
    (11,73.5681,1827.7354,391.3429,1807.8274),(12,419.2121,1770.3038,339.1161,1531.0674),
    (13,446.8826,1472.9553,688.7793,1590.6311),(14,680.1007,1506.8815,816.6161,1323.6636),
    (15,875.1573,1361.7654,1034.4052,1084.9288),(16,1156.1751,1179.2848,1128.1243,763.6529),
    (17,1069.9746,852.7679,872.8860,986.5966),(18,788.5811,850.3708,1000.1877,438.4488),
]
GOLDEN_BADGES = [
    (1,755,449),(2,578,582),(3,607,670),(4,444,744),(5,551,813),(6,551,885),
    (7,444,983),(8,461,1068),(9,338,1304),(10,195,1555),(11,241,1818),(12,375,1644),
    (13,572,1535),(14,704,1426),(15,906,1277),(16,1140.5,966),(17,965,922),(18,862.5,778),
]
ALEX_TRUTH = [
    (1,621,1601,773,1327),(2,636,1289,495,1396),(3,366,1742,296,2002),(4,373,2055,607,1946),
    (5,486,1888,763,1896),(6,677,1847,433,1583),(7,460,1410,512,1167),(8,449,867,526,572),
    (9,431,665,355,371),(10,384,306,439,566),(11,543,510,456,275),(12,459,234,607,94),
    (13,735,74,1018,286),(14,914,311,751,110),(15,706,114,674,335),(16,605,445,864,795),
    (17,681,706,491,873),(18,514,1025,582,1199),
]
ALEX_BADGES = [
    (1,696,1455),(2,559,1346),(3,327,1883),(4,493,2005),(5,621,1899),(6,580,1780),
    (7,485,1283),(8,490,716),(9,390,511),(10,412,438),(11,497,389),(12,536,161),
    (13,821,107),(14,827,203),(15,686,229),(16,649.5,574),(17,576,790),(18,547.5,1113),
]
COURSES = [
    ("GoldenTeeSet", REPO / "resources/GoldenTeeSet.chainspot.zip", GOLDEN_TRUTH, GOLDEN_BADGES),
    ("AlexClarkSet", REPO / "resources/AlexClarkSet.chainspot.zip", ALEX_TRUTH, ALEX_BADGES),
]


def load_source(path: Path) -> Image.Image:
    with zipfile.ZipFile(path) as zf:
        data = zf.read("images/source-original.jpg")
    return Image.open(io.BytesIO(data)).convert("RGB")


def segment_ribbon(image: Image.Image, badges):
    w, h = image.size
    ev_w, ev_h = w // SCALE, h // SCALE
    small = image.resize((ev_w, ev_h), Image.Resampling.LANCZOS)
    rgb = np.asarray(small, dtype=np.float32) / 255.0
    lightness = rgb2lab(rgb)[..., 0]
    mean = ndi.uniform_filter(lightness, size=BOX_MEAN, mode="reflect")
    evidence = np.clip((lightness - mean) / EVIDENCE_DL, 0.0, 1.0)
    for _n, bx, by in badges:
        x0 = max(0, int((bx - BADGE_HALF_W) / SCALE))
        x1 = min(ev_w, int((bx + BADGE_HALF_W) / SCALE) + 1)
        y0 = max(0, int((by - BADGE_HALF_H) / SCALE))
        y1 = min(ev_h, int((by + BADGE_HALF_H) / SCALE) + 1)
        evidence[y0:y1, x0:x1] = 1.0
    opened = ndi.grey_opening(evidence, size=(OPEN_SIZE, OPEN_SIZE), mode="reflect")
    return cc_label(opened >= EVIDENCE_THRESH, connectivity=2)


def nearest_label(labels, x_src: float, y_src: float, radius_px: float = SEED_RADIUS_PX):
    h, w = labels.shape
    xi, yi = int(x_src / SCALE), int(y_src / SCALE)
    if not (0 <= xi < w and 0 <= yi < h):
        return None
    if labels[yi, xi] != 0:
        return int(labels[yi, xi])
    r = max(1, round(radius_px / SCALE))
    y0, y1 = max(0, yi-r), min(h, yi+r+1)
    x0, x1 = max(0, xi-r), min(w, xi+r+1)
    window = labels[y0:y1, x0:x1]
    ys, xs = np.nonzero(window)
    if len(xs) == 0:
        return None
    d2 = (xs-(xi-x0))**2 + (ys-(yi-y0))**2
    j = int(np.argmin(d2))
    return int(window[ys[j], xs[j]])


def exclusive_associations(labels, badges, basket_candidates):
    badge_by_component: dict[int, set[int]] = {}
    baskets_by_component: dict[int, list[int]] = {}
    badge_misses = []
    basket_misses = []
    for n, x, y in badges:
        lbl = nearest_label(labels, x, y)
        if lbl is None:
            badge_misses.append(n)
        else:
            badge_by_component.setdefault(lbl, set()).add(n)
    for candidate_index, (_truth_hole, x, y) in enumerate(basket_candidates):
        lbl = nearest_label(labels, x, y)
        if lbl is None:
            basket_misses.append(candidate_index)
        else:
            baskets_by_component.setdefault(lbl, []).append(candidate_index)

    locked = []
    ambiguous_components = []
    for lbl in sorted(set(badge_by_component) | set(baskets_by_component)):
        holes = sorted(badge_by_component.get(lbl, set()))
        candidates = baskets_by_component.get(lbl, [])
        if len(holes) == 1 and len(candidates) == 1:
            locked.append((holes[0], candidates[0], lbl))
        elif holes and candidates:
            ambiguous_components.append((lbl, holes, candidates))
    return locked, ambiguous_components, badge_misses, basket_misses


def distance_baseline(badges, basket_candidates):
    holes = [n for n, _x, _y in badges]
    costs = np.array([
        [np.hypot(bx-x, by-y) for _truth_hole, x, y in basket_candidates]
        for _n, bx, by in badges
    ])
    rows, cols = linear_sum_assignment(costs)
    assigned = {holes[r]: basket_candidates[c][0] for r, c in zip(rows, cols)}
    return sum(assigned[n] == n for n in holes), assigned


def run_course(name, path, truth, badges):
    image = load_source(path)
    labels = segment_ribbon(image, badges)
    # Unlabeled detector pool: shuffle truth basket locations so candidate order
    # cannot leak hole identity into the association.
    candidates = [(n, xb, yb) for n, _tx, _ty, xb, yb in truth]
    random.Random(20260813).shuffle(candidates)
    locked, ambiguous, badge_misses, basket_misses = exclusive_associations(labels, badges, candidates)
    wrong = []
    for hole, candidate_index, lbl in locked:
        truth_hole = candidates[candidate_index][0]
        if truth_hole != hole:
            wrong.append((hole, truth_hole, candidate_index, lbl))
    baseline_correct, baseline_assignments = distance_baseline(badges, candidates)
    return {
        "course": name,
        "nHoles": len(truth),
        "distanceOnlyCorrect": baseline_correct,
        "locked": len(locked),
        "lockedCorrect": len(locked) - len(wrong),
        "lockedWrong": len(wrong),
        "lockedHoles": [hole for hole, _candidate, _lbl in locked],
        "wrongLocks": wrong,
        "ambiguousComponents": len(ambiguous),
        "badgeSeedMisses": badge_misses,
        "basketSeedMisses": basket_misses,
        "remainingForGrammar": len(truth) - len(locked),
        "distanceOnlyAssignments": baseline_assignments,
    }


def main():
    results = [run_course(*course) for course in COURSES]
    print(json.dumps(results, indent=2, sort_keys=True))
    # This spike is only worth porting if its locks are zero-false-accept on
    # both independent courses and it resolves at least one hole on each.
    if any(r["lockedWrong"] != 0 or r["locked"] == 0 for r in results):
        raise SystemExit("FAIL: flood-fill ownership is not conservative enough to port")
    print("PASS: all exclusive flood-fill locks are correct on both fixtures")


if __name__ == "__main__":
    main()
