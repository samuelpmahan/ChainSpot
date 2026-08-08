#!/usr/bin/env python3
"""
Focused ChainSpot experiment: derive the UDisc UI scale from hole marker #1.

This intentionally does only the scale bootstrap discussed in chat:

    broad search for #1
        -> measure rendered badge size
        -> derive expected UI scale
        -> constrain later 1..18 searches around that scale

It does NOT change the number-classification grammar, artifact masking, tees,
baskets, or any other CV stage.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def _resize_template(gray: np.ndarray, scale: float) -> np.ndarray:
    width = max(5, round(gray.shape[1] * scale))
    height = max(5, round(gray.shape[0] * scale))
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    return cv2.resize(gray, (width, height), interpolation=interpolation)


def find_hole_one_scale(
    image: np.ndarray,
    canonical_hole_one: np.ndarray,
    min_scale: float = 0.40,
    max_scale: float = 1.60,
    step: float = 0.01,
) -> dict:
    """
    Search #1 over a deliberately broad scale range, then derive scale from the
    actual matched raster dimensions rather than trusting the search increment.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    template_gray = cv2.cvtColor(canonical_hole_one, cv2.COLOR_BGR2GRAY)

    best = None
    for scale in np.arange(min_scale, max_scale + step / 2, step):
        template = _resize_template(template_gray, float(scale))
        if template.shape[0] >= gray.shape[0] or template.shape[1] >= gray.shape[1]:
            continue

        response = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, location = cv2.minMaxLoc(response)

        candidate = {
            "score": float(score),
            "searchScale": float(scale),
            "x": int(location[0]),
            "y": int(location[1]),
            "width": int(template.shape[1]),
            "height": int(template.shape[0]),
        }
        if best is None or candidate["score"] > best["score"]:
            best = candidate

    if best is None:
        raise RuntimeError("No #1 scale candidate could be evaluated")

    canonical_height, canonical_width = template_gray.shape
    scale_x = best["width"] / canonical_width
    scale_y = best["height"] / canonical_height
    expected_scale = (scale_x + scale_y) / 2.0

    best.update({
        "canonicalWidth": int(canonical_width),
        "canonicalHeight": int(canonical_height),
        "scaleX": float(scale_x),
        "scaleY": float(scale_y),
        "expectedScale": float(expected_scale),
    })
    return best


def constrained_number_search(
    image: np.ndarray,
    template_dir: Path,
    expected_scale: float,
    tolerance_fraction: float = 0.08,
) -> dict[int, dict]:
    """
    Diagnostic only: prove that the scale derived from #1 puts every hole-number
    template into the right size neighborhood.

    This still returns each template's raw best global match. Candidate
    deduplication / badge-first classification is deliberately NOT implemented
    here.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    low = expected_scale * (1.0 - tolerance_fraction)
    high = expected_scale * (1.0 + tolerance_fraction)
    scales = np.linspace(low, high, 13)

    results = {}
    for number in range(1, 19):
        source = cv2.imread(str(template_dir / f"hole-{number:02d}.png"))
        if source is None:
            raise RuntimeError(f"Missing template for hole {number}")
        template_gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)

        best = None
        for scale in scales:
            template = _resize_template(template_gray, float(scale))
            response = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
            _, score, _, location = cv2.minMaxLoc(response)
            candidate = {
                "score": float(score),
                "scale": float(scale),
                "x": int(location[0]),
                "y": int(location[1]),
                "width": int(template.shape[1]),
                "height": int(template.shape[0]),
            }
            if best is None or candidate["score"] > best["score"]:
                best = candidate
        results[number] = best

    return results


def run(image_path: Path, template_dir: Path, out_dir: Path) -> dict:
    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError(f"Could not decode {image_path}")

    hole_one = cv2.imread(str(template_dir / "hole-01.png"))
    if hole_one is None:
        raise RuntimeError("Could not decode hole-01.png")

    anchor = find_hole_one_scale(image, hole_one)
    constrained = constrained_number_search(
        image,
        template_dir,
        expected_scale=anchor["expectedScale"],
    )

    overlay = image.copy()
    x, y, w, h = anchor["x"], anchor["y"], anchor["width"], anchor["height"]
    cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 255, 255), 3)
    cv2.putText(
        overlay,
        f"#1 scale={anchor['expectedScale']:.3f} score={anchor['score']:.3f}",
        (max(5, x - 20), max(25, y - 10)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.65,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / "hole-one-scale-anchor.png"), overlay)

    scores = [result["score"] for result in constrained.values()]
    report = {
        "image": str(image_path),
        "holeOneAnchor": anchor,
        "constrainedSearchWindow": {
            "toleranceFraction": 0.08,
            "minScale": anchor["expectedScale"] * 0.92,
            "maxScale": anchor["expectedScale"] * 1.08,
        },
        "diagnosticNumberTemplateScores": {
            str(number): {
                "score": round(result["score"], 4),
                "scale": round(result["scale"], 4),
                "x": result["x"],
                "y": result["y"],
                "width": result["width"],
                "height": result["height"],
            }
            for number, result in constrained.items()
        },
        "diagnosticSummary": {
            "minimumBestTemplateScore": min(scores),
            "maximumBestTemplateScore": max(scores),
            "templatesAtOrAbove0_85": sum(score >= 0.85 for score in scores),
            "templatesAtOrAbove0_90": sum(score >= 0.90 for score in scores),
        },
        "scopeNote": (
            "This validates only the #1 scale bootstrap. Raw per-number best matches "
            "can still collide on the same badge; badge-first classification/dedup "
            "is intentionally not part of this change."
        ),
    }

    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    report = run(args.image, args.templates, args.out)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
