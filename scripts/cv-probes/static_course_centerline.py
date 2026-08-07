#!/usr/bin/env python3
"""ChainSpot clean-course static parser v2: centerline geometry.

Reuses the proven v1 icon detectors/assignment logic, but deliberately stops
trying to recover UDisc's translucent ribbon boundaries. The product only needs
routing geometry; band width/treatment belongs to the creator's style preset.

The final C1/C2 putting-circle region is treated as semantic foreground
occlusion. We detect the repeated C1/C2 radii from all 18 baskets, track only to
the C2 boundary, then reconstruct the last segment from that boundary to the
known basket stem base without using contaminated pixels.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

from static_course_parser import (
    _band_contrast,
    _overlay_feature,
    _track_segment,
    assign_baskets,
    assign_tees,
    basket_base,
    detect_baskets,
    detect_numbers,
    detect_tees,
    ui_scale_from_hole_one,
)


def radial_edge_score(gradient: np.ndarray, center: tuple[float, float], radius: float) -> float:
    height, width = gradient.shape
    cx, cy = center
    values = []
    for theta in np.linspace(0.0, 2.0 * math.pi, 180, endpoint=False):
        x = int(round(cx + radius * math.cos(theta)))
        y = int(round(cy + radius * math.sin(theta)))
        if 0 <= x < width and 0 <= y < height:
            values.append(float(gradient[y, x]))
    return float(np.mean(values)) if values else 0.0


def detect_putting_circle_radii(image: np.ndarray, baskets: list[dict]) -> tuple[float, float]:
    """Recover repeated UDisc C1/C2 radii from basket-centered circular edges."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gx, gy)
    centers = [basket_base(basket) for basket in baskets]

    def best_radius(low: int, high: int) -> float:
        scored = []
        for radius in range(low, high + 1):
            per_basket = [radial_edge_score(gradient, center, radius) for center in centers]
            scored.append((float(np.median(per_basket)), float(radius)))
        return max(scored)[1]

    return best_radius(15, 35), best_radius(36, 80)


def c2_entry_point(
    feature: np.ndarray,
    number_point: tuple[float, float],
    basket_point: tuple[float, float],
    c2_radius: float,
) -> tuple[np.ndarray, float]:
    """Work backward from the basket to find the fairway's C2 entry direction.

    Candidate appearance is sampled *outside* C2 only. C1/C2 decoration and the
    basket glyph therefore cannot attract the tracker.
    """
    basket = np.asarray(basket_point, dtype=float)
    number = np.asarray(number_point, dtype=float)
    direct = number - basket
    direct_angle = math.atan2(direct[1], direct[0])
    best = None

    for delta_deg in range(-80, 81, 5):
        angle = direct_angle + math.radians(delta_deg)
        direction = np.array([math.cos(angle), math.sin(angle)])
        entry = basket + direction * c2_radius
        outside_sample = basket + direction * (c2_radius + 13.0)
        visual = _band_contrast(
            feature,
            outside_sample[0],
            outside_sample[1],
            math.degrees(angle) % 180,
            22.0,
            16.0,
        )
        score = visual - 0.035 * delta_deg * delta_deg
        candidate = (score, entry, math.degrees(angle))
        if best is None or candidate[0] > best[0]:
            best = candidate

    assert best is not None
    return best[1], float(best[2])


def cubic_terminal_segment(
    entry: np.ndarray,
    basket: np.ndarray,
    incoming_tangent: np.ndarray,
    step: float = 7.0,
) -> np.ndarray:
    """Geometry-only C2 bridge from the detected entry to basket stem base."""
    vector = basket - entry
    distance = float(np.linalg.norm(vector))
    if distance < 1e-6:
        return np.asarray([entry, basket])

    radial = vector / distance
    tangent = incoming_tangent / max(np.linalg.norm(incoming_tangent), 1e-9)
    if tangent.dot(radial) < 0:
        tangent = -tangent

    p0 = entry
    p1 = entry + tangent * (distance * 0.38)
    p2 = basket - radial * (distance * 0.20)
    p3 = basket
    count = max(4, int(math.ceil(distance / step)) + 1)
    points = []
    for t in np.linspace(0.0, 1.0, count):
        u = 1.0 - t
        points.append(
            (u ** 3) * p0
            + 3 * (u ** 2) * t * p1
            + 3 * u * (t ** 2) * p2
            + (t ** 3) * p3
        )
    return np.asarray(points)


def smooth_centerline(points: np.ndarray, anchors: list[tuple[float, float]]) -> np.ndarray:
    if len(points) < 5:
        return points
    result = points.copy()
    for _ in range(2):
        next_points = result.copy()
        for index in range(1, len(result) - 1):
            next_points[index] = (
                0.25 * result[index - 1] + 0.5 * result[index] + 0.25 * result[index + 1]
            )
        result = next_points

    anchor_arrays = [np.asarray(anchor, dtype=float) for anchor in anchors]
    for anchor in anchor_arrays:
        index = int(np.argmin(np.linalg.norm(result - anchor, axis=1)))
        result[index] = anchor
    result[0] = anchor_arrays[0]
    result[-1] = anchor_arrays[-1]
    return result


def build_centerlines(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
) -> tuple[dict[int, dict], float, float]:
    feature = _overlay_feature(image)
    c1_radius, c2_radius = detect_putting_circle_radii(image, baskets)
    result = {}

    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        tee_point = np.asarray((tee['cx'], tee['cy']), dtype=float)
        number_point = np.asarray((numbers[number]['cx'], numbers[number]['cy']), dtype=float)
        basket_point = np.asarray(basket_base(basket), dtype=float)

        tee_to_number = _track_segment(feature, tuple(tee_point), tuple(number_point))
        entry, entry_angle = c2_entry_point(
            feature, tuple(number_point), tuple(basket_point), c2_radius
        )

        if np.linalg.norm(entry - number_point) < 18.0:
            direction = number_point - basket_point
            direction /= max(np.linalg.norm(direction), 1e-9)
            radius = min(c2_radius, max(18.0, np.linalg.norm(number_point - basket_point) * 0.55))
            entry = basket_point + direction * radius

        number_to_c2 = _track_segment(feature, tuple(number_point), tuple(entry))
        incoming = (
            number_to_c2[-1] - number_to_c2[-2]
            if len(number_to_c2) >= 2
            else basket_point - entry
        )
        terminal = cubic_terminal_segment(entry, basket_point, incoming)
        terminal_start = len(tee_to_number[:-1]) + len(number_to_c2[:-1])
        centerline = np.vstack([tee_to_number[:-1], number_to_c2[:-1], terminal])
        centerline = smooth_centerline(
            centerline,
            [tuple(tee_point), tuple(number_point), tuple(basket_point)],
        )
        result[number] = {
            'centerline': centerline,
            'c2Entry': entry,
            'c2EntryAngleDeg': entry_angle,
            'terminalStartIndex': terminal_start,
        }

    return result, c1_radius, c2_radius


def render_overlay(
    image: np.ndarray,
    numbers: dict[int, dict],
    baskets: list[dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    basket_assignment: dict[int, int],
    centerlines: dict[int, dict],
    c1_radius: float,
    c2_radius: float,
) -> np.ndarray:
    """Render all static proposals: number, tee, basket, C1/C2, centerline."""
    output = image.copy()
    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = basket_base(basket)
        route = centerlines[number]
        points = np.int32(np.round(route['centerline']))
        terminal_index = route['terminalStartIndex']

        cv2.rectangle(
            output,
            (int(marker['x']), int(marker['y'])),
            (int(marker['x'] + marker['width']), int(marker['y'] + marker['height'])),
            (0, 255, 255), 1,
        )
        cv2.putText(
            output, f'H{number}', (int(marker['x']), max(12, int(marker['y']) - 4)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.34, (0, 255, 255), 1, cv2.LINE_AA,
        )
        cv2.circle(output, (int(round(tee['cx'])), int(round(tee['cy']))), 6, (255, 0, 255), 1)
        cv2.circle(output, (int(round(tee['cx'])), int(round(tee['cy']))), 2, (255, 0, 255), -1)
        cv2.rectangle(
            output,
            (int(basket['x']), int(basket['y'])),
            (int(basket['x'] + basket['width']), int(basket['y'] + basket['height'])),
            (255, 255, 0), 1,
        )
        cv2.circle(output, (int(round(bx)), int(round(by))), 4, (0, 0, 255), -1)
        cv2.circle(output, (int(round(bx)), int(round(by))), int(round(c1_radius)), (0, 170, 255), 1)
        cv2.circle(output, (int(round(bx)), int(round(by))), int(round(c2_radius)), (0, 220, 0), 1)

        if terminal_index >= 2:
            cv2.polylines(output, [points[:terminal_index + 1]], False, (255, 80, 0), 2, cv2.LINE_AA)
        if terminal_index < len(points):
            cv2.polylines(output, [points[terminal_index:]], False, (0, 0, 255), 2, cv2.LINE_AA)
        entry = route['c2Entry']
        cv2.circle(output, (int(round(entry[0])), int(round(entry[1]))), 3, (0, 255, 0), -1)

    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('image', type=Path)
    parser.add_argument('--templates', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--map-top', type=int, default=400)
    parser.add_argument('--map-bottom', type=int, default=1350)
    args = parser.parse_args()

    image = cv2.imread(str(args.image))
    if image is None:
        raise RuntimeError(f'could not decode {args.image}')
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    map_y = (args.map_top, args.map_bottom)

    scale, anchor_score = ui_scale_from_hole_one(gray, args.templates)
    numbers = detect_numbers(gray, args.templates, scale)
    baskets = detect_baskets(gray, args.templates, scale, map_y)
    tees = detect_tees(image, scale, map_y)
    if len(numbers) != 18 or len(baskets) != 18 or len(tees) != 18:
        raise RuntimeError(
            f'static milestone not met: numbers={len(numbers)}, baskets={len(baskets)}, tees={len(tees)}'
        )

    tee_assignment = assign_tees(numbers, tees)
    basket_assignment = assign_baskets(numbers, tees, tee_assignment, baskets)
    centerlines, c1_radius, c2_radius = build_centerlines(
        image, numbers, tees, tee_assignment, baskets, basket_assignment
    )

    args.out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(
        str(args.out / 'static-centerline-overlay.png'),
        render_overlay(
            image, numbers, baskets, tees, tee_assignment, basket_assignment,
            centerlines, c1_radius, c2_radius,
        ),
    )

    holes = []
    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = basket_base(basket)
        marker = numbers[number]
        route = centerlines[number]
        holes.append({
            'number': number,
            'numberBadge': {
                'xPx': marker['cx'], 'yPx': marker['cy'], 'score': marker['score'],
            },
            'tee': {
                'xPx': tee['cx'], 'yPx': tee['cy'], 'support': tee['support'],
            },
            'basket': {
                'xPx': bx, 'yPx': by, 'score': basket['score'],
            },
            'centerline': [
                {'xPx': float(x), 'yPx': float(y)} for x, y in route['centerline']
            ],
            'c2Entry': {
                'xPx': float(route['c2Entry'][0]),
                'yPx': float(route['c2Entry'][1]),
            },
        })

    (args.out / 'proposals.json').write_text(json.dumps({'holes': holes}, indent=2))
    report = {
        'uiScale': scale,
        'holeOneScore': anchor_score,
        'counts': {'numbers': 18, 'baskets': 18, 'tees': 18, 'centerlines': 18},
        'puttingCircles': {'c1RadiusPx': c1_radius, 'c2RadiusPx': c2_radius},
        'centerlinePointCounts': {
            str(number): len(centerlines[number]['centerline']) for number in range(1, 19)
        },
        'representation': (
            'tee -> number -> C2 entry -> basket-base centerline; UDisc band width is intentionally not extracted'
        ),
    }
    (args.out / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
