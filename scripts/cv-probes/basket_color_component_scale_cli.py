#!/usr/bin/env python3
"""Fast truth-free basket glyph scale estimate from the rendered basket color.

Validated research path extracted into a standalone CLI:
  1. mask the stable cool off-white basket color (HSV S<=20, V>=190),
  2. extract connected components from the source and canonical basket template,
  3. let shape-compatible components vote for source/template scale,
  4. choose the scale mode with the most coherent shape-weighted mass.

No basket coordinates, course grammar, or grayscale NCC are used.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

SAT_MAX = 20
VALUE_MIN = 190
MIN_SCALE = 0.5
MAX_SCALE = 4.0
SCALE_BIN = 0.025
MODE_HALF_WIDTH = 0.06


@dataclass(frozen=True)
class Comp:
    x: int
    y: int
    w: int
    h: int
    area: int
    fill: float
    aspect: float


@dataclass(frozen=True)
class ScaleMode:
    scale: float
    support: int
    weight: float
    median_anisotropy: float
    median_aspect_error: float
    representative_source_wh: tuple[int, int]
    representative_template_wh: tuple[int, int]


def color_mask(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    return ((hsv[..., 1] <= SAT_MAX) & (hsv[..., 2] >= VALUE_MIN)).astype(np.uint8) * 255


def components(mask: np.ndarray) -> list[Comp]:
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    out: list[Comp] = []
    for i in range(1, count):
        x, y, w, h, area = [int(v) for v in stats[i]]
        if area <= 0 or w <= 0 or h <= 0:
            continue
        out.append(Comp(x, y, w, h, area, area / float(w * h), w / float(h)))
    return out


def meaningful_template_components(mask: np.ndarray) -> list[Comp]:
    cs = components(mask)
    if not cs:
        raise RuntimeError("canonical basket template has no color-mask components")
    largest = max(c.area for c in cs)
    kept = [
        c for c in cs
        if c.area >= max(3, 0.04 * largest) and c.w >= 2 and c.h >= 2
    ]
    if not kept:
        raise RuntimeError("canonical basket template has no meaningful color component")
    return sorted(kept, key=lambda c: c.area, reverse=True)[:8]


def source_components(mask: np.ndarray) -> list[Comp]:
    h, w = mask.shape
    return [
        c for c in components(mask)
        if 8 <= c.area <= 8000
        and 2 <= c.w <= min(160, int(w * 0.15))
        and 2 <= c.h <= min(180, int(h * 0.15))
    ]


def vote_modes(src: list[Comp], ref: list[Comp]) -> tuple[ScaleMode, list[ScaleMode], int]:
    votes: list[dict] = []
    for si, s in enumerate(src):
        for ri, r in enumerate(ref):
            sx = s.w / float(r.w)
            sy = s.h / float(r.h)
            scale = math.sqrt(sx * sy)
            if not MIN_SCALE <= scale <= MAX_SCALE:
                continue

            anis = abs(math.log(sx / sy))
            aspect_err = abs(math.log(max(s.aspect, 1e-6) / max(r.aspect, 1e-6)))
            fill_err = abs(math.log(max(s.fill, 1e-6) / max(r.fill, 1e-6)))
            if anis > 0.16 or aspect_err > 0.16 or fill_err > 0.55:
                continue

            shape = math.exp(-((anis / 0.08) ** 2)) * math.exp(-((fill_err / 0.35) ** 2))
            weight = shape * math.sqrt(min(s.area, 1800))
            votes.append({
                "scale": scale,
                "weight": weight,
                "si": si,
                "ri": ri,
                "anis": anis,
                "aspect": aspect_err,
            })

    if not votes:
        raise RuntimeError("no source/template component scale votes")

    centers = np.arange(MIN_SCALE + SCALE_BIN / 2, MAX_SCALE, SCALE_BIN)
    modes: list[ScaleMode] = []
    for center in centers:
        near = [v for v in votes if abs(v["scale"] - center) <= MODE_HALF_WIDTH]
        if not near:
            continue

        # A single source component can resemble multiple template fragments;
        # count it only once within each scale mode.
        best_by_source: dict[int, dict] = {}
        for v in near:
            old = best_by_source.get(v["si"])
            if old is None or v["weight"] > old["weight"]:
                best_by_source[v["si"]] = v

        picked = list(best_by_source.values())
        total_weight = sum(v["weight"] for v in picked)
        scale = sum(v["scale"] * v["weight"] for v in picked) / max(total_weight, 1e-9)
        rep = max(picked, key=lambda v: v["weight"])
        s, r = src[rep["si"]], ref[rep["ri"]]
        modes.append(ScaleMode(
            scale=float(scale),
            support=len(picked),
            weight=float(total_weight),
            median_anisotropy=float(np.median([v["anis"] for v in picked])),
            median_aspect_error=float(np.median([v["aspect"] for v in picked])),
            representative_source_wh=(s.w, s.h),
            representative_template_wh=(r.w, r.h),
        ))

    if not modes:
        raise RuntimeError("no component scale modes")

    # Weight is intentionally primary: on real screenshots a handful of full
    # basket cores must beat a larger number of tiny repeated text fragments.
    best = max(modes, key=lambda m: (m.weight, m.support, -m.median_anisotropy))
    ranked = sorted(modes, key=lambda m: (m.weight, m.support), reverse=True)

    unique: list[ScaleMode] = []
    for mode in ranked:
        if all(abs(mode.scale - old.scale) > 0.08 for old in unique):
            unique.append(mode)
        if len(unique) >= 10:
            break
    return best, unique, len(votes)


def infer(image_bgr: np.ndarray, template_bgr: np.ndarray) -> dict:
    started = time.perf_counter()
    source_mask = color_mask(image_bgr)
    template_mask = color_mask(template_bgr)
    src = source_components(source_mask)
    ref = meaningful_template_components(template_mask)
    best, modes, vote_count = vote_modes(src, ref)
    return {
        "best": asdict(best),
        "top_modes": [asdict(m) for m in modes],
        "elapsed_ms": (time.perf_counter() - started) * 1000.0,
        "source_component_count": len(src),
        "template_components": [asdict(c) for c in ref],
        "vote_count": vote_count,
        "mask": source_mask,
    }


def load_bgr(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"could not decode image: {path}")
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path, help="source screenshot/stitch image(s)")
    parser.add_argument(
        "--template",
        type=Path,
        default=Path("static/resources/chainspot_cv_templates/basket.png"),
        help="canonical basket template",
    )
    parser.add_argument("--json", type=Path, help="optional JSON report path")
    parser.add_argument("--mask-dir", type=Path, help="optional directory for binary mask previews")
    args = parser.parse_args()

    template = load_bgr(args.template)
    rows = []
    for image_path in args.images:
        result = infer(load_bgr(image_path), template)
        best = result["best"]
        print(
            f"{image_path}: scale={best['scale']:.4f} "
            f"support={best['support']} weight={best['weight']:.1f} "
            f"source={tuple(best['representative_source_wh'])} "
            f"template={tuple(best['representative_template_wh'])} "
            f"elapsed={result['elapsed_ms']:.1f}ms"
        )

        if args.mask_dir:
            args.mask_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(args.mask_dir / f"{image_path.stem}-basket-color-mask.png"), result["mask"])

        result.pop("mask")
        rows.append({"image": str(image_path), **result})

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({"results": rows}, indent=2) + "\n")


if __name__ == "__main__":
    main()
