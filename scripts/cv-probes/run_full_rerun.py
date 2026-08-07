#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import static_course_parser as v1
import number_badge_classifier as number_classifier
import semantic_exact_anchor as semantic

IMAGE = Path("/mnt/data/36F73C46-5CD9-4311-819B-89910FC75145.jpeg")
TEMPLATES = HERE / "templates"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

image = cv2.imread(str(IMAGE))
if image is None:
    raise RuntimeError(f"could not decode {IMAGE}")
gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

scale, hole_one_score = v1.ui_scale_from_hole_one(gray, TEMPLATES)
numbers = number_classifier.detect_numbers(gray, TEMPLATES, scale)
baskets = v1.detect_baskets(gray, TEMPLATES, scale, (400, 1350))
tees = v1.detect_tees(image, scale, (400, 1350))

if len(numbers) != 18 or len(tees) != 18 or len(baskets) != 18:
    raise RuntimeError(
        f"expected 18/18/18 detections, got "
        f"{len(numbers)}/{len(tees)}/{len(baskets)}"
    )

# Keep the same B18 seed used by the previous reverse-sequencing experiment.
legacy_tee = v1.assign_tees(numbers, tees)
legacy_basket = v1.assign_baskets(numbers, tees, legacy_tee, baskets)
seed_b18 = legacy_basket[18]

# Better sequencing heuristic:
# UDisc puts the number badge CENTER on the hole CENTERLINE.
#
# Therefore, when selecting endpoints for a hole, tee and basket should make a
# plausible path THROUGH that exact point. We choose the tee + basket jointly
# rather than first assigning tees globally and letting baskets inherit errors.
#
# Cost terms:
#   - tee distance from own number center
#   - basket distance from own number center
#   - strong penalty unless tee/basket lie on opposite sides of number center
#   - small sequencing term: B(n) should be reasonably near T(n+1)
#
# We still walk 18 -> 1 and preserve one-use-per-endpoint on this fixture.
unused_tees = set(range(len(tees)))
unused_baskets = set(range(len(baskets)))
tee_assignment: dict[int, int] = {}
basket_assignment: dict[int, int] = {}
selection_costs: dict[int, dict] = {}

NEXT_TEE_TRANSITION_WEIGHT = 1.0
OPPOSITE_SIDE_WEIGHT = 120.0

for number in range(18, 0, -1):
    marker = numbers[number]
    number_point = np.array([marker["cx"], marker["cy"]], dtype=float)

    basket_candidates = [seed_b18] if number == 18 else sorted(unused_baskets)

    best = None
    for basket_index in basket_candidates:
        if basket_index not in unused_baskets:
            continue

        bx, by = v1.basket_base(baskets[basket_index])
        basket_vector = np.array(
            [bx - marker["cx"], by - marker["cy"]],
            dtype=float,
        )
        basket_distance = float(np.linalg.norm(basket_vector))

        transition_distance = 0.0
        if number < 18:
            next_tee = tees[tee_assignment[number + 1]]
            transition_distance = math.hypot(
                bx - next_tee["cx"],
                by - next_tee["cy"],
            )

        for tee_index in sorted(unused_tees):
            tee = tees[tee_index]
            tee_vector = np.array(
                [tee["cx"] - marker["cx"], tee["cy"] - marker["cy"]],
                dtype=float,
            )
            tee_distance = float(np.linalg.norm(tee_vector))

            cosine = float(
                tee_vector.dot(basket_vector)
                / (tee_distance * basket_distance + 1e-9)
            )
            opposite_side_penalty = OPPOSITE_SIDE_WEIGHT * (cosine + 1.0)

            cost = (
                tee_distance
                + basket_distance
                + opposite_side_penalty
                + NEXT_TEE_TRANSITION_WEIGHT * transition_distance
            )

            candidate = (
                cost,
                basket_index,
                tee_index,
                {
                    "teeDistanceFromNumberPx": tee_distance,
                    "basketDistanceFromNumberPx": basket_distance,
                    "teeBasketCosineAtNumber": cosine,
                    "oppositeSidePenalty": opposite_side_penalty,
                    "basketToNextTeePx": transition_distance,
                    "total": cost,
                },
            )
            if best is None or candidate[:3] < best[:3]:
                best = candidate

    if best is None:
        raise RuntimeError(f"no endpoint pair remained for hole {number}")

    _, basket_index, tee_index, parts = best
    basket_assignment[number] = basket_index
    tee_assignment[number] = tee_index
    selection_costs[number] = parts
    unused_baskets.remove(basket_index)
    unused_tees.remove(tee_index)

centerlines, c1_radius, c2_radius = semantic.build_centerlines(
    image,
    numbers,
    tees,
    tee_assignment,
    baskets,
    basket_assignment,
)

full = semantic.render_full_overlay(
    image,
    numbers,
    tees,
    tee_assignment,
    baskets,
    basket_assignment,
    centerlines,
    c1_radius,
    c2_radius,
)
sheet = semantic.contact_sheet(
    image,
    numbers,
    tees,
    tee_assignment,
    baskets,
    basket_assignment,
    centerlines,
    c1_radius,
    c2_radius,
)

cv2.imwrite(str(OUT / "static-centerline-overlay.png"), full)
cv2.imwrite(str(OUT / "all-18-contact-sheet.png"), sheet)

# Dense H4-H7 crop because that was the original failure cluster.
points = []
for number in (4, 5, 6, 7):
    points.extend(centerlines[number]["centerline"].tolist())
    points.append([numbers[number]["cx"], numbers[number]["cy"]])
xs = [p[0] for p in points]
ys = [p[1] for p in points]
pad = 90
x0 = max(0, int(min(xs) - pad))
x1 = min(image.shape[1], int(max(xs) + pad))
y0 = max(0, int(min(ys) - pad))
y1 = min(image.shape[0], int(max(ys) + pad))
cv2.imwrite(
    str(OUT / "h4-h7-joint-number-center.png"),
    full[y0:y1, x0:x1],
)

anchor_errors = {}
holes = []
for number in range(1, 19):
    marker_point = np.array(
        [numbers[number]["cx"], numbers[number]["cy"]],
        dtype=float,
    )
    line = centerlines[number]["centerline"]
    anchor_errors[str(number)] = float(
        np.linalg.norm(line - marker_point, axis=1).min()
    )

    tee = tees[tee_assignment[number]]
    bx, by = v1.basket_base(baskets[basket_assignment[number]])
    holes.append(
        {
            "number": number,
            "teeIndex": tee_assignment[number],
            "basketIndex": basket_assignment[number],
            "tee": {"xPx": tee["cx"], "yPx": tee["cy"]},
            "numberCenter": {
                "xPx": numbers[number]["cx"],
                "yPx": numbers[number]["cy"],
            },
            "basket": {"xPx": bx, "yPx": by},
            "selectionCost": selection_costs[number],
        }
    )

report = {
    "mode": (
        "full rerun: glyph-only hole labels + reverse 18->1 joint endpoint "
        "selection through exact number center + exact number-center centerlines"
    ),
    "uiScale": scale,
    "holeOneScore": hole_one_score,
    "seedBasket18Index": seed_b18,
    "weights": {
        "oppositeSide": OPPOSITE_SIDE_WEIGHT,
        "basketToNextTee": NEXT_TEE_TRANSITION_WEIGHT,
    },
    "counts": {
        "numbers": len(numbers),
        "tees": len(tees),
        "baskets": len(baskets),
        "centerlines": len(centerlines),
    },
    "maxNumberCenterAnchorErrorPx": max(anchor_errors.values()),
    "endpointAssignments": holes,
}
(OUT / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
