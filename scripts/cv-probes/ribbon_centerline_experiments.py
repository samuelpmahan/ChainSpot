#!/usr/bin/env python3
"""Controlled centerline ablations against the manually authored ribbon goldens.

The four arms intentionally share one source image, one frozen endpoint
manifest, one feature image, one occlusion mask, one pair of measured circle
radii, and one arc-length scorer.  Only the tracing primitive/C2 construction
named by an arm changes.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np

import golden_ribbon
import static_course_parser as v1

# The older centerline probes import underscored aliases that the glyph wrapper
# normally installs.  Install the aliases here without changing the detector.
if not hasattr(v1, "_overlay_feature"):
    v1._overlay_feature = v1.overlay_feature
if not hasattr(v1, "_band_contrast"):
    v1._band_contrast = v1.band_contrast
if not hasattr(v1, "_track_segment"):
    v1._track_segment = v1.track_segment

import static_course_centerline as v2
import static_course_centerline_semantic as base


SAMPLES = 256
VARIANT_ORDER = ("A", "B", "C", "D")
VARIANT_NAMES = {
    "A": "A baseline",
    "B": "B anchor floor",
    "C": "C DP swap",
    "D": "D forward-C2",
}
COMPLEXITY = {
    "A": "badge anchor + backward C2 ray/repulsion + greedy coast",
    "B": "three fixed anchors; no ribbon tracking",
    "C": "A with existing bounded DP for the two traces",
    "D": "A with forward C2 crossing; no backward ray/repulsion",
}


def load_manifest(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    if data.get("schemaVersion") != 1:
        raise ValueError("unsupported experiment manifest schema")
    source = data.get("source")
    holes = data.get("holes")
    if not isinstance(source, dict) or not isinstance(holes, list):
        raise ValueError("experiment manifest is missing source/holes")
    if [int(h.get("number", -1)) for h in holes] != [1, 2, 3]:
        raise ValueError("experiment manifest must contain holes 1, 2, 3 in order")
    return data


def source_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def point(value: dict[str, Any], x_key: str = "xPx", y_key: str = "yPx") -> np.ndarray:
    return np.asarray([float(value[x_key]), float(value[y_key])], dtype=float)


def fixture_objects(manifest: dict[str, Any]) -> tuple[dict[int, dict], list[dict], list[dict], dict[int, int]]:
    numbers: dict[int, dict] = {}
    tees: list[dict] = []
    baskets: list[dict] = []
    assignment: dict[int, int] = {}

    # The current detector represents a basket as a glyph box and derives its
    # semantic base from that box.  These dimensions are frozen fixture
    # metadata; all arms receive the same reconstructed detector objects.
    basket_width = 42.0
    basket_height = 68.0
    for index, hole in enumerate(manifest["holes"]):
        number = int(hole["number"])
        badge = hole["numberBadge"]
        number_center = np.asarray(
            [float(badge["centerXPx"]), float(badge["centerYPx"])],
            dtype=float,
        )
        numbers[number] = {
            "number": number,
            "x": float(badge["xPx"]),
            "y": float(badge["yPx"]),
            "width": float(badge["widthPx"]),
            "height": float(badge["heightPx"]),
            "cx": float(number_center[0]),
            "cy": float(number_center[1]),
            "score": 1.0,
        }

        tee_point = point(hole["tee"])
        tees.append({
            "cx": float(tee_point[0]),
            "cy": float(tee_point[1]),
            "support": ["frozen-manifest"],
            "score": 1.0,
        })

        basket_base = point(hole["basketBase"])
        baskets.append({
            "x": float(basket_base[0] - basket_width / 2.0),
            "y": float(basket_base[1] - 0.96 * basket_height),
            "width": basket_width,
            "height": basket_height,
            "cx": float(basket_base[0]),
            "cy": float(basket_base[1]),
            "score": 1.0,
        })
        assignment[number] = index

    return numbers, tees, baskets, assignment


def segment_circle_entry(
    outside: np.ndarray,
    inside: np.ndarray,
    center: np.ndarray,
    radius: float,
) -> np.ndarray:
    delta = inside - outside
    offset = outside - center
    a = float(delta.dot(delta))
    b = 2.0 * float(offset.dot(delta))
    c = float(offset.dot(offset) - radius * radius)
    discriminant = max(0.0, b * b - 4.0 * a * c)
    roots = [
        (-b - float(np.sqrt(discriminant))) / (2.0 * a),
        (-b + float(np.sqrt(discriminant))) / (2.0 * a),
    ]
    valid = [value for value in roots if 0.0 <= value <= 1.0]
    t = min(valid) if valid else 1.0
    return outside + t * delta


def first_circle_crossing(
    points: np.ndarray,
    center: np.ndarray,
    radius: float,
) -> tuple[int, np.ndarray]:
    distances = np.linalg.norm(points - center, axis=1)
    for index in range(1, len(points)):
        if distances[index - 1] > radius and distances[index] <= radius:
            return index, segment_circle_entry(
                points[index - 1], points[index], center, radius
            )
    direction = points[0] - center
    direction /= max(float(np.linalg.norm(direction)), 1e-9)
    return len(points), center + direction * radius


def terminal_path(
    outside_c2: np.ndarray,
    basket_point: np.ndarray,
) -> np.ndarray:
    incoming = (
        outside_c2[-1] - outside_c2[-2]
        if len(outside_c2) >= 2
        else basket_point - outside_c2[-1]
    )
    terminal = v2.cubic_terminal_segment(
        outside_c2[-1], basket_point, incoming
    )
    return np.vstack([outside_c2[:-1], terminal])


def current_semantic_route(
    feature: np.ndarray,
    occlusion_mask: np.ndarray,
    c2_radius: float,
    number: int,
    numbers: dict[int, dict],
    tees: list[dict],
    baskets: list[dict],
    assignment: dict[int, int],
    tracer: Callable[[np.ndarray, np.ndarray, np.ndarray, np.ndarray], np.ndarray],
) -> np.ndarray:
    marker = numbers[number]
    tee = tees[assignment[number]]
    basket = baskets[assignment[number]]
    tee_point = np.asarray([tee["cx"], tee["cy"]], dtype=float)
    number_point = np.asarray([marker["cx"], marker["cy"]], dtype=float)
    basket_point = np.asarray(v1.basket_base(basket), dtype=float)

    entry, _ = base.semantic_c2_entry(
        feature,
        number_point,
        basket_point,
        c2_radius,
        tees,
        assignment[number],
    )
    tee_side = base.rectangle_exit_point(number_point, tee_point, marker)
    basket_side = base.rectangle_exit_point(number_point, entry, marker)
    tee_to_number = tracer(
        feature, occlusion_mask, tee_point, tee_side
    )
    c2_to_number = tracer(
        feature, occlusion_mask, entry, basket_side
    )
    number_to_c2 = c2_to_number[::-1]
    number_bridge = np.vstack([tee_side, number_point, basket_side])
    outside_c2 = np.vstack([
        tee_to_number[:-1],
        number_bridge[:-1],
        number_to_c2,
    ])
    return terminal_path(outside_c2, basket_point)


def anchor_floor_route(
    number: int,
    numbers: dict[int, dict],
    tees: list[dict],
    baskets: list[dict],
    assignment: dict[int, int],
) -> np.ndarray:
    marker = numbers[number]
    tee = tees[assignment[number]]
    basket = baskets[assignment[number]]
    return np.asarray([
        [tee["cx"], tee["cy"]],
        [marker["cx"], marker["cy"]],
        v1.basket_base(basket),
    ], dtype=float)


def forward_c2_route(
    feature: np.ndarray,
    occlusion_mask: np.ndarray,
    c2_radius: float,
    number: int,
    numbers: dict[int, dict],
    tees: list[dict],
    baskets: list[dict],
    assignment: dict[int, int],
) -> np.ndarray:
    marker = numbers[number]
    tee = tees[assignment[number]]
    basket = baskets[assignment[number]]
    tee_point = np.asarray([tee["cx"], tee["cy"]], dtype=float)
    number_point = np.asarray([marker["cx"], marker["cy"]], dtype=float)
    basket_point = np.asarray(v1.basket_base(basket), dtype=float)

    tee_side = base.rectangle_exit_point(number_point, tee_point, marker)
    tee_to_number = base.coast_segment(
        feature, occlusion_mask, tee_point, tee_side
    )
    forward = base.coast_segment(
        feature, occlusion_mask, number_point, basket_point
    )
    index, entry = first_circle_crossing(
        forward, basket_point, c2_radius
    )
    if index == 0:
        outside_c2 = np.asarray([entry], dtype=float)
    else:
        outside_c2 = np.vstack([
            tee_to_number[:-1],
            tee_side,
            number_point,
            forward[1:index],
            entry,
        ])
    return terminal_path(outside_c2, basket_point)


def resample_prediction(points: np.ndarray, samples: int) -> np.ndarray:
    return golden_ribbon.resample_polyline(points, samples)


def score_route(prediction: np.ndarray, golden: np.ndarray) -> dict[str, float]:
    predicted = resample_prediction(prediction, len(golden))
    distances = np.linalg.norm(predicted - golden, axis=1)
    return {
        "meanPx": float(np.mean(distances)),
        "medianPx": float(np.median(distances)),
        "maxPx": float(np.max(distances)),
    }


def write_csv(path: Path, points: np.ndarray) -> None:
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["sample", "xPx", "yPx"])
        for index, (x_px, y_px) in enumerate(points):
            writer.writerow([index, f"{x_px:.6f}", f"{y_px:.6f}"])


def print_table(results: dict[str, Any]) -> None:
    print("Variant | H1 mean/max | H2 mean/max | H3 mean/max | aggregate | complexity")
    for variant in VARIANT_ORDER:
        if variant not in results:
            continue
        holes = results[variant]["holes"]
        cells = [
            f"{holes[str(number)]['meanPx']:.2f}/{holes[str(number)]['maxPx']:.2f}"
            for number in (1, 2, 3)
        ]
        aggregate = results[variant]["holes"]["aggregate"]
        aggregate_cell = f"{aggregate['meanPx']:.2f}/{aggregate['maxPx']:.2f}"
        print(
            f"{VARIANT_NAMES[variant]} | {cells[0]} | {cells[1]} | {cells[2]} | "
            f"{aggregate_cell} | {COMPLEXITY[variant]}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("resources/ribbon-reference/IMG_5641.jpg"),
    )
    parser.add_argument(
        "--golden",
        type=Path,
        default=Path("resources/ribbon-reference/IMG_5641-ribbon-golden.json"),
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("scripts/cv-probes/ribbon-experiment-detections.json"),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("/private/tmp/chainspot-ribbon-experiments"),
    )
    parser.add_argument(
        "--variant",
        action="append",
        choices=VARIANT_ORDER,
        dest="variants",
        help="run one arm; repeat for multiple arms (default: all)",
    )
    args = parser.parse_args()
    variants = tuple(args.variants or VARIANT_ORDER)

    source = args.source.resolve()
    golden_path = args.golden.resolve()
    manifest_path = args.manifest.resolve()
    image = cv2.imread(str(source))
    if image is None:
        raise RuntimeError(f"could not decode source image: {source}")

    golden = golden_ribbon.load_golden(golden_path)
    manifest = load_manifest(manifest_path)
    source_meta = golden["source"]
    expected_shape = (int(source_meta["heightPx"]), int(source_meta["widthPx"]))
    if image.shape[:2] != expected_shape:
        raise ValueError(
            f"source raster shape {image.shape[:2]} != golden {expected_shape}"
        )
    if source.name != str(source_meta["fileName"]):
        raise ValueError(
            f"source filename {source.name!r} != golden {source_meta['fileName']!r}"
        )
    manifest_source = manifest["source"]
    if (
        str(manifest_source["fileName"]) != source.name
        or int(manifest_source["widthPx"]) != image.shape[1]
        or int(manifest_source["heightPx"]) != image.shape[0]
    ):
        raise ValueError("manifest source metadata does not match source raster")

    numbers, tees, baskets, assignment = fixture_objects(manifest)
    feature = v1.overlay_feature(image)
    c1_radius, c2_radius = v2.detect_putting_circle_radii(image, baskets)
    occlusion_mask = base.build_occlusion_mask(
        image, numbers, baskets, tees, c2_radius
    )

    golden_lines = {
        number: golden_ribbon.ribbon_centerline(
            golden_ribbon.hole_by_number(golden, number), SAMPLES
        )
        for number in (1, 2, 3)
    }

    def greedy_tracer(
        feature_image: np.ndarray,
        mask: np.ndarray,
        start: np.ndarray,
        end: np.ndarray,
    ) -> np.ndarray:
        return base.coast_segment(feature_image, mask, start, end)

    def dp_tracer(
        feature_image: np.ndarray,
        _mask: np.ndarray,
        start: np.ndarray,
        end: np.ndarray,
    ) -> np.ndarray:
        # This is intentionally the existing bounded DP primitive. Its
        # historical signature has no occlusion-mask parameter; no other
        # appearance or C2 machinery is changed in arm C.
        return v1.track_segment(
            feature_image, tuple(start), tuple(end)
        )

    routes: dict[str, dict[int, np.ndarray]] = {}
    scores: dict[str, dict[str, Any]] = {}
    args.out.mkdir(parents=True, exist_ok=True)
    for variant in variants:
        routes[variant] = {}
        for number in (1, 2, 3):
            if variant == "A":
                route = current_semantic_route(
                    feature, occlusion_mask, c2_radius, number,
                    numbers, tees, baskets, assignment, greedy_tracer,
                )
            elif variant == "B":
                route = anchor_floor_route(
                    number, numbers, tees, baskets, assignment
                )
            elif variant == "C":
                route = current_semantic_route(
                    feature, occlusion_mask, c2_radius, number,
                    numbers, tees, baskets, assignment, dp_tracer,
                )
            else:
                route = forward_c2_route(
                    feature, occlusion_mask, c2_radius, number,
                    numbers, tees, baskets, assignment,
                )
            routes[variant][number] = route
            write_csv(
                args.out / f"{variant.lower()}-hole-{number}-centerline.csv",
                route,
            )

        hole_scores = {
            str(number): score_route(routes[variant][number], golden_lines[number])
            for number in (1, 2, 3)
        }
        all_distances = []
        for number in (1, 2, 3):
            predicted = resample_prediction(routes[variant][number], SAMPLES)
            all_distances.extend(
                np.linalg.norm(predicted - golden_lines[number], axis=1).tolist()
            )
        aggregate_distances = np.asarray(all_distances, dtype=float)
        hole_scores["aggregate"] = {
            "meanPx": float(np.mean(aggregate_distances)),
            "medianPx": float(np.median(aggregate_distances)),
            "maxPx": float(np.max(aggregate_distances)),
        }
        scores[variant] = {
            "name": VARIANT_NAMES[variant],
            "complexity": COMPLEXITY[variant],
            "holes": hole_scores,
            "controls": {
                "sameSource": True,
                "sameManifest": True,
                "sameGolden": True,
                "sameFeature": True,
                "sameOcclusionMask": True,
                "sameC2RadiusPx": float(c2_radius),
                "sameC1RadiusPx": float(c1_radius),
                "samples": SAMPLES,
                "goldenDerivation": "independent arc-length gutter resampling then midpointing",
                "predictionDerivation": "arc-length resampled prediction paired to golden samples",
            },
        }

    report = {
        "source": {
            "path": str(source),
            "fileName": source.name,
            "sha256": source_digest(source),
            "widthPx": int(image.shape[1]),
            "heightPx": int(image.shape[0]),
        },
        "golden": str(golden_path),
        "manifest": str(manifest_path),
        "variants": scores,
        "implementationNotes": [
            "A reproduces the current semantic_exact_anchor call graph for holes 1–3.",
            "B is the tee -> exact number center -> basket-base floor with no ribbon tracking.",
            "C replaces only the two greedy traces with existing static_course_parser.track_segment.",
            "D removes semantic_c2_entry, foreign-tee repulsion, and backward tracing; C2 entry is the first forward path crossing.",
            "D is an isolated forward-crossing replacement, not a new heuristic.",
        ],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2))
    print_table(scores)
    print(json.dumps({"out": str(args.out), "sourceSha256": report["source"]["sha256"]}, indent=2))


if __name__ == "__main__":
    main()
