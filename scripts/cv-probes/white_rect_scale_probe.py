#!/usr/bin/env python3
"""White-rectangular-FRAME map-scale probe.

Tee pads render as a white rectangular RIM around a darker interior — a
frame, not a filled blob. Frames are a far rarer shape than bright pixels
generally: putting-circle (C2) dashes, path dashes, buildings, and parking
stripes are either filled or hole-less, so requiring an enclosed interior
hole rejects them without knowing what they are. Pad frames are painted on
the terrain itself, so their pixel size tracks map zoom directly — the
median frame major-axis is a candidate worldScale anchor that assumes
nothing about how UDisc scales its UI chrome.

Run on two captures of the same course at different zooms (IMG_5641 vs the
stitched ReferenceStitch): if the median frame-size ratio matches the known
terrain ratio (~1.5x), white-frame masking is a valid per-image scale base
for sizing the tuned tee detectors.

Usage: python3 scripts/cv-probes/white_rect_scale_probe.py [--render]
"""
import argparse, json, sys
from pathlib import Path
import numpy as np
import cv2

REPO = Path(__file__).resolve().parents[2]
INPUTS = [
    REPO / 'resources/ribbon-reference/IMG_5641.jpg',
    REPO / 'resources/real-capture/ReferenceStitch.png',
]
OUT = REPO / 'scripts/cv-probes/hole-path-results'

# Bright mask: same spirit as teePadDetection's putting-circle brightness
# gate (high value, low saturation), but standalone.
VALUE_MIN = 175
SATURATION_MAX = 60
# Frame gates (unitless / relative, so they hold at any zoom):
MIN_RECT_MAJOR_PX = 10       # below this a rim is sub-pixel mush at any plausible zoom
MAX_AREA_FRACTION = 1e-3     # drop buildings/roads relative to image area
ASPECT_MIN, ASPECT_MAX = 1.05, 2.2  # pad outer aspect measured 1.38-1.47; loose band
RECTANGULARITY_MIN = 0.75    # outer contour area / minAreaRect area
HOLE_FRACTION_MIN = 0.25     # interior hole area / outer contour area: frames are mostly hole
FRAME_FILL_MAX = 0.75        # 1 - hole fraction bound from the other side (reject near-filled)
BORDER_MARGIN_PX = 4
# Interior brightness: pad interiors are mid-gray terrain paint; number-badge
# interiors are near-black UI fill. This is the one gate that splits the two
# frame families when their pixel sizes overlap (they do on the stitch).
INTERIOR_VALUE_MIN = 70
INTERIOR_VALUE_MAX = 220


def analyze(path: Path, render: bool):
    bgr = cv2.imread(str(path))
    if bgr is None:
        return {'path': str(path), 'error': 'unreadable'}
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    mask = ((hsv[..., 2] >= VALUE_MIN) & (hsv[..., 1] <= SATURATION_MAX)).astype(np.uint8)
    height, width = mask.shape
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    majors, kept = [], []
    max_area = MAX_AREA_FRACTION * width * height
    if hierarchy is None:
        hierarchy = np.empty((1, 0, 4), dtype=np.int32)
    for index, contour in enumerate(contours):
        next_i, prev_i, child, parent = hierarchy[0][index]
        if parent != -1:
            continue  # only outer contours
        if child == -1:
            continue  # no interior hole -> not a frame
        outer_area = cv2.contourArea(contour)
        if outer_area <= 0 or outer_area > max_area:
            continue
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(contour)
        major, minor = max(rw, rh), min(rw, rh)
        if major < MIN_RECT_MAJOR_PX or minor < 4:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        if x < BORDER_MARGIN_PX or y < BORDER_MARGIN_PX:
            continue
        if x + w > width - BORDER_MARGIN_PX or y + h > height - BORDER_MARGIN_PX:
            continue
        rect_area = rw * rh
        if rect_area <= 0 or outer_area / rect_area < RECTANGULARITY_MIN:
            continue
        aspect = major / minor
        if not (ASPECT_MIN <= aspect <= ASPECT_MAX):
            continue
        # Sum every interior hole of this outer contour.
        hole_area = 0.0
        cursor = child
        while cursor != -1:
            hole_area += cv2.contourArea(contours[cursor])
            cursor = hierarchy[0][cursor][0]
        hole_fraction = hole_area / outer_area
        frame_fill = (outer_area - hole_area) / outer_area
        if hole_fraction < HOLE_FRACTION_MIN or frame_fill > FRAME_FILL_MAX:
            continue
        # Interior brightness: median V of the non-bright pixels inside the
        # bounding box. Pads read mid-gray; badge interiors read near-black.
        interior = hsv[y:y + h, x:x + w, 2][mask[y:y + h, x:x + w] == 0]
        if interior.size == 0:
            continue
        interior_value = float(np.median(interior))
        if not (INTERIOR_VALUE_MIN <= interior_value <= INTERIOR_VALUE_MAX):
            continue
        majors.append(float(major))
        kept.append((x, y, w, h, float(major), float(aspect), float(hole_fraction)))
    majors_arr = np.array(majors)
    result = {
        'path': str(path.relative_to(REPO)),
        'imageWidthPx': int(width),
        'imageHeightPx': int(height),
        'frames': len(majors),
        'medianMajorPx': round(float(np.median(majors_arr)), 1) if len(majors) else None,
        'p25MajorPx': round(float(np.percentile(majors_arr, 25)), 1) if len(majors) else None,
        'p75MajorPx': round(float(np.percentile(majors_arr, 75)), 1) if len(majors) else None,
        'majorsPx': sorted(round(m, 1) for m in majors),
    }
    if render:
        overlay = bgr.copy()
        for x, y, w, h, major, aspect, hole_fraction in kept:
            cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 0, 255), 2)
            cv2.putText(overlay, f'{major:.0f}', (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
        out_path = OUT / f'white-rect-scale-{path.stem}.png'
        cv2.imwrite(str(out_path), overlay)
        result['renderPath'] = str(out_path.relative_to(REPO))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--render', action='store_true', help='write per-image overlays of kept frames')
    args = parser.parse_args()
    rows = [analyze(path, args.render) for path in INPUTS]
    print(json.dumps(rows, indent=2))
    if len(rows) == 2 and rows[0].get('medianMajorPx') and rows[1].get('medianMajorPx'):
        ratio = rows[1]['medianMajorPx'] / rows[0]['medianMajorPx']
        print(f"median white-frame ratio (stitch / IMG_5641): {ratio:.3f}", file=sys.stderr)


if __name__ == '__main__':
    main()
