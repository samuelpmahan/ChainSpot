#!/usr/bin/env python3
"""Semantic centerline probe for clean UDisc course maps.

This is the H5/H6 correction on top of static_course_centerline.py.

The important distinction is semantic:
- the current hole's number badge is strong ownership/routing evidence;
- the badge pixels themselves are foreground occlusion, not fairway pixels;
- a different hole's tee beside the current basket is negative evidence for
  choosing that basket-backward departure direction;
- C2 remains a semantic occlusion zone whose terminal is reconstructed to the
  basket stem base.

So a hole is recovered as:
    own tee
      -> trace to own-number occlusion boundary
      -> bridge through own-number badge
      -> basket-backward trace from own-number boundary to C2
      -> geometry-only C2 terminal
      -> own basket stem base

This fixes the development-fixture H5 failure where H6's tee sits beside H5's
basket and a purely appearance-driven reverse tracer happily follows H6.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

import static_course_parser as v1
import static_course_centerline as v2


def build_occlusion_mask(
    image: np.ndarray,
    numbers: dict[int, dict],
    baskets: list[dict],
    tees: list[dict],
    c2_radius: float,
) -> np.ndarray:
    height, width = image.shape[:2]
    mask = np.zeros((height, width), np.uint8)

    for marker in numbers.values():
        pad = 10
        cv2.rectangle(
            mask,
            (max(0, int(marker['x'] - pad)), max(0, int(marker['y'] - pad))),
            (
                min(width - 1, int(marker['x'] + marker['width'] + pad)),
                min(height - 1, int(marker['y'] + marker['height'] + pad)),
            ),
            255,
            -1,
        )

    for basket in baskets:
        bx, by = v1.basket_base(basket)
        cv2.circle(
            mask,
            (int(round(bx)), int(round(by))),
            int(round(c2_radius * .95)),
            255,
            -1,
        )

    for tee in tees:
        cv2.circle(
            mask,
            (int(round(tee['cx'])), int(round(tee['cy']))),
            12,
            255,
            -1,
        )
    return mask


def patch_is_occluded(mask: np.ndarray, x: float, y: float, radius: int = 4) -> bool:
    height, width = mask.shape
    ix, iy = int(round(x)), int(round(y))
    x0, x1 = max(0, ix - radius), min(width, ix + radius + 1)
    y0, y1 = max(0, iy - radius), min(height, iy + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return True
    return float(np.mean(mask[y0:y1, x0:x1] > 0)) > .25


def line_samples(start: np.ndarray, end: np.ndarray, step: float = 5.5) -> np.ndarray:
    length = float(np.linalg.norm(end - start))
    count = max(3, int(math.ceil(length / step)) + 1)
    return np.array([start + (end - start) * i / (count - 1) for i in range(count)])


def coast_segment(
    feature: np.ndarray,
    occlusion_mask: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
) -> np.ndarray:
    """Direction-sensitive trace that carries trajectory through weak/occluded pixels."""
    height, width = feature.shape
    base = line_samples(start, end)
    offsets = np.arange(-30., 30.1, 2.)
    chosen = [base[0].copy()]
    previous_offset = 0.
    lateral_velocity = 0.

    for index in range(1, len(base) - 1):
        point = base[index]
        tangent = base[min(index + 1, len(base) - 1)] - base[max(0, index - 1)]
        tangent /= max(np.linalg.norm(tangent), 1e-9)
        normal = np.array([-tangent[1], tangent[0]])
        angle = math.degrees(math.atan2(tangent[1], tangent[0])) % 180.
        predicted_offset = float(np.clip(previous_offset + lateral_velocity, -30., 30.))

        raw = []
        for offset in offsets:
            candidate = point + normal * offset
            x, y = candidate
            if not (6 < x < width - 6 and 6 < y < height - 6):
                continue
            occluded = patch_is_occluded(occlusion_mask, x, y)
            visual = v1._band_contrast(feature, x, y, angle, 20., 16.)
            raw.append((float(offset), candidate, float(visual), bool(occluded)))

        visible_scores = [visual for _, _, visual, occluded in raw if not occluded]
        weak_evidence = not visible_scores or max(visible_scores) < 5.
        candidates = []
        for offset, candidate, visual, occluded in raw:
            unknown = occluded or weak_evidence
            visual_term = 0. if unknown else float(np.clip(visual, -30., 85.))
            score = (
                visual_term
                - .28 * (offset - predicted_offset) ** 2
                - .012 * offset ** 2
            )
            candidates.append((score, offset, candidate, unknown))

        if not candidates:
            chosen.append(point.copy())
            continue

        _, offset, selected, unknown = max(candidates, key=lambda row: row[0])
        observed_velocity = float(np.clip(offset - previous_offset, -5., 5.))
        lateral_velocity = (
            lateral_velocity * .85
            if unknown
            else .55 * lateral_velocity + .45 * observed_velocity
        )
        previous_offset = float(offset)
        chosen.append(selected)

    chosen.append(end.copy())
    points = np.asarray(chosen)
    if len(points) >= 5:
        for _ in range(2):
            next_points = points.copy()
            for index in range(1, len(points) - 1):
                next_points[index] = (
                    .22 * points[index - 1]
                    + .56 * points[index]
                    + .22 * points[index + 1]
                )
            points = next_points
    points[0] = start
    points[-1] = end
    return points


def rectangle_exit_point(
    center: np.ndarray,
    toward: np.ndarray,
    marker: dict,
    pad: float = 8.,
) -> np.ndarray:
    direction = toward - center
    length = float(np.linalg.norm(direction))
    if length < 1e-9:
        return center.copy()
    direction /= length

    x0 = float(marker['x']) - pad
    x1 = float(marker['x'] + marker['width']) + pad
    y0 = float(marker['y']) - pad
    y1 = float(marker['y'] + marker['height']) + pad
    intersections = []
    if abs(direction[0]) > 1e-9:
        intersections.extend([(x0 - center[0]) / direction[0], (x1 - center[0]) / direction[0]])
    if abs(direction[1]) > 1e-9:
        intersections.extend([(y0 - center[1]) / direction[1], (y1 - center[1]) / direction[1]])

    for distance in sorted(value for value in intersections if value > 0):
        point = center + direction * distance
        if x0 - 1e-6 <= point[0] <= x1 + 1e-6 and y0 - 1e-6 <= point[1] <= y1 + 1e-6:
            return point
    return center + direction * max(float(marker['width']), float(marker['height']))


def semantic_c2_entry(
    feature: np.ndarray,
    number_point: np.ndarray,
    basket_point: np.ndarray,
    c2_radius: float,
    tees: list[dict],
    own_tee_index: int,
) -> tuple[np.ndarray, float]:
    """Choose a basket-backward departure while repelling nearby foreign tees."""
    direct = number_point - basket_point
    direct_angle = math.atan2(direct[1], direct[0])
    foreign_tee_rays = []
    for tee_index, tee in enumerate(tees):
        if tee_index == own_tee_index:
            continue
        tee_point = np.array([tee['cx'], tee['cy']], dtype=float)
        vector = tee_point - basket_point
        distance = float(np.linalg.norm(vector))
        if distance < c2_radius * 1.15:
            foreign_tee_rays.append((vector / max(distance, 1e-9), distance))

    best = None
    for delta_deg in range(-80, 81, 5):
        angle = direct_angle + math.radians(delta_deg)
        direction = np.array([math.cos(angle), math.sin(angle)])
        entry = basket_point + direction * c2_radius
        samples = []
        for radius in (c2_radius + 10., c2_radius + 22., c2_radius + 34.):
            point = basket_point + direction * radius
            samples.append(float(np.clip(
                v1._band_contrast(
                    feature, point[0], point[1], math.degrees(angle) % 180., 20., 16.
                ),
                -30., 85.,
            )))
        score = float(np.mean(samples)) - .020 * delta_deg * delta_deg

        for foreign_direction, foreign_distance in foreign_tee_rays:
            cosine = float(np.clip(direction.dot(foreign_direction), -1., 1.))
            angular_distance = math.degrees(math.acos(cosine))
            if angular_distance < 30.:
                nearness = 1. - foreign_distance / (c2_radius * 1.15)
                score -= (30. - angular_distance) * 2.5 * nearness

        candidate = (score, entry, math.degrees(angle))
        if best is None or candidate[0] > best[0]:
            best = candidate

    assert best is not None
    return best[1], float(best[2])


def cubic_bridge(first: np.ndarray, second: np.ndarray, step: float = 5.) -> np.ndarray:
    p0, p3 = first[-1], second[0]
    distance = float(np.linalg.norm(p3 - p0))
    if distance < 1e-9:
        return np.asarray([p0, p3])
    t0 = first[-1] - first[-2]
    t1 = second[1] - second[0]
    t0 /= max(np.linalg.norm(t0), 1e-9)
    t1 /= max(np.linalg.norm(t1), 1e-9)
    chord = (p3 - p0) / distance
    if t0.dot(chord) < 0:
        t0 = -t0
    if t1.dot(chord) < 0:
        t1 = -t1
    p1 = p0 + t0 * distance * .35
    p2 = p3 - t1 * distance * .35
    count = max(4, int(math.ceil(distance / step)) + 1)
    result = []
    for t in np.linspace(0., 1., count):
        u = 1. - t
        result.append(
            u ** 3 * p0
            + 3. * u ** 2 * t * p1
            + 3. * u * t ** 2 * p2
            + t ** 3 * p3
        )
    return np.asarray(result)


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
    occlusion_mask = build_occlusion_mask(image, numbers, baskets, tees, c2_radius)
    result = {}

    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        tee_point = np.array([tee['cx'], tee['cy']], dtype=float)
        number_point = np.array([marker['cx'], marker['cy']], dtype=float)
        basket_point = np.array(v1.basket_base(basket), dtype=float)

        entry, entry_angle = semantic_c2_entry(
            feature,
            number_point,
            basket_point,
            c2_radius,
            tees,
            tee_assignment[number],
        )
        tee_side = rectangle_exit_point(number_point, tee_point, marker)
        basket_side = rectangle_exit_point(number_point, entry, marker)

        tee_to_number = coast_segment(feature, occlusion_mask, tee_point, tee_side)
        c2_to_number = coast_segment(feature, occlusion_mask, entry, basket_side)
        number_to_c2 = c2_to_number[::-1]
        number_bridge = cubic_bridge(tee_to_number, number_to_c2)
        outside_c2 = np.vstack([
            tee_to_number[:-1],
            number_bridge[:-1],
            number_to_c2,
        ])

        incoming = outside_c2[-1] - outside_c2[-2]
        terminal = v2.cubic_terminal_segment(entry, basket_point, incoming)
        terminal_start = len(outside_c2) - 1
        centerline = np.vstack([outside_c2[:-1], terminal])
        result[number] = {
            'centerline': centerline,
            'c2Entry': entry,
            'c2EntryAngleDeg': entry_angle,
            'terminalStartIndex': terminal_start,
            'numberTeeSide': tee_side,
            'numberBasketSide': basket_side,
        }

    return result, c1_radius, c2_radius


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

    scale, anchor_score = v1.ui_scale_from_hole_one(gray, args.templates)
    numbers = v1.detect_numbers(gray, args.templates, scale)
    baskets = v1.detect_baskets(gray, args.templates, scale, map_y)
    tees = v1.detect_tees(image, scale, map_y)
    if len(numbers) != 18 or len(baskets) != 18 or len(tees) != 18:
        raise RuntimeError(
            f'static milestone not met: numbers={len(numbers)}, baskets={len(baskets)}, tees={len(tees)}'
        )

    tee_assignment = v1.assign_tees(numbers, tees)
    basket_assignment = v1.assign_baskets(numbers, tees, tee_assignment, baskets)
    centerlines, c1_radius, c2_radius = build_semantic_centerlines(
        image, numbers, tees, tee_assignment, baskets, basket_assignment
    )

    args.out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(
        str(args.out / 'static-centerline-overlay.png'),
        v2.render_overlay(
            image, numbers, baskets, tees, tee_assignment, basket_assignment,
            centerlines, c1_radius, c2_radius,
        ),
    )

    holes = []
    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = v1.basket_base(basket)
        route = centerlines[number]
        holes.append({
            'number': number,
            'tee': {'xPx': tee['cx'], 'yPx': tee['cy']},
            'basket': {'xPx': bx, 'yPx': by},
            'centerline': [
                {'xPx': float(x), 'yPx': float(y)} for x, y in route['centerline']
            ],
        })
    (args.out / 'proposals.json').write_text(json.dumps({'holes': holes}, indent=2))

    report = {
        'uiScale': scale,
        'holeOneScore': anchor_score,
        'counts': {'numbers': 18, 'baskets': 18, 'tees': 18, 'centerlines': 18},
        'puttingCircles': {'c1RadiusPx': c1_radius, 'c2RadiusPx': c2_radius},
        'rules': [
            'own number is a semantic waypoint but its pixels are occlusion',
            'basket side is traced backward toward the own-number waypoint',
            'nearby foreign tees repel C2 departure directions',
            'C2 terminal is reconstructed to basket stem base',
        ],
    }
    (args.out / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
