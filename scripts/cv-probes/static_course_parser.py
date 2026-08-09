#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment


def resize_template(gray: np.ndarray, scale: float) -> np.ndarray:
    width = max(5, round(gray.shape[1] * scale))
    height = max(5, round(gray.shape[0] * scale))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    return cv2.resize(gray, (width, height), interpolation=interpolation)


def ui_scale_from_hole_one(gray: np.ndarray, templates: Path) -> tuple[float, float]:
    source = cv2.imread(str(templates / 'hole-01.png'))
    if source is None:
        raise RuntimeError('missing hole-01.png')
    canonical = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    best = None
    for scale in np.arange(0.40, 1.61, 0.01):
        template = resize_template(canonical, float(scale))
        response = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, _ = cv2.minMaxLoc(response)
        candidate = (float(score), template.shape[1], template.shape[0])
        if best is None or candidate[0] > best[0]:
            best = candidate
    score, width, height = best
    return ((width / canonical.shape[1]) + (height / canonical.shape[0])) / 2, score


def detect_numbers(gray: np.ndarray, templates: Path, ui_scale: float) -> dict[int, dict]:
    """Template peaks -> spatial clusters -> one-to-one 1..18 assignment."""
    hits = []
    for number in range(1, 19):
        source = cv2.imread(str(templates / f'hole-{number:02d}.png'))
        if source is None:
            raise RuntimeError(f'missing hole-{number:02d}.png')
        canonical = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
        for scale in np.linspace(ui_scale * .92, ui_scale * 1.08, 9):
            template = resize_template(canonical, float(scale))
            response = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
            maxima = cv2.dilate(response, np.ones((9, 9), np.uint8))
            ys, xs = np.where((response >= .60) & (response >= maxima - 1e-6))
            for y, x in zip(ys, xs):
                hits.append({
                    'number': number,
                    'score': float(response[y, x]),
                    'x': int(x), 'y': int(y),
                    'width': int(template.shape[1]), 'height': int(template.shape[0]),
                    'cx': float(x + template.shape[1] / 2),
                    'cy': float(y + template.shape[0] / 2),
                })

    hits.sort(key=lambda hit: hit['score'], reverse=True)
    radius = max(9., 12. * ui_scale)
    clusters = []
    for hit in hits:
        cluster = next((
            cluster for cluster in clusters
            if (hit['cx'] - cluster['cx']) ** 2 + (hit['cy'] - cluster['cy']) ** 2 < radius ** 2
        ), None)
        if cluster is None:
            clusters.append({'cx': hit['cx'], 'cy': hit['cy'], 'hits': [hit]})
        else:
            cluster['hits'].append(hit)

    clusters.sort(key=lambda cluster: max(hit['score'] for hit in cluster['hits']), reverse=True)
    clusters = clusters[:18]
    if len(clusters) != 18:
        raise RuntimeError(f'expected 18 number badge clusters, got {len(clusters)}')

    score_matrix = np.zeros((18, 18), dtype=np.float64)
    for cluster_index, cluster in enumerate(clusters):
        for hit in cluster['hits']:
            score_matrix[cluster_index, hit['number'] - 1] = max(
                score_matrix[cluster_index, hit['number'] - 1], hit['score']
            )
    rows, cols = linear_sum_assignment(-score_matrix)
    cluster_for_number = {int(col + 1): int(row) for row, col in zip(rows, cols)}

    result = {}
    for number in range(1, 19):
        cluster = clusters[cluster_for_number[number]]
        exact = sorted(
            (hit for hit in cluster['hits'] if hit['number'] == number),
            key=lambda hit: hit['score'], reverse=True,
        )
        result[number] = exact[0]
    return result


def detect_baskets(
    gray: np.ndarray,
    templates: Path,
    ui_scale: float,
    map_y: tuple[int, int],
) -> list[dict]:
    source = cv2.imread(str(templates / 'basket.png'))
    if source is None:
        raise RuntimeError('missing basket.png')
    canonical = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    hits = []
    for scale in np.linspace(ui_scale * .90, ui_scale * 1.10, 9):
        template = resize_template(canonical, float(scale))
        response = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
        maxima = cv2.dilate(response, np.ones((11, 11), np.uint8))
        ys, xs = np.where((response >= .50) & (response >= maxima - 1e-6))
        for y, x in zip(ys, xs):
            cy = y + template.shape[0] / 2
            if not map_y[0] <= cy <= map_y[1]:
                continue
            hits.append({
                'score': float(response[y, x]),
                'x': int(x), 'y': int(y),
                'width': int(template.shape[1]), 'height': int(template.shape[0]),
                'cx': float(x + template.shape[1] / 2), 'cy': float(cy),
            })

    hits.sort(key=lambda hit: hit['score'], reverse=True)
    baskets = []
    nms_radius = max(16., 22. * ui_scale)
    for hit in hits:
        if any(
            (hit['cx'] - kept['cx']) ** 2 + (hit['cy'] - kept['cy']) ** 2 < nms_radius ** 2
            for kept in baskets
        ):
            continue
        baskets.append(hit)
        if len(baskets) == 18:
            break
    return baskets


def basket_base(basket: dict) -> tuple[float, float]:
    """Semantic terminal is the bottom-center basket stem base, not glyph center."""
    return (
        basket['x'] + .50 * basket['width'],
        basket['y'] + .96 * basket['height'],
    )


def detect_tees(image: np.ndarray, ui_scale: float, map_y: tuple[int, int]) -> list[dict]:
    """Fuse two independent teepad detectors with complementary failures.

    A keys on the repeated low-saturation gray interior rectangle. B keys on a
    quadrilateral edge loop plus bright rim / gray-ish interior. On the clean
    development fixture each finds 16 pads but misses a different two; their
    fused centers are exactly the 18 physical teepads.
    """
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    _, saturation, value = cv2.split(hsv)
    scale = ui_scale

    center_mask = (
        (saturation < 18) & (value >= 148) & (value <= 168)
    ).astype(np.uint8) * 255
    center_mask[:map_y[0]] = 0
    center_mask[map_y[1] + 1:] = 0
    contours, _ = cv2.findContours(center_mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    detector_a = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if not 15 * scale * scale <= area <= 150 * scale * scale:
            continue
        (cx, cy), (rw, rh), _ = cv2.minAreaRect(contour)
        if min(rw, rh) < 2:
            continue
        major, minor = max(rw, rh), min(rw, rh)
        if not (5 * scale <= minor <= 12 * scale and 8 * scale <= major <= 20 * scale):
            continue
        if not 1.1 <= major / minor <= 3.0:
            continue
        rectangularity = area / (major * minor)
        if rectangularity < .60:
            continue
        detector_a.append({
            'cx': float(cx), 'cy': float(cy),
            'support': ['gray-center'], 'score': float(rectangularity),
        })

    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 50, 150)
    edges[:map_y[0]] = 0
    edges[map_y[1] + 1:] = 0
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    edge_candidates = []
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, .06 * perimeter, True)
        area = abs(cv2.contourArea(contour))
        rect = cv2.minAreaRect(contour)
        (cx, cy), (rw, rh), _ = rect
        if min(rw, rh) < 1:
            continue
        major, minor = max(rw, rh), min(rw, rh)
        if not (5.5 * scale <= minor <= 18 * scale and 8 * scale <= major <= 26 * scale):
            continue
        rectangularity = area / (major * minor)
        if len(approx) > 6 or rectangularity < .45:
            continue

        box = cv2.boxPoints(rect).astype(np.int32)
        rect_mask = np.zeros((height, width), np.uint8)
        cv2.fillConvexPoly(rect_mask, box, 255)
        inner = cv2.erode(rect_mask, np.ones((3, 3), np.uint8), iterations=2)
        border = cv2.subtract(rect_mask, inner)
        if np.count_nonzero(inner) == 0 or np.count_nonzero(border) == 0:
            continue
        border_v = float(value[border > 0].mean())
        inner_v = float(value[inner > 0].mean())
        inner_s = float(saturation[inner > 0].mean())
        contrast = border_v - inner_v
        if border_v < 145:
            continue

        visual_score = (
            1.5 * rectangularity
            - .05 * abs(major - 13 * scale)
            - .05 * abs(minor - 8 * scale)
            - .018 * max(0., inner_s - 10.)
            - .015 * abs(inner_v - 165.)
            + .012 * max(0., border_v - 150.)
            + .006 * max(0., contrast)
            - .1 * max(0, len(approx) - 4)
        )
        edge_candidates.append({
            'cx': float(cx), 'cy': float(cy),
            'support': ['edge-loop'], 'score': float(visual_score),
        })

    edge_candidates.sort(key=lambda candidate: candidate['score'], reverse=True)
    detector_b = []
    for candidate in edge_candidates:
        if any(
            (candidate['cx'] - kept['cx']) ** 2 + (candidate['cy'] - kept['cy']) ** 2 < (7 * scale) ** 2
            for kept in detector_b
        ):
            continue
        detector_b.append(candidate)
        if len(detector_b) == 16:
            break

    fused = []
    for candidate in [*detector_a, *detector_b]:
        existing = next((
            kept for kept in fused
            if (candidate['cx'] - kept['cx']) ** 2 + (candidate['cy'] - kept['cy']) ** 2 < (7 * scale) ** 2
        ), None)
        if existing is None:
            fused.append(dict(candidate))
        else:
            existing['support'] = sorted(set(existing['support']) | set(candidate['support']))
            existing['score'] = max(existing['score'], candidate['score'])
    fused.sort(key=lambda candidate: candidate['cy'])
    return fused


def assign_tees(numbers: dict[int, dict], tees: list[dict]) -> dict[int, int]:
    """One-to-one proximity matching; resolves all 18 clean-fixture tees."""
    cost = np.zeros((18, len(tees)), dtype=np.float64)
    for row, number in enumerate(range(1, 19)):
        marker = numbers[number]
        for col, tee in enumerate(tees):
            cost[row, col] = math.hypot(marker['cx'] - tee['cx'], marker['cy'] - tee['cy'])
    rows, cols = linear_sum_assignment(cost)
    return {int(row + 1): int(col) for row, col in zip(rows, cols)}


def assign_baskets(
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
) -> dict[int, int]:
    """One-to-one basket assignment using tee/number polarity plus distance.

    The number badge usually lies between the tee and basket. Rewarding an
    opposite-direction basket fixes the old nearest-basket failure where H1
    chose the basket beside its tee instead of the basket across the fairway.
    """
    cost = np.zeros((18, len(baskets)), dtype=np.float64)
    for row, number in enumerate(range(1, 19)):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        tee_vector = np.array([
            tee['cx'] - marker['cx'], tee['cy'] - marker['cy'],
        ], dtype=float)
        tee_distance = np.linalg.norm(tee_vector)
        for col, basket in enumerate(baskets):
            bx, by = basket_base(basket)
            basket_vector = np.array([bx - marker['cx'], by - marker['cy']], dtype=float)
            basket_distance = np.linalg.norm(basket_vector)
            cosine = float(
                tee_vector.dot(basket_vector) / (tee_distance * basket_distance + 1e-9)
            )
            cost[row, col] = basket_distance + 80. * (cosine + 1.)
    rows, cols = linear_sum_assignment(cost)
    return {int(row + 1): int(col) for row, col in zip(rows, cols)}


def overlay_feature(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1].astype(np.float32)
    value = hsv[:, :, 2].astype(np.float32)
    return -(0.8 * saturation + 0.35 * np.abs(value - 160.0))


def band_contrast(
    feature: np.ndarray,
    cx: float,
    cy: float,
    angle_deg: float,
    length: float,
    width: float,
) -> float:
    height, image_width = feature.shape
    theta = math.radians(angle_deg)
    ux, uy = math.cos(theta), math.sin(theta)
    nx, ny = -uy, ux
    half_length, half_width = length / 2., width / 2.
    side_gap, side_width = 3., 10.
    radius = int(math.ceil(max(half_length, half_width + side_gap + side_width))) + 2
    x0, x1 = max(0, int(cx - radius)), min(image_width, int(cx + radius + 1))
    y0, y1 = max(0, int(cy - radius)), min(height, int(cy + radius + 1))
    yy, xx = np.mgrid[y0:y1, x0:x1]
    dx, dy = xx - cx, yy - cy
    along = dx * ux + dy * uy
    perpendicular = dx * nx + dy * ny
    inside = (np.abs(along) <= half_length) & (np.abs(perpendicular) <= half_width)
    sides = (
        (np.abs(along) <= half_length)
        & (np.abs(perpendicular) >= half_width + side_gap)
        & (np.abs(perpendicular) <= half_width + side_gap + side_width)
    )
    inside_values = feature[y0:y1, x0:x1][inside]
    side_values = feature[y0:y1, x0:x1][sides]
    if len(inside_values) < 20 or len(side_values) < 20:
        return -1e9
    return float(inside_values.mean() - side_values.mean())


def line_samples(p0: tuple[float, float], p1: tuple[float, float], step: float = 7.) -> np.ndarray:
    p0 = np.asarray(p0, dtype=float)
    p1 = np.asarray(p1, dtype=float)
    length = float(np.linalg.norm(p1 - p0))
    count = max(2, int(math.ceil(length / step)) + 1)
    return np.array([p0 + (p1 - p0) * i / (count - 1) for i in range(count)])


def track_segment(
    feature: np.ndarray,
    p0: tuple[float, float],
    p1: tuple[float, float],
) -> np.ndarray:
    """Smooth bounded DP tracker around a fixed endpoint-to-anchor segment.

    This replaces the old free greedy grower. It cannot disappear down a road
    or jump to a neighboring hole because every state is a bounded lateral
    displacement from the tee-number or number-basket baseline, and both ends
    are fixed.
    """
    base = line_samples(p0, p1)
    if len(base) <= 2:
        return base
    vector = np.asarray(p1, dtype=float) - np.asarray(p0, dtype=float)
    length = np.linalg.norm(vector)
    unit = vector / max(length, 1e-9)
    normal = np.array([-unit[1], unit[0]])
    angle = math.degrees(math.atan2(unit[1], unit[0])) % 180
    offsets = np.arange(-35., 35.1, 2.)
    zero = int(np.argmin(np.abs(offsets)))
    count, states = len(base), len(offsets)
    visual = np.full((count, states), -1e9, dtype=float)
    height, width = feature.shape

    for index in range(1, count - 1):
        for state, offset in enumerate(offsets):
            candidate = base[index] + normal * offset
            x, y = candidate
            if 5 < x < width - 5 and 5 < y < height - 5:
                visual[index, state] = (
                    band_contrast(feature, x, y, angle, 20., 16.)
                    - .01 * offset * offset
                )

    dp = np.full((count, states), -1e18, dtype=float)
    back = np.full((count, states), -1, dtype=np.int32)
    dp[0, zero] = 0.
    for index in range(1, count):
        candidates = [zero] if index == count - 1 else range(states)
        for state in candidates:
            best_score, best_previous = -1e18, -1
            for previous in range(max(0, state - 4), min(states, state + 5)):
                if dp[index - 1, previous] < -1e17:
                    continue
                transition = .08 * (offsets[state] - offsets[previous]) ** 2
                score = dp[index - 1, previous] - transition
                if index != count - 1:
                    score += visual[index, state]
                if score > best_score:
                    best_score, best_previous = score, previous
            dp[index, state], back[index, state] = best_score, best_previous

    chosen = [zero] * count
    state = zero
    for index in range(count - 1, 0, -1):
        chosen[index] = state
        state = int(back[index, state])
    return np.array([
        base[index] + normal * offsets[chosen[index]]
        for index in range(count)
    ])


def estimate_polygon(feature: np.ndarray, centerline: np.ndarray) -> np.ndarray:
    """Estimate left/right ribbon edges from cross-sectional feature gradients."""
    height, width = feature.shape
    left_widths, right_widths = [], []
    for index, point in enumerate(centerline):
        if index == 0:
            tangent = centerline[1] - centerline[0]
        elif index == len(centerline) - 1:
            tangent = centerline[-1] - centerline[-2]
        else:
            tangent = centerline[index + 1] - centerline[index - 1]
        unit = tangent / max(np.linalg.norm(tangent), 1e-9)
        normal = np.array([-unit[1], unit[0]])
        distances = np.arange(-30, 31)
        values = []
        for distance in distances:
            sample = point + normal * distance
            x, y = int(round(sample[0])), int(round(sample[1]))
            values.append(float(feature[y, x]) if 0 <= x < width and 0 <= y < height else -999.)
        values = np.convolve(np.asarray(values), np.ones(3) / 3., mode='same')
        derivative = np.gradient(values)
        left_indices = np.where((distances >= -28) & (distances <= -3))[0]
        right_indices = np.where((distances >= 3) & (distances <= 28))[0]
        left = -distances[left_indices[np.argmax(derivative[left_indices])]]
        right = distances[right_indices[np.argmin(derivative[right_indices])]]
        left_widths.append(float(np.clip(left, 4, 28)))
        right_widths.append(float(np.clip(right, 4, 28)))

    def smooth(values: list[float]) -> np.ndarray:
        values = np.asarray(values, dtype=float)
        result = values.copy()
        for index in range(len(values)):
            result[index] = np.median(values[max(0, index - 2):min(len(values), index + 3)])
        return result

    left_widths, right_widths = smooth(left_widths), smooth(right_widths)
    left_points, right_points = [], []
    for index, point in enumerate(centerline):
        if index == 0:
            tangent = centerline[1] - centerline[0]
        elif index == len(centerline) - 1:
            tangent = centerline[-1] - centerline[-2]
        else:
            tangent = centerline[index + 1] - centerline[index - 1]
        unit = tangent / max(np.linalg.norm(tangent), 1e-9)
        normal = np.array([-unit[1], unit[0]])
        left_points.append(point - normal * left_widths[index])
        right_points.append(point + normal * right_widths[index])

    polygon = np.vstack([left_points, np.asarray(right_points)[::-1]])
    simplified = cv2.approxPolyDP(np.asarray(polygon, dtype=np.float32), 2.0, True)
    return simplified[:, 0, :]


def build_corridors(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
) -> dict[int, dict]:
    feature = overlay_feature(image)
    result = {}
    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        tee_point = (tee['cx'], tee['cy'])
        number_point = (numbers[number]['cx'], numbers[number]['cy'])
        basket_point = basket_base(basket)
        first = track_segment(feature, tee_point, number_point)
        second = track_segment(feature, number_point, basket_point)
        centerline = np.vstack([first[:-1], second])
        result[number] = {
            'centerline': centerline,
            'polygon': estimate_polygon(feature, centerline),
        }
    return result


def render_overlay(
    image: np.ndarray,
    numbers: dict[int, dict],
    baskets: list[dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    basket_assignment: dict[int, int],
    corridors: dict[int, dict],
) -> np.ndarray:
    output = image.copy()
    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = basket_base(basket)
        cv2.circle(output, (int(tee['cx']), int(tee['cy'])), 5, (255, 0, 255), -1)
        cv2.circle(output, (int(bx), int(by)), 5, (0, 0, 255), -1)
        cv2.putText(
            output, str(number),
            (int(marker['cx']) + 4, int(marker['cy']) - 5),
            cv2.FONT_HERSHEY_SIMPLEX, .4, (0, 255, 255), 1, cv2.LINE_AA,
        )
        corridor = corridors[number]
        cv2.polylines(output, [np.int32(np.round(corridor['polygon']))], True, (255, 0, 255), 1)
        cv2.polylines(output, [np.int32(np.round(corridor['centerline']))], False, (0, 0, 255), 1)
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

    ui_scale, anchor_score = ui_scale_from_hole_one(gray, args.templates)
    numbers = detect_numbers(gray, args.templates, ui_scale)
    baskets = detect_baskets(gray, args.templates, ui_scale, map_y)
    tees = detect_tees(image, ui_scale, map_y)
    if len(numbers) != 18 or len(baskets) != 18 or len(tees) != 18:
        raise RuntimeError(
            f'static milestone not met: numbers={len(numbers)}, baskets={len(baskets)}, tees={len(tees)}'
        )

    tee_assignment = assign_tees(numbers, tees)
    basket_assignment = assign_baskets(numbers, tees, tee_assignment, baskets)
    corridors = build_corridors(
        image, numbers, tees, tee_assignment, baskets, basket_assignment
    )

    args.out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(
        str(args.out / 'static-parser-overlay.png'),
        render_overlay(
            image, numbers, baskets, tees,
            tee_assignment, basket_assignment, corridors,
        ),
    )

    proposals = []
    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = basket_base(basket)
        proposals.append({
            'number': number,
            'tee': {'xPx': tee['cx'], 'yPx': tee['cy']},
            'basket': {'xPx': bx, 'yPx': by},
            'corridor': [
                {'xPx': float(x), 'yPx': float(y)}
                for x, y in corridors[number]['polygon']
            ],
        })
    (args.out / 'proposals.json').write_text(json.dumps({'holes': proposals}, indent=2))

    report = {
        'uiScale': ui_scale,
        'holeOneScore': anchor_score,
        'counts': {'numbers': len(numbers), 'baskets': len(baskets), 'tees': len(tees)},
        'teeSupport': {
            'both': sum(len(tee['support']) == 2 for tee in tees),
            'grayOnly': sum(tee['support'] == ['gray-center'] for tee in tees),
            'edgeOnly': sum(tee['support'] == ['edge-loop'] for tee in tees),
        },
        'scope': (
            'Clean-course static parser probe. Icon detections are strong on the current fixture; '
            'basket/tee assignment and especially corridor polygons remain provisional review-layer proposals.'
        ),
    }
    (args.out / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
