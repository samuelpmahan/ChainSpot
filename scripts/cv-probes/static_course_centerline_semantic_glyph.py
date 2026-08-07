#!/usr/bin/env python3
"""Current clean-course semantic centerline probe with glyph-only badge labels.

This wraps static_course_centerline_semantic.py without duplicating its tracing
logic. The only pipeline change is that after the 18 physical number badges are
located, their interiors are reclassified from the numeral glyphs alone before
tee/basket association and centerline routing.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

import static_course_parser as v1

# The exploratory centerline modules were written against underscored helper
# names while static_course_parser.py later exposed the same helpers publicly.
# Patch the shared module object before importing those probes so this wrapper
# remains runnable on the current integration branch.
if not hasattr(v1, '_overlay_feature'):
    v1._overlay_feature = v1.overlay_feature
if not hasattr(v1, '_band_contrast'):
    v1._band_contrast = v1.band_contrast
if not hasattr(v1, '_track_segment'):
    v1._track_segment = v1.track_segment

import number_badge_classifier as number_classifier
import static_course_centerline as v2
import static_course_centerline_semantic as semantic


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
    numbers = number_classifier.detect_numbers(gray, args.templates, scale)
    baskets = v1.detect_baskets(gray, args.templates, scale, map_y)
    tees = v1.detect_tees(image, scale, map_y)
    if len(numbers) != 18 or len(baskets) != 18 or len(tees) != 18:
        raise RuntimeError(
            f'static milestone not met: numbers={len(numbers)}, baskets={len(baskets)}, tees={len(tees)}'
        )

    # TODO(shared-endpoints): these assignments currently enforce one physical
    # tee and one physical basket per hole. Support courses where several hole
    # labels share a tee and fan out to different baskets, or several tees feed
    # one shared basket. Physical endpoint detections should be reusable objects;
    # per-hole topology should reference them rather than require a bijection.
    tee_assignment = v1.assign_tees(numbers, tees)
    basket_assignment = v1.assign_baskets(numbers, tees, tee_assignment, baskets)

    centerlines, c1_radius, c2_radius = semantic.build_semantic_centerlines(
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
        marker = numbers[number]
        tee = tees[tee_assignment[number]]
        basket = baskets[basket_assignment[number]]
        bx, by = v1.basket_base(basket)
        route = centerlines[number]
        holes.append({
            'number': number,
            'numberBadge': {
                'xPx': marker['cx'],
                'yPx': marker['cy'],
                'glyphScore': marker['glyphScore'],
                'stageOneLabel': marker['legacyNumber'],
            },
            'tee': {'xPx': tee['cx'], 'yPx': tee['cy']},
            'basket': {'xPx': bx, 'yPx': by},
            'centerline': [
                {'xPx': float(x), 'yPx': float(y)} for x, y in route['centerline']
            ],
        })
    (args.out / 'proposals.json').write_text(json.dumps({'holes': holes}, indent=2))

    reassignments = [
        {
            'recognized': number,
            'stageOneLabel': numbers[number]['legacyNumber'],
            'glyphScore': numbers[number]['glyphScore'],
        }
        for number in range(1, 19)
        if numbers[number]['legacyNumber'] != number
    ]
    report = {
        'uiScale': scale,
        'holeOneScore': anchor_score,
        'counts': {'numbers': 18, 'baskets': 18, 'tees': 18, 'centerlines': 18},
        'numberClassifier': {
            'mode': 'located badge -> interior glyph template -> one-to-one assignment',
            'reassignments': reassignments,
        },
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
