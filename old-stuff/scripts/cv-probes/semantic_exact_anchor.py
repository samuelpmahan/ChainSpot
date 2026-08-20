#!/usr/bin/env python3
"""ChainSpot clean-course static parser: semantic centerline v4.

Key correction from the H5/H6 failure:
- the hole-number badge IS ownership/routing evidence for its own hole;
- the badge pixels themselves are foreground occlusion and must NOT be traced;
- another hole's tee next to the current basket is strong negative evidence for
  the current basket's C2 departure direction.

The centerline is therefore built as:
    own tee
      -> appearance trace to own-number occlusion boundary
      -> geometry-only bridge through own-number badge
      -> basket-backward appearance trace to C2
      -> geometry-only C2 bridge
      -> own basket stem base

This keeps the useful "trace backward and tolerate obstruction" idea while
preventing H5 from simply following H6's route out of H5's basket.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

import static_course_parser as v1
import number_badge_classifier as number_classifier


def radial_edge_score(
    gradient: np.ndarray,
    center: tuple[float, float],
    radius: float,
) -> float:
    height, width = gradient.shape
    cx, cy = center
    values = []
    for theta in np.linspace(0.0, 2.0 * math.pi, 180, endpoint=False):
        x = int(round(cx + radius * math.cos(theta)))
        y = int(round(cy + radius * math.sin(theta)))
        if 0 <= x < width and 0 <= y < height:
            values.append(float(gradient[y, x]))
    return float(np.mean(values)) if values else 0.0


def detect_putting_circle_radii(
    image: np.ndarray,
    baskets: list[dict],
) -> tuple[float, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gx, gy)
    centers = [v1.basket_base(basket) for basket in baskets]

    def best_radius(low: int, high: int) -> float:
        scored = []
        for radius in range(low, high + 1):
            per_basket = [
                radial_edge_score(gradient, center, radius)
                for center in centers
            ]
            scored.append((float(np.median(per_basket)), float(radius)))
        return max(scored)[1]

    return best_radius(15, 35), best_radius(36, 80)


def build_occlusion_mask(
    image: np.ndarray,
    numbers: dict[int, dict],
    baskets: list[dict],
    tees: list[dict],
    c2_radius: float,
) -> np.ndarray:
    """Known UDisc foreground should be crossed by continuity, not learned."""
    height, width = image.shape[:2]
    mask = np.zeros((height, width), np.uint8)

    for marker in numbers.values():
        pad = 10
        x0 = max(0, int(marker["x"] - pad))
        y0 = max(0, int(marker["y"] - pad))
        x1 = min(width - 1, int(marker["x"] + marker["width"] + pad))
        y1 = min(height - 1, int(marker["y"] + marker["height"] + pad))
        cv2.rectangle(mask, (x0, y0), (x1, y1), 255, -1)

    for basket in baskets:
        bx, by = v1.basket_base(basket)
        # Putting-circle graphics are aggressively excluded from appearance
        # evidence for EVERY hole, not just the hole being traced. The +10 px
        # halo also removes the strong C2 ring edge / antialiasing.
        cv2.circle(
            mask,
            (int(round(bx)), int(round(by))),
            int(round(c2_radius + 10.0)),
            255,
            -1,
        )

    for tee in tees:
        cv2.circle(
            mask,
            (int(round(tee["cx"])), int(round(tee["cy"]))),
            12,
            255,
            -1,
        )
    return mask


def patch_is_occluded(
    mask: np.ndarray,
    x: float,
    y: float,
    radius: int = 4,
) -> bool:
    height, width = mask.shape
    ix, iy = int(round(x)), int(round(y))
    x0, x1 = max(0, ix - radius), min(width, ix + radius + 1)
    y0, y1 = max(0, iy - radius), min(height, iy + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return True
    return float(np.mean(mask[y0:y1, x0:x1] > 0)) > 0.25


def line_samples(
    start: np.ndarray,
    end: np.ndarray,
    step: float = 5.5,
) -> np.ndarray:
    length = float(np.linalg.norm(end - start))
    count = max(3, int(math.ceil(length / step)) + 1)
    return np.array([
        start + (end - start) * i / (count - 1)
        for i in range(count)
    ])


def coast_segment(
    feature: np.ndarray,
    occlusion_mask: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
) -> np.ndarray:
    """Direction-sensitive local trace that coasts through missing evidence."""
    height, width = feature.shape
    base = line_samples(start, end)
    offsets = np.arange(-30.0, 30.1, 2.0)
    chosen = [base[0].copy()]
    previous_offset = 0.0
    lateral_velocity = 0.0

    for index in range(1, len(base) - 1):
        point = base[index]
        tangent = (
            base[min(index + 1, len(base) - 1)]
            - base[max(0, index - 1)]
        )
        tangent /= max(np.linalg.norm(tangent), 1e-9)
        normal = np.array([-tangent[1], tangent[0]])
        angle = math.degrees(math.atan2(tangent[1], tangent[0])) % 180.0
        predicted_offset = float(
            np.clip(previous_offset + lateral_velocity, -30.0, 30.0)
        )

        raw = []
        for offset in offsets:
            candidate = point + normal * offset
            x, y = candidate
            if not (6 < x < width - 6 and 6 < y < height - 6):
                continue
            occluded = patch_is_occluded(occlusion_mask, x, y)
            visual = v1._band_contrast(
                feature, x, y, angle, 20.0, 16.0
            )
            raw.append((
                float(offset),
                candidate,
                float(visual),
                bool(occluded),
            ))

        visible_scores = [
            visual
            for _, _, visual, occluded in raw
            if not occluded
        ]
        weak_evidence = (
            not visible_scores or max(visible_scores) < 5.0
        )

        candidates = []
        for offset, candidate, visual, occluded in raw:
            unknown = occluded or weak_evidence
            visual_term = (
                0.0
                if unknown
                else float(np.clip(visual, -30.0, 85.0))
            )
            continuity_penalty = 0.20 * (
                offset - predicted_offset
            ) ** 2
            guide_penalty = 0.010 * offset ** 2
            score = (
                1.12 * visual_term
                - continuity_penalty
                - guide_penalty
            )
            candidates.append((
                score,
                offset,
                candidate,
                unknown,
            ))

        if not candidates:
            chosen.append(point.copy())
            continue

        _, offset, selected, unknown = max(
            candidates,
            key=lambda row: row[0],
        )
        observed_velocity = float(
            np.clip(offset - previous_offset, -7.0, 7.0)
        )
        if unknown:
            new_velocity = lateral_velocity * 0.85
        else:
            new_velocity = (
                0.35 * lateral_velocity
                + 0.65 * observed_velocity
            )

        chosen.append(selected)
        previous_offset = float(offset)
        lateral_velocity = float(new_velocity)

    chosen.append(end.copy())
    points = np.asarray(chosen)

    if len(points) >= 5:
        # One light pass only. Two passes visibly rounded UDisc's intentional
        # dogleg corners into long gradual arcs.
        next_points = points.copy()
        for index in range(1, len(points) - 1):
            next_points[index] = (
                0.15 * points[index - 1]
                + 0.70 * points[index]
                + 0.15 * points[index + 1]
            )
        points = next_points

    points[0] = start
    points[-1] = end
    return points


def rectangle_exit_point(
    center: np.ndarray,
    toward: np.ndarray,
    marker: dict,
    pad: float = 8.0,
) -> np.ndarray:
    """Ray from badge center to first edge of its expanded occlusion box."""
    direction = toward - center
    length = float(np.linalg.norm(direction))
    if length < 1e-9:
        return center.copy()
    direction /= length

    x0 = float(marker["x"]) - pad
    x1 = float(marker["x"] + marker["width"]) + pad
    y0 = float(marker["y"]) - pad
    y1 = float(marker["y"] + marker["height"]) + pad

    intersections = []
    if abs(direction[0]) > 1e-9:
        intersections.extend([
            (x0 - center[0]) / direction[0],
            (x1 - center[0]) / direction[0],
        ])
    if abs(direction[1]) > 1e-9:
        intersections.extend([
            (y0 - center[1]) / direction[1],
            (y1 - center[1]) / direction[1],
        ])

    for distance in sorted(value for value in intersections if value > 0):
        point = center + direction * distance
        if (
            x0 - 1e-6 <= point[0] <= x1 + 1e-6
            and y0 - 1e-6 <= point[1] <= y1 + 1e-6
        ):
            return point

    return center + direction * max(
        float(marker["width"]),
        float(marker["height"]),
    )


def semantic_c2_entry(
    feature: np.ndarray,
    number_point: np.ndarray,
    basket_point: np.ndarray,
    c2_radius: float,
    tees: list[dict],
    own_tee_index: int,
) -> tuple[np.ndarray, float]:
    """Basket-backward C2 departure with foreign-tee repulsion.

    H5/H6 fixture:
    H6's tee is almost inside H5's putting circles. Pure appearance therefore
    sees H6's route as an excellent way to leave H5's basket. A ray aligned
    through another hole's tee this close to the current basket is explicitly
    bad semantic evidence for the current hole.
    """
    direct = number_point - basket_point
    direct_angle = math.atan2(direct[1], direct[0])

    foreign_tee_rays = []
    for tee_index, tee in enumerate(tees):
        if tee_index == own_tee_index:
            continue
        tee_point = np.array(
            [tee["cx"], tee["cy"]],
            dtype=float,
        )
        vector = tee_point - basket_point
        distance = float(np.linalg.norm(vector))
        if distance < c2_radius * 1.15:
            foreign_tee_rays.append((
                vector / max(distance, 1e-9),
                distance,
            ))

    best = None
    for delta_deg in range(-80, 81, 5):
        angle = direct_angle + math.radians(delta_deg)
        direction = np.array([
            math.cos(angle),
            math.sin(angle),
        ])
        entry = basket_point + direction * c2_radius

        visual_samples = []
        for radius in (
            c2_radius + 10.0,
            c2_radius + 22.0,
            c2_radius + 34.0,
        ):
            sample = basket_point + direction * radius
            visual_samples.append(
                float(np.clip(
                    v1._band_contrast(
                        feature,
                        sample[0],
                        sample[1],
                        math.degrees(angle) % 180.0,
                        20.0,
                        16.0,
                    ),
                    -30.0,
                    85.0,
                ))
            )
        visual = float(np.mean(visual_samples))

        score = visual - 0.020 * delta_deg * delta_deg

        for foreign_direction, foreign_distance in foreign_tee_rays:
            cosine = float(np.clip(
                direction.dot(foreign_direction),
                -1.0,
                1.0,
            ))
            angular_distance = math.degrees(math.acos(cosine))
            if angular_distance < 30.0:
                nearness = 1.0 - (
                    foreign_distance / (c2_radius * 1.15)
                )
                score -= (
                    (30.0 - angular_distance)
                    * 2.5
                    * nearness
                )

        candidate = (
            score,
            entry,
            math.degrees(angle),
        )
        if best is None or candidate[0] > best[0]:
            best = candidate

    assert best is not None
    return best[1], float(best[2])



def _segment_circle_entry(
    outside: np.ndarray,
    inside: np.ndarray,
    center: np.ndarray,
    radius: float,
) -> np.ndarray:
    """Exact first segment/circle intersection from outside toward inside."""
    d = inside - outside
    f = outside - center
    a = float(d.dot(d))
    b = 2.0 * float(f.dot(d))
    c = float(f.dot(f) - radius * radius)
    disc = max(0.0, b * b - 4.0 * a * c)
    roots = [
        (-b - math.sqrt(disc)) / (2.0 * a),
        (-b + math.sqrt(disc)) / (2.0 * a),
    ]
    valid = [t for t in roots if 0.0 <= t <= 1.0]
    t = min(valid) if valid else 1.0
    return outside + t * d


def trace_number_center_to_c2(
    feature: np.ndarray,
    occlusion_mask: np.ndarray,
    number_point: np.ndarray,
    basket_point: np.ndarray,
    c2_radius: float,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Trace visible centerline from number center and stop exactly at C2.

    Crucially, the trace never asks the putting-circle pixels where the route
    goes. Every C1/C2 disk in the course is already masked. We trace toward the
    known basket terminal, then keep only the visible portion up to the first
    C2 crossing. The returned C2 entry ("green dot") is therefore guaranteed
    to lie on the selected centerline.
    """
    tracked = coast_segment(
        feature,
        occlusion_mask,
        number_point,
        basket_point,
    )
    distances = np.linalg.norm(tracked - basket_point, axis=1)

    inside_indices = np.where(distances <= c2_radius)[0]
    if len(inside_indices) == 0:
        # Extremely defensive fallback: geometric entry along final segment.
        direction = number_point - basket_point
        direction /= max(float(np.linalg.norm(direction)), 1e-9)
        entry = basket_point + direction * c2_radius
        outside = np.vstack([tracked, entry])
    else:
        first_inside = int(inside_indices[0])
        if first_inside == 0:
            entry = tracked[0].copy()
            outside = np.asarray([entry])
        else:
            entry = _segment_circle_entry(
                tracked[first_inside - 1],
                tracked[first_inside],
                basket_point,
                c2_radius,
            )
            outside = np.vstack([
                tracked[:first_inside],
                entry,
            ])

    angle = math.degrees(math.atan2(
        entry[1] - basket_point[1],
        entry[0] - basket_point[0],
    ))
    return outside, entry, angle


def _polyline_circle_first_crossing(
    points: np.ndarray,
    center: np.ndarray,
    radius: float,
) -> tuple[int, np.ndarray] | None:
    distances = np.linalg.norm(points - center, axis=1)
    for index in range(1, len(points)):
        if distances[index - 1] > radius and distances[index] <= radius:
            return index, _segment_circle_entry(
                points[index - 1],
                points[index],
                center,
                radius,
            )
    return None


def _ribbon_side_points_and_midpoint(
    feature: np.ndarray,
    crossing: np.ndarray,
    tangent: np.ndarray,
    basket_point: np.ndarray,
    radius: float,
    search_half_width: int = 26,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Find the two ribbon sides at a putting-circle crossing, then midpoint.

    This is intentionally the ONLY place where we inspect raw appearance inside
    the otherwise-masked putting-circle region.

    The local path tangent defines a cross-section normal. Along that normal we
    sample the UDisc ribbon signal, find a rising edge and a falling edge that
    bound a plausible ribbon-width plateau, create explicit side points, then
    force the path through their midpoint.

    Side points and midpoint are finally projected back onto the exact circle
    radius so the anchors really are circle/ribbon intersections.
    """
    tangent = np.asarray(tangent, dtype=float)
    tangent /= max(float(np.linalg.norm(tangent)), 1e-9)
    normal = np.array([-tangent[1], tangent[0]], dtype=float)

    offsets = np.arange(-search_half_width, search_half_width + 1, dtype=float)
    values = []

    # Average several parallel samples to suppress dashed-circle / ring pixels.
    tangent_offsets = (-3.0, 0.0, 3.0)
    for offset in offsets:
        samples = []
        for along in tangent_offsets:
            point = crossing + normal * offset + tangent * along
            x = int(round(point[0]))
            y = int(round(point[1]))
            if 0 <= x < feature.shape[1] and 0 <= y < feature.shape[0]:
                samples.append(float(feature[y, x]))
        values.append(float(np.mean(samples)) if samples else -1e9)

    values = np.asarray(values, dtype=float)
    # Small smoothing only; enough to remove pixel noise without rounding the
    # actual ribbon boundaries we are trying to measure.
    kernel = np.ones(3, dtype=float) / 3.0
    smooth = np.convolve(values, kernel, mode="same")
    gradient = np.gradient(smooth)

    # Search edge pairs globally across the local cross-section. The ribbon is
    # expected to be roughly 8..30 px wide on this fixture/scale. A good pair:
    #   outside -> ribbon : positive gradient
    #   ribbon -> outside : negative gradient
    # and the interior plateau should score above the immediate exterior.
    best = None
    for left_index in range(2, len(offsets) - 3):
        for right_index in range(left_index + 1, len(offsets) - 2):
            width = offsets[right_index] - offsets[left_index]
            if not 8.0 <= width <= 30.0:
                continue

            left_edge = float(gradient[left_index])
            right_edge = float(-gradient[right_index])
            if left_edge <= 0.0 or right_edge <= 0.0:
                continue

            inside = smooth[left_index + 1:right_index]
            if len(inside) == 0:
                continue
            outside_left = smooth[max(0, left_index - 5):left_index]
            outside_right = smooth[right_index + 1:min(len(smooth), right_index + 6)]
            if len(outside_left) == 0 or len(outside_right) == 0:
                continue

            interior_advantage = float(
                np.mean(inside)
                - 0.5 * (np.mean(outside_left) + np.mean(outside_right))
            )

            midpoint_offset = 0.5 * (offsets[left_index] + offsets[right_index])
            score = (
                2.0 * left_edge
                + 2.0 * right_edge
                + 0.8 * interior_advantage
                - 0.025 * midpoint_offset * midpoint_offset
                - 0.015 * (width - 16.0) ** 2
            )
            candidate = (
                score,
                left_index,
                right_index,
            )
            if best is None or candidate[0] > best[0]:
                best = candidate

    if best is None:
        # Keep the geometric crossing if no credible side pair exists.
        left = crossing + normal * -7.0
        right = crossing + normal * 7.0
    else:
        _, left_index, right_index = best
        left = crossing + normal * offsets[left_index]
        right = crossing + normal * offsets[right_index]

    def project_to_circle(point: np.ndarray) -> np.ndarray:
        vector = point - basket_point
        vector /= max(float(np.linalg.norm(vector)), 1e-9)
        return basket_point + vector * radius

    left = project_to_circle(left)
    right = project_to_circle(right)

    # Midpoint of the two side intersections, reprojected to the circle.
    midpoint_vector = 0.5 * (left + right) - basket_point
    midpoint_vector /= max(float(np.linalg.norm(midpoint_vector)), 1e-9)
    midpoint = basket_point + midpoint_vector * radius
    return left, right, midpoint


def _force_circle_side_midpoint_anchor(
    points: np.ndarray,
    feature: np.ndarray,
    basket_point: np.ndarray,
    radius: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    crossing_info = _polyline_circle_first_crossing(
        points,
        basket_point,
        radius,
    )
    if crossing_info is None:
        crossing = points[-1].copy()
        tangent = points[-1] - points[-2]
        left, right, midpoint = _ribbon_side_points_and_midpoint(
            feature,
            crossing,
            tangent,
            basket_point,
            radius,
        )
        return points, left, right, midpoint

    index, crossing = crossing_info
    tangent = points[index] - points[index - 1]
    left, right, midpoint = _ribbon_side_points_and_midpoint(
        feature,
        crossing,
        tangent,
        basket_point,
        radius,
    )

    # Hard anchor: preserve the route only up to the crossing, then replace the
    # crossing itself with the measured ribbon midpoint.
    forced = np.vstack([points[:index], midpoint])
    return forced, left, right, midpoint


def cubic_bridge(
    first: np.ndarray,
    second: np.ndarray,
    step: float = 5.0,
) -> np.ndarray:
    """Geometry-only bridge through a known foreground occlusion."""
    p0 = first[-1]
    p3 = second[0]
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

    p1 = p0 + t0 * (distance * 0.35)
    p2 = p3 - t1 * (distance * 0.35)
    count = max(4, int(math.ceil(distance / step)) + 1)

    result = []
    for t in np.linspace(0.0, 1.0, count):
        u = 1.0 - t
        result.append(
            (u ** 3) * p0
            + 3.0 * (u ** 2) * t * p1
            + 3.0 * u * (t ** 2) * p2
            + (t ** 3) * p3
        )
    return np.asarray(result)


def cubic_terminal_segment(
    entry: np.ndarray,
    basket: np.ndarray,
    incoming_tangent: np.ndarray,
    step: float = 7.0,
) -> np.ndarray:
    vector = basket - entry
    distance = float(np.linalg.norm(vector))
    if distance < 1e-6:
        return np.asarray([entry, basket])

    radial = vector / distance
    tangent = incoming_tangent / max(
        np.linalg.norm(incoming_tangent),
        1e-9,
    )
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


def build_centerlines(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
) -> tuple[dict[int, dict], float, float]:
    feature = v1._overlay_feature(image)
    c1_radius, c2_radius = detect_putting_circle_radii(
        image,
        baskets,
    )
    occlusion_mask = build_occlusion_mask(
        image,
        numbers,
        baskets,
        tees,
        c2_radius,
    )

    result = {}
    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]

        tee_point = np.array(
            [tee["cx"], tee["cy"]],
            dtype=float,
        )
        number_point = np.array(
            [marker["cx"], marker["cy"]],
            dtype=float,
        )
        basket_point = np.array(
            v1.basket_base(basket),
            dtype=float,
        )

        # The UDisc hole-number badge center is a ground-truth point on
        # the hole centerline. Its pixels are foreground occlusion, but the
        # center itself is a hard anchor.
        tee_side = rectangle_exit_point(
            number_point,
            tee_point,
            marker,
        )
        tee_to_number = coast_segment(
            feature,
            occlusion_mask,
            tee_point,
            tee_side,
        )

        # Trace outward FROM the exact number center while every putting circle
        # on the course is masked. Stop where that selected centerline first
        # intersects this hole's C2. This makes the C2 entry a consequence of
        # the route rather than an independent noisy detection.
        number_to_c2, c2_entry, entry_angle = trace_number_center_to_c2(
            feature,
            occlusion_mask,
            number_point,
            basket_point,
            c2_radius,
        )

        outside_c2 = np.vstack([
            tee_to_number[:-1],
            tee_side,
            number_to_c2,
        ])

        # Force BOTH putting-circle crossings through the visible ribbon
        # midpoint. C2 is the green anchor; C1 is the orange anchor. Neither
        # circle contributes appearance evidence itself.
        outside_c2, c2_left, c2_right, c2_entry = _force_circle_side_midpoint_anchor(
            outside_c2,
            feature,
            basket_point,
            c2_radius,
        )

        # Build the terminal once to discover its C1 crossing, then hard-anchor
        # that crossing and rebuild the two terminal pieces around it.
        incoming = (
            outside_c2[-1] - outside_c2[-2]
            if len(outside_c2) >= 2
            else basket_point - c2_entry
        )
        terminal = cubic_terminal_segment(
            c2_entry,
            basket_point,
            incoming,
        )

        terminal_to_c1, c1_left, c1_right, c1_entry = _force_circle_side_midpoint_anchor(
            terminal,
            feature,
            basket_point,
            c1_radius,
        )

        # Preserve BOTH measured circle/ribbon midpoints explicitly.
        # C2 -> C1 and C1 -> basket are geometry-only; neither putting-circle
        # fill/ring is allowed to bend the line afterward.
        terminal = np.vstack([
            terminal_to_c1,
            basket_point,
        ])

        terminal_start = len(outside_c2) - 1
        centerline = np.vstack([
            outside_c2[:-1],
            terminal,
        ])

        result[number] = {
            "centerline": centerline,
            "terminalStartIndex": terminal_start,
            "c2Entry": c2_entry,
            "c2Left": c2_left,
            "c2Right": c2_right,
            "c1Entry": c1_entry,
            "c1Left": c1_left,
            "c1Right": c1_right,
            "c2EntryAngleDeg": entry_angle,
            "numberTeeSide": tee_side,
            "numberCenterAnchor": number_point,
        }

    return result, c1_radius, c2_radius


def render_one(
    image: np.ndarray,
    number: int,
    marker: dict,
    tee: dict,
    basket: dict,
    route: dict,
    c1_radius: float,
    c2_radius: float,
) -> np.ndarray:
    output = image.copy()
    bx, by = v1.basket_base(basket)
    points = np.int32(np.round(route["centerline"]))
    terminal_index = int(route["terminalStartIndex"])

    cv2.rectangle(
        output,
        (int(marker["x"]), int(marker["y"])),
        (
            int(marker["x"] + marker["width"]),
            int(marker["y"] + marker["height"]),
        ),
        (0, 255, 255),
        1,
    )
    cv2.putText(
        output,
        f"H{number}",
        (int(marker["x"]), max(12, int(marker["y"]) - 4)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.34,
        (0, 255, 255),
        1,
        cv2.LINE_AA,
    )

    cv2.circle(
        output,
        (int(round(tee["cx"])), int(round(tee["cy"]))),
        6,
        (255, 0, 255),
        1,
    )
    cv2.circle(
        output,
        (int(round(tee["cx"])), int(round(tee["cy"]))),
        2,
        (255, 0, 255),
        -1,
    )

    cv2.rectangle(
        output,
        (int(basket["x"]), int(basket["y"])),
        (
            int(basket["x"] + basket["width"]),
            int(basket["y"] + basket["height"]),
        ),
        (255, 255, 0),
        1,
    )
    cv2.circle(
        output,
        (int(round(bx)), int(round(by))),
        4,
        (0, 0, 255),
        -1,
    )
    cv2.circle(
        output,
        (int(round(bx)), int(round(by))),
        int(round(c1_radius)),
        (0, 170, 255),
        1,
    )
    cv2.circle(
        output,
        (int(round(bx)), int(round(by))),
        int(round(c2_radius)),
        (0, 220, 0),
        1,
    )

    # Blue = appearance-tracked / semantic path outside C2.
    # Red = deliberate geometry-only C2 terminal.
    if terminal_index >= 2:
        cv2.polylines(
            output,
            [points[: terminal_index + 1]],
            False,
            (255, 80, 0),
            2,
            cv2.LINE_AA,
        )
    if terminal_index < len(points):
        cv2.polylines(
            output,
            [points[terminal_index:]],
            False,
            (0, 0, 255),
            2,
            cv2.LINE_AA,
        )

    c2_entry = route["c2Entry"]
    for side in (route["c2Left"], route["c2Right"]):
        cv2.circle(
            output,
            (int(round(side[0])), int(round(side[1]))),
            3,
            (255, 255, 0),
            -1,
        )
    cv2.circle(
        output,
        (int(round(c2_entry[0])), int(round(c2_entry[1]))),
        4,
        (0, 255, 0),
        -1,
    )

    c1_entry = route["c1Entry"]
    for side in (route["c1Left"], route["c1Right"]):
        cv2.circle(
            output,
            (int(round(side[0])), int(round(side[1]))),
            3,
            (0, 255, 255),
            -1,
        )
    cv2.circle(
        output,
        (int(round(c1_entry[0])), int(round(c1_entry[1]))),
        4,
        (0, 170, 255),
        -1,
    )
    return output


def render_full_overlay(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
    centerlines: dict[int, dict],
    c1_radius: float,
    c2_radius: float,
) -> np.ndarray:
    output = image.copy()
    for number in range(1, 19):
        output = render_one(
            output,
            number,
            numbers[number],
            tees[tee_assignment[number]],
            baskets[basket_assignment[number]],
            centerlines[number],
            c1_radius,
            c2_radius,
        )
    return output


def contact_sheet(
    image: np.ndarray,
    numbers: dict[int, dict],
    tees: list[dict],
    tee_assignment: dict[int, int],
    baskets: list[dict],
    basket_assignment: dict[int, int],
    centerlines: dict[int, dict],
    c1_radius: float,
    c2_radius: float,
) -> np.ndarray:
    height, width = image.shape[:2]
    tiles = []

    for number in range(1, 19):
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = v1.basket_base(basket)
        route = centerlines[number]
        points = route["centerline"]

        xs = [*points[:, 0], marker["cx"], tee["cx"], bx]
        ys = [*points[:, 1], marker["cy"], tee["cy"], by]
        pad = 60
        x0 = max(0, int(min(xs) - pad))
        x1 = min(width, int(max(xs) + pad))
        y0 = max(0, int(min(ys) - pad))
        y1 = min(height, int(max(ys) + pad))

        crop = image[y0:y1, x0:x1].copy()

        local_marker = dict(marker)
        for key in ("x", "cx"):
            local_marker[key] -= x0
        for key in ("y", "cy"):
            local_marker[key] -= y0

        local_tee = dict(tee)
        local_tee["cx"] -= x0
        local_tee["cy"] -= y0

        local_basket = dict(basket)
        local_basket["x"] -= x0
        local_basket["y"] -= y0

        local_route = dict(route)
        local_route["centerline"] = (
            points - np.array([x0, y0])
        )
        for key in ("c2Entry", "c2Left", "c2Right", "c1Entry", "c1Left", "c1Right"):
            local_route[key] = route[key] - np.array([x0, y0])

        local = render_one(
            crop,
            number,
            local_marker,
            local_tee,
            local_basket,
            local_route,
            c1_radius,
            c2_radius,
        )

        tile = np.zeros((250, 300, 3), np.uint8)
        scale = min(
            300.0 / local.shape[1],
            250.0 / local.shape[0],
        )
        resized = cv2.resize(
            local,
            (
                max(1, int(local.shape[1] * scale)),
                max(1, int(local.shape[0] * scale)),
            ),
            interpolation=cv2.INTER_AREA,
        )
        oy = (250 - resized.shape[0]) // 2
        ox = (300 - resized.shape[1]) // 2
        tile[
            oy:oy + resized.shape[0],
            ox:ox + resized.shape[1],
        ] = resized
        tiles.append(tile)

    return np.vstack([
        np.hstack(tiles[row * 3:(row + 1) * 3])
        for row in range(6)
    ])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--map-top", type=int, default=400)
    parser.add_argument("--map-bottom", type=int, default=1350)
    args = parser.parse_args()

    image = cv2.imread(str(args.image))
    if image is None:
        raise RuntimeError(f"could not decode {args.image}")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    map_y = (args.map_top, args.map_bottom)

    ui_scale, anchor_score = v1.ui_scale_from_hole_one(
        gray,
        args.templates,
    )
    numbers = number_classifier.detect_numbers(
        gray,
        args.templates,
        ui_scale,
    )
    baskets = v1.detect_baskets(
        gray,
        args.templates,
        ui_scale,
        map_y,
    )
    tees = v1.detect_tees(
        image,
        ui_scale,
        map_y,
    )

    if len(numbers) != 18 or len(baskets) != 18 or len(tees) != 18:
        raise RuntimeError(
            "static milestone not met: "
            f"numbers={len(numbers)}, "
            f"baskets={len(baskets)}, "
            f"tees={len(tees)}"
        )

    # TODO(shared-endpoints): the current Hungarian endpoint assignment is one-to-one.
    # Support layouts where multiple hole labels share one physical tee and fan out
    # to different baskets, or multiple tees converge on one physical basket. Keep
    # physical endpoint detection separate from per-hole endpoint references.
    tee_assignment = v1.assign_tees(
        numbers,
        tees,
    )
    basket_assignment = v1.assign_baskets(
        numbers,
        tees,
        tee_assignment,
        baskets,
    )
    centerlines, c1_radius, c2_radius = build_centerlines(
        image,
        numbers,
        tees,
        tee_assignment,
        baskets,
        basket_assignment,
    )

    args.out.mkdir(parents=True, exist_ok=True)

    cv2.imwrite(
        str(args.out / "static-centerline-overlay.png"),
        render_full_overlay(
            image,
            numbers,
            tees,
            tee_assignment,
            baskets,
            basket_assignment,
            centerlines,
            c1_radius,
            c2_radius,
        ),
    )
    cv2.imwrite(
        str(args.out / "all-18-contact-sheet.png"),
        contact_sheet(
            image,
            numbers,
            tees,
            tee_assignment,
            baskets,
            basket_assignment,
            centerlines,
            c1_radius,
            c2_radius,
        ),
    )

    proposals = []
    for number in range(1, 19):
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = v1.basket_base(basket)
        route = centerlines[number]
        proposals.append({
            "number": number,
            "numberBadge": {
                "xPx": numbers[number]["cx"],
                "yPx": numbers[number]["cy"],
                "score": numbers[number]["score"],
            },
            "tee": {
                "xPx": tee["cx"],
                "yPx": tee["cy"],
                "support": tee["support"],
            },
            "basket": {
                "xPx": bx,
                "yPx": by,
                "score": basket["score"],
            },
            "centerline": [
                {"xPx": float(x), "yPx": float(y)}
                for x, y in route["centerline"]
            ],
            "c2Entry": {
                "xPx": float(route["c2Entry"][0]),
                "yPx": float(route["c2Entry"][1]),
            },
        })

    (args.out / "proposals.json").write_text(
        json.dumps({"holes": proposals}, indent=2)
    )

    report = {
        "uiScale": ui_scale,
        "holeOneScore": anchor_score,
        "counts": {
            "numbers": len(numbers),
            "baskets": len(baskets),
            "tees": len(tees),
            "centerlines": len(centerlines),
        },
        "puttingCircles": {
            "c1RadiusPx": c1_radius,
            "c2RadiusPx": c2_radius,
        },
        "semanticRules": [
            "own number badge is a mandatory routing/ownership waypoint",
            "number badge pixels are treated as occlusion and bridged geometrically",
            "basket side is traced backward from C2 toward the own-number waypoint",
            "C2 departure rays aligned through nearby foreign tees are penalized",
            "pixels inside C2 are ignored and the terminal is reconstructed to basket stem base",
        ],
        "scope": (
            "Clean-course semantic centerline v4. The H5/H6 failure is treated "
            "as an ownership/topology problem rather than a generic appearance "
            "problem: H5 must route through H5's number while H6's tee beside "
            "H5's basket is negative evidence for H5's basket-backward trace."
        ),
    }
    (args.out / "report.json").write_text(
        json.dumps(report, indent=2)
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
