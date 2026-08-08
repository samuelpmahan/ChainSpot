#!/usr/bin/env python3
"""Consume ChainSpot ribbon-golden JSON in OpenCV probes.

The UI deliberately stores the two gutters independently.  This helper turns
them into the two useful derived products without throwing that information
away:

* a closed polygon / binary mask for scoring a predicted ribbon;
* a centerline obtained by arc-length-resampling each gutter independently and
  taking pairwise midpoints ("bowl through the gutters").

Example:
    python scripts/cv-probes/golden_ribbon.py \
        hole-1-3-ribbon-golden.json --hole 1 \
        --mask /tmp/h1-mask.png --centerline /tmp/h1-centerline.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def load_golden(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    if data.get("schemaVersion") != 1:
        raise ValueError(f"unsupported ribbon golden schema: {data.get('schemaVersion')!r}")
    if data.get("coordinateSpace") != "source-image-px":
        raise ValueError("ribbon golden must use source-image-px coordinates")

    source = data.get("source")
    holes = data.get("holes")
    if not isinstance(source, dict) or not isinstance(holes, list):
        raise ValueError("ribbon golden is missing source/holes")

    width = int(source["widthPx"])
    height = int(source["heightPx"])
    if width <= 0 or height <= 0:
        raise ValueError("source dimensions must be positive")

    return data


def hole_by_number(golden: dict[str, Any], number: int) -> dict[str, Any]:
    for hole in golden["holes"]:
        if int(hole.get("number", -1)) == number:
            return hole
    raise ValueError(f"ribbon golden has no hole {number}")


def edge_array(hole: dict[str, Any], key: str) -> np.ndarray:
    points = np.asarray(
        [[float(point["xPx"]), float(point["yPx"])] for point in hole.get(key, [])],
        dtype=np.float64,
    )
    if points.ndim != 2 or points.shape[1:] != (2,):
        raise ValueError(f"{key} must contain xPx/yPx points")
    if len(points) < 2:
        raise ValueError(f"{key} needs at least two points")
    return points


def ribbon_polygon(hole: dict[str, Any]) -> np.ndarray:
    left = edge_array(hole, "leftEdge")
    right = edge_array(hole, "rightEdge")
    return np.vstack([left, right[::-1]])


def ribbon_mask(golden: dict[str, Any], number: int) -> np.ndarray:
    source = golden["source"]
    width = int(source["widthPx"])
    height = int(source["heightPx"])
    polygon = np.rint(ribbon_polygon(hole_by_number(golden, number))).astype(np.int32)

    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(mask, [polygon], 255)
    return mask


def resample_polyline(points: np.ndarray, samples: int) -> np.ndarray:
    if samples < 2:
        raise ValueError("samples must be >= 2")

    segment_lengths = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cumulative = np.concatenate([[0.0], np.cumsum(segment_lengths)])
    total = float(cumulative[-1])
    if total <= 1e-9:
        raise ValueError("cannot resample a zero-length gutter")

    targets = np.linspace(0.0, total, samples)
    result = np.empty((samples, 2), dtype=np.float64)

    segment = 0
    for index, distance in enumerate(targets):
        while segment < len(segment_lengths) - 1 and cumulative[segment + 1] < distance:
            segment += 1
        start_distance = cumulative[segment]
        length = segment_lengths[segment]
        t = 0.0 if length <= 1e-9 else (distance - start_distance) / length
        result[index] = points[segment] + t * (points[segment + 1] - points[segment])

    return result


def ribbon_centerline(hole: dict[str, Any], samples: int = 128) -> np.ndarray:
    left = resample_polyline(edge_array(hole, "leftEdge"), samples)
    right = resample_polyline(edge_array(hole, "rightEdge"), samples)
    return (left + right) / 2.0


def write_centerline_csv(path: Path, centerline: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["sample", "xPx", "yPx"])
        for index, (x_px, y_px) in enumerate(centerline):
            writer.writerow([index, f"{x_px:.6f}", f"{y_px:.6f}"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("golden", type=Path)
    parser.add_argument("--hole", type=int, choices=(1, 2, 3), required=True)
    parser.add_argument("--mask", type=Path)
    parser.add_argument("--centerline", type=Path)
    parser.add_argument("--samples", type=int, default=128)
    args = parser.parse_args()

    golden = load_golden(args.golden)
    hole = hole_by_number(golden, args.hole)

    polygon = ribbon_polygon(hole)
    centerline = ribbon_centerline(hole, args.samples)

    print(
        f"hole {args.hole}: "
        f"left={len(hole['leftEdge'])} points, "
        f"right={len(hole['rightEdge'])} points, "
        f"polygon={len(polygon)} vertices, "
        f"centerline={len(centerline)} samples"
    )

    if args.mask:
        args.mask.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(args.mask), ribbon_mask(golden, args.hole)):
            raise RuntimeError(f"could not write mask to {args.mask}")
        print(f"wrote {args.mask}")

    if args.centerline:
        write_centerline_csv(args.centerline, centerline)
        print(f"wrote {args.centerline}")


if __name__ == "__main__":
    main()
