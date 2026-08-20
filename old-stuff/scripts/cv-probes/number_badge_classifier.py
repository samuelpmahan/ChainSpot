#!/usr/bin/env python3
"""Second-stage UDisc hole-label classifier.

The existing static parser is excellent at locating the physical badge boxes,
but a full-badge template score is dominated by the identical black rounded
rectangle and white border. Once all badge locations are known, reclassify
using only the interior numeral glyphs.

TODO(number-range): generalize template discovery and assignment from 1..18 to
1..50 rather than assuming a conventional 18-hole course.

TODO(alphanumeric-hole-labels): support number+letter labels such as 9a / 9b.
That should use a string/structured hole label rather than an int key and
classify the interior as a glyph sequence instead of a fixed numeric template.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

import static_course_parser as legacy


SUPPORTED_LABELS = tuple(range(1, 19))


def _interior_template(gray_template: np.ndarray) -> np.ndarray:
    """Remove the common badge border and keep the discriminative glyph area."""
    margin_y = max(3, int(round(gray_template.shape[0] * .18)))
    margin_x = max(4, int(round(gray_template.shape[1] * .16)))
    return gray_template[
        margin_y:gray_template.shape[0] - margin_y,
        margin_x:gray_template.shape[1] - margin_x,
    ]


def _glyph_score(
    gray: np.ndarray,
    center: tuple[float, float],
    template: np.ndarray,
    search_radius: int = 3,
) -> float:
    """Small local search because stage-one badge centers can be off a pixel."""
    inner = _interior_template(template)
    cx, cy = center
    expected_x = int(round(cx - inner.shape[1] / 2))
    expected_y = int(round(cy - inner.shape[0] / 2))

    x0 = max(0, expected_x - search_radius)
    y0 = max(0, expected_y - search_radius)
    x1 = min(gray.shape[1], expected_x + inner.shape[1] + search_radius)
    y1 = min(gray.shape[0], expected_y + inner.shape[0] + search_radius)
    roi = gray[y0:y1, x0:x1]
    if roi.shape[0] < inner.shape[0] or roi.shape[1] < inner.shape[1]:
        return -1.0

    response = cv2.matchTemplate(roi, inner, cv2.TM_CCOEFF_NORMED)
    return float(response.max())


def detect_numbers(
    gray: np.ndarray,
    templates: Path,
    ui_scale: float,
) -> dict[int, dict]:
    """Locate badge boxes first, then classify only the numeral inside each box."""
    preliminary = legacy.detect_numbers(gray, templates, ui_scale)
    candidates = list(preliminary.values())
    if len(candidates) != len(SUPPORTED_LABELS):
        raise RuntimeError(
            f'expected {len(SUPPORTED_LABELS)} located number badges, got {len(candidates)}'
        )

    resized_templates: dict[int, np.ndarray] = {}
    for label in SUPPORTED_LABELS:
        source = cv2.imread(str(templates / f'hole-{label:02d}.png'))
        if source is None:
            raise RuntimeError(f'missing hole-{label:02d}.png')
        canonical = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
        resized_templates[label] = legacy.resize_template(canonical, ui_scale)

    scores = np.zeros((len(candidates), len(SUPPORTED_LABELS)), dtype=np.float64)
    for candidate_index, candidate in enumerate(candidates):
        center = (candidate['cx'], candidate['cy'])
        for label_index, label in enumerate(SUPPORTED_LABELS):
            scores[candidate_index, label_index] = _glyph_score(
                gray,
                center,
                resized_templates[label],
            )

    rows, cols = linear_sum_assignment(-scores)
    result: dict[int, dict] = {}
    for candidate_index, label_index in zip(rows, cols):
        label = SUPPORTED_LABELS[int(label_index)]
        candidate = dict(candidates[int(candidate_index)])
        template = resized_templates[label]
        legacy_number = int(candidate.get('number', label))

        # Recenter the final badge rectangle using the dimensions of the label
        # we actually recognized, rather than the stage-one provisional label.
        candidate['number'] = label
        candidate['legacyNumber'] = legacy_number
        candidate['glyphScore'] = float(scores[candidate_index, label_index])
        candidate['score'] = candidate['glyphScore']
        candidate['width'] = int(template.shape[1])
        candidate['height'] = int(template.shape[0])
        candidate['x'] = int(round(candidate['cx'] - template.shape[1] / 2))
        candidate['y'] = int(round(candidate['cy'] - template.shape[0] / 2))
        result[label] = candidate

    return result
