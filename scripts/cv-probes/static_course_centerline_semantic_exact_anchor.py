#!/usr/bin/env python3
"""Semantic centerline variant with the hole-number center as a hard anchor.

UDisc places the hole-number badge on the rendered hole centerline. The badge
pixels are foreground occlusion, but the center of the badge is not merely a
routing hint: it is a ground-truth centerline point.

This keeps the existing basket-backward/C2 behavior and changes only the number
occlusion crossing:

    trace tee -> near edge of own-number badge
    geometry bridge -> exact badge center -> far edge of own-number badge
    trace backward from C2 -> far edge of own-number badge
    geometry-only C2 terminal -> basket stem base

The exact badge-center vertex is never smoothed or displaced.
"""
from __future__ import annotations

import numpy as np

import static_course_centerline as v2
import static_course_centerline_semantic as base
import static_course_parser as v1


def build_semantic_centerlines(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
) -> tuple[dict[int, dict], float, float]:
    feature = v1._overlay_feature(image)
    c1_radius, c2_radius = v2.detect_putting_circle_radii(image, baskets)
    occlusion_mask = base.build_occlusion_mask(
        image, numbers, baskets, tees, c2_radius
    )
    result: dict[int, dict] = {}

    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]

        tee_point = np.array([tee['cx'], tee['cy']], dtype=float)
        number_point = np.array([marker['cx'], marker['cy']], dtype=float)
        basket_point = np.array(v1.basket_base(basket), dtype=float)

        entry, entry_angle = base.semantic_c2_entry(
            feature,
            number_point,
            basket_point,
            c2_radius,
            tees,
            tee_assignment[number],
        )

        tee_side = base.rectangle_exit_point(number_point, tee_point, marker)
        basket_side = base.rectangle_exit_point(number_point, entry, marker)

        tee_to_number = base.coast_segment(
            feature, occlusion_mask, tee_point, tee_side
        )
        c2_to_number = base.coast_segment(
            feature, occlusion_mask, entry, basket_side
        )
        number_to_c2 = c2_to_number[::-1]

        # Hard invariant: the hidden path through the badge is exactly
        # near-side -> badge center -> far-side. No spline is allowed to route
        # around the number glyph/box.
        number_bridge = np.vstack([tee_side, number_point, basket_side])
        outside_c2 = np.vstack([
            tee_to_number[:-1],
            number_bridge[:-1],
            number_to_c2,
        ])

        incoming = outside_c2[-1] - outside_c2[-2]
        terminal = v2.cubic_terminal_segment(entry, basket_point, incoming)
        terminal_start = len(outside_c2) - 1
        centerline = np.vstack([outside_c2[:-1], terminal])

        # Defensive assertion for probes/tests: the own-number center must be a
        # literal centerline vertex, not merely close to the polyline.
        assert float(np.min(np.linalg.norm(centerline - number_point, axis=1))) < 1e-9

        result[number] = {
            'centerline': centerline,
            'c2Entry': entry,
            'c2EntryAngleDeg': entry_angle,
            'terminalStartIndex': terminal_start,
            'numberTeeSide': tee_side,
            'numberBasketSide': basket_side,
            'numberCenterAnchor': number_point,
        }

    return result, c1_radius, c2_radius
