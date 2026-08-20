from __future__ import annotations

import argparse
import json
import math
import tempfile
import time
import zipfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from scipy.optimize import linear_sum_assignment

from middleout import (
    detect_badges,
    middleout_path,
    paired_bandness,
    point_segment_distance,
    support_cost,
)


# These are only screenshot-to-source crop offsets.
# No rescaling and no CV tuning is performed.
COURSES = {
    "DashsTrack": {"top": 0},
    "Heritage": {"top": 426},
    "Lenard": {"top": 426},
    "TowneLake": {"top": 528},
}


def hole_polyline(hole: dict) -> list[tuple[float, float]]:
    return (
        [(hole["tee"]["xPx"], hole["tee"]["yPx"])]
        + [
            (point["xPx"], point["yPx"])
            for point in hole.get("corridorBends", [])
        ]
        + [(hole["basket"]["xPx"], hole["basket"]["yPx"])]
    )


def distance_to_hole_polyline(
    point: tuple[float, float],
    hole: dict,
) -> float:
    pts = hole_polyline(hole)
    return min(
        point_segment_distance(
            point[0],
            point[1],
            pts[i],
            pts[i + 1],
        )
        for i in range(len(pts) - 1)
    )


def map_badges_to_holes(
    badges: list[dict],
    holes: list[dict],
) -> dict[int, dict]:
    """
    DEV EVALUATION ONLY.

    Uses the annotation centerline to map a detected physical badge to a
    hole identity, so the experiment isolates path recovery rather than
    endpoint attribution.

    The annotation bends are NOT passed to MiddleOut itself.
    """
    cost = np.zeros((len(holes), len(badges)), dtype=float)

    for hi, hole in enumerate(holes):
        for bi, badge in enumerate(badges):
            p = (badge["cx"], badge["cy"])
            path_distance = distance_to_hole_polyline(p, hole)

            endpoint_distance = min(
                math.hypot(
                    p[0] - hole["tee"]["xPx"],
                    p[1] - hole["tee"]["yPx"],
                ),
                math.hypot(
                    p[0] - hole["basket"]["xPx"],
                    p[1] - hole["basket"]["yPx"],
                ),
            )

            cost[hi, bi] = path_distance + 0.02 * endpoint_distance

    rows, cols = linear_sum_assignment(cost)

    return {
        holes[hole_index]["number"]: badges[badge_index]
        for hole_index, badge_index in zip(rows, cols)
    }


def path_to_truth_distances(
    path: np.ndarray,
    hole: dict,
) -> np.ndarray:
    truth = hole_polyline(hole)

    out = []
    for x, y in path:
        out.append(
            min(
                point_segment_distance(
                    x,
                    y,
                    truth[i],
                    truth[i + 1],
                )
                for i in range(len(truth) - 1)
            )
        )

    return np.asarray(out)


def find_fixture_files(folder: Path) -> tuple[Path, Path]:
    image = next(
        path
        for path in folder.iterdir()
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}
        and not path.name.startswith(".")
    )
    annotation = next(
        path for path in folder.iterdir() if path.name.endswith(".annotation.json")
    )
    return image, annotation


def run_course(
    course: str,
    folder: Path,
    top: int,
    output_dir: Path,
) -> dict:
    image_path, annotation_path = find_fixture_files(folder)

    full = np.asarray(Image.open(image_path).convert("RGB"))
    annotation = json.loads(annotation_path.read_text())

    source_height = int(annotation["sourceImage"]["heightPx"])
    source_width = int(annotation["sourceImage"]["widthPx"])

    # Crop only. No resize.
    img = full[top : top + source_height, :source_width].copy()

    badges = detect_badges(img, max_candidates=18)
    holes = sorted(annotation["holes"], key=lambda h: h["number"])

    if len(badges) != 18:
        raise RuntimeError(
            f"{course}: expected 18 physical badges, detected {len(badges)}"
        )

    badge_for_hole = map_badges_to_holes(badges, holes)

    support, scale, support_ms = paired_bandness(img, scale=3)
    cost = support_cost(support)

    paths = {}
    all_errors = []
    path_started = time.perf_counter()

    for hole in holes:
        number = hole["number"]
        badge = badge_for_hole[number]

        tee = (
            float(hole["tee"]["xPx"]),
            float(hole["tee"]["yPx"]),
        )
        basket = (
            float(hole["basket"]["xPx"]),
            float(hole["basket"]["yPx"]),
        )
        badge_point = (
            float(badge["cx"]),
            float(badge["cy"]),
        )

        recovered = middleout_path(
            cost,
            tee,
            badge_point,
            basket,
            scale,
        )
        paths[number] = recovered

        errors = path_to_truth_distances(recovered, hole)
        all_errors.extend(errors.tolist())

    path_ms = (time.perf_counter() - path_started) * 1000
    all_errors = np.asarray(all_errors)

    fig = plt.figure(figsize=(10, 16))
    ax = fig.add_subplot(1, 1, 1)
    ax.imshow(img)

    for hole in holes:
        path = paths[hole["number"]]
        ax.plot(path[:, 0], path[:, 1], linewidth=1.5)

    ax.set_title(
        f"{course} — MiddleOut recovered paths\n"
        "18/18 badges • annotation bends NOT supplied to pathfinder"
    )
    ax.axis("off")
    fig.tight_layout()

    output_path = output_dir / f"{course}_middleout.png"
    fig.savefig(
        output_path,
        dpi=190,
        bbox_inches="tight",
        pad_inches=0,
    )
    plt.close(fig)

    half_width = float(
        np.median([float(hole["corridorWidthPx"]) for hole in holes])
    ) / 2.0

    return {
        "course": course,
        "badges": len(badges),
        "median_error": float(np.median(all_errors)),
        "p90_error": float(np.percentile(all_errors, 90)),
        "within_half_width": float(np.mean(all_errors <= half_width)),
        "support_ms": support_ms,
        "paths_ms": path_ms,
        "output_path": output_path,
    }


def run_corpus(root: Path, output_dir: Path) -> list[dict]:
    output_dir.mkdir(parents=True, exist_ok=True)

    summaries = []

    for course, config in COURSES.items():
        summaries.append(
            run_course(
                course,
                root / course,
                config["top"],
                output_dir,
            )
        )

    metrics_path = output_dir / "dev_middleout_metrics.tsv"
    with metrics_path.open("w") as f:
        f.write(
            "course\tbadges\tmedian_error_px\tp90_error_px\t"
            "fraction_within_manual_half_width\tsupport_ms\tpaths_ms\n"
        )

        for summary in summaries:
            f.write(
                f"{summary['course']}\t"
                f"{summary['badges']}\t"
                f"{summary['median_error']:.2f}\t"
                f"{summary['p90_error']:.2f}\t"
                f"{summary['within_half_width']:.4f}\t"
                f"{summary['support_ms']:.0f}\t"
                f"{summary['paths_ms']:.0f}\n"
            )

    return summaries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "input",
        help=(
            "Either Annotated(2).zip or the extracted Annotated directory "
            "containing DashsTrack/Heritage/Lenard/TowneLake."
        ),
    )
    parser.add_argument(
        "--output",
        default="dev_middleout_output",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output)

    if input_path.is_file() and input_path.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory(prefix="chainspot-middleout-") as tmp:
            tmp_path = Path(tmp)
            with zipfile.ZipFile(input_path) as archive:
                archive.extractall(tmp_path)

            candidates = [
                p
                for p in tmp_path.rglob("Annotated")
                if p.is_dir()
            ]
            if not candidates:
                raise RuntimeError("Could not find extracted Annotated directory.")

            summaries = run_corpus(candidates[0], output_dir)
    else:
        summaries = run_corpus(input_path, output_dir)

    print()
    for summary in summaries:
        print(
            f"{summary['course']:10s} "
            f"badges={summary['badges']}/18  "
            f"median={summary['median_error']:.1f}px  "
            f"p90={summary['p90_error']:.1f}px  "
            f"within-half-width="
            f"{100 * summary['within_half_width']:.1f}%  "
            f"time="
            f"{summary['support_ms'] + summary['paths_ms']:.0f}ms"
        )


if __name__ == "__main__":
    main()
