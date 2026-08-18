from __future__ import annotations

import math
import time
from typing import Iterable

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.graph import route_through_array


def detect_badges(img: np.ndarray, max_candidates: int = 18) -> list[dict]:
    """
    Reproduces the physical badge-body stage from ChainSpot's
    holeNumberDetection.ts:
      - dark connected components
      - badge geometry/fill gates
      - dominant repeated-size cluster
      - production-style ranking

    This does NOT OCR/label the badge glyph.
    """
    gray = np.floor(
        img[:, :, 0] * 0.299
        + img[:, :, 1] * 0.587
        + img[:, :, 2] * 0.114
        + 0.5
    ).astype(np.uint8)

    mask = (gray <= 50).astype(np.uint8)
    n, _, stats, cents = cv2.connectedComponentsWithStats(mask, 8)

    plausible: list[dict] = []
    for i in range(1, n):
        x, y, w, h, area = [int(v) for v in stats[i]]
        fill = area / (w * h)
        aspect = w / h
        if (
            12 <= w <= 120
            and 9 <= h <= 90
            and 1.12 <= aspect <= 1.75
            and fill >= 0.55
        ):
            plausible.append(
                {
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "fill": fill,
                    "cx": float(cents[i][0]),
                    "cy": float(cents[i][1]),
                }
            )

    if not plausible:
        return []

    size_tol = math.log(1.2)

    def size_distance(a: dict, b: dict) -> float:
        return max(
            abs(math.log(a["w"] / b["w"])),
            abs(math.log(a["h"] / b["h"])),
        )

    best: list[dict] = []
    best_fill = -1.0
    for seed in plausible:
        cluster = [p for p in plausible if size_distance(seed, p) <= size_tol]
        fill_sum = sum(p["fill"] for p in cluster)
        if len(cluster) > len(best) or (
            len(cluster) == len(best) and fill_sum > best_fill
        ):
            best = cluster
            best_fill = fill_sum

    mw = float(np.median([c["w"] for c in best]))
    mh = float(np.median([c["h"] for c in best]))

    ranked = sorted(
        best,
        key=lambda c: (
            abs(math.log(c["w"] / mw)) + abs(math.log(c["h"] / mh)),
            -c["fill"],
            c["y"],
        ),
    )
    return ranked[:max_candidates]


def _remap_shift(imgf: np.ndarray, dx: float, dy: float) -> np.ndarray:
    h, w = imgf.shape[:2]
    xs, ys = np.meshgrid(
        np.arange(w, dtype=np.float32),
        np.arange(h, dtype=np.float32),
    )
    return cv2.remap(
        imgf,
        (xs + np.float32(dx)).astype(np.float32),
        (ys + np.float32(dy)).astype(np.float32),
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT101,
    )


def paired_bandness(
    img: np.ndarray,
    scale: int = 3,
    widths_src: Iterable[int] = (24, 32, 40, 48, 56, 64),
    orientations: int = 12,
) -> tuple[np.ndarray, int, float]:
    """
    Continuous paired-edge evidence field.

    A candidate center pixel scores when two approximately parallel edges,
    separated by a plausible UDisc ribbon width, exhibit matching RGB
    transitions. This intentionally makes no fixed-gray or alpha-color
    assumption.

    Returns:
        support: float32 [0,1] evidence raster at 1/scale resolution
        scale: source pixels per support pixel
        elapsed_ms
    """
    started = time.perf_counter()

    h, w = img.shape[:2]
    ew, eh = w // scale, h // scale
    small = cv2.resize(img, (ew, eh), interpolation=cv2.INTER_AREA).astype(
        np.float32
    )
    small = gaussian_filter(small, sigma=(0.8, 0.8, 0))

    half_widths = np.asarray(tuple(widths_src), dtype=float) / (2 * scale)
    delta = max(1.0, 4.0 / scale)

    best = np.zeros((eh, ew), dtype=np.float32)

    for theta in np.linspace(0, np.pi, orientations, endpoint=False):
        nx, ny = -math.sin(theta), math.cos(theta)

        for r in half_widths:
            left_inside = _remap_shift(
                small, -nx * (r - delta), -ny * (r - delta)
            )
            left_outside = _remap_shift(
                small, -nx * (r + delta), -ny * (r + delta)
            )
            right_inside = _remap_shift(
                small, nx * (r - delta), ny * (r - delta)
            )
            right_outside = _remap_shift(
                small, nx * (r + delta), ny * (r + delta)
            )

            d1 = left_inside - left_outside
            d2 = right_inside - right_outside

            n1 = np.linalg.norm(d1, axis=2)
            n2 = np.linalg.norm(d2, axis=2)
            cosine = (d1 * d2).sum(axis=2) / (n1 * n2 + 1e-6)

            score = np.minimum(n1, n2) * np.clip(cosine, 0, 1)
            np.maximum(best, score, out=best)

    nonzero = best[best > 0]
    p995 = float(np.percentile(nonzero, 99.5)) if len(nonzero) else 1.0
    normalized = np.clip(best / max(p995, 1e-6), 0, 1) ** 0.7

    return (
        normalized.astype(np.float32),
        scale,
        (time.perf_counter() - started) * 1000,
    )


def support_cost(support: np.ndarray) -> np.ndarray:
    """Cost surface used in the dev experiment."""
    return (1.0 + 4.0 * (1.0 - support) ** 2).astype(np.float64)


def route_leg(
    cost: np.ndarray,
    start_src: tuple[float, float],
    goal_src: tuple[float, float],
    scale: int,
    margin_fraction: float = 0.60,
) -> np.ndarray:
    """
    Bounded shortest path from one semantic anchor to another.

    The only geometric prior is a generous ROI around the start/end chord.
    The endpoint glyphs are allowed a tiny low-cost disk because badges,
    tee frames, and basket sprites can erase the ribbon-edge signal locally.

    Returns source-space (x,y) coordinates.
    """
    sx, sy = start_src[0] / scale, start_src[1] / scale
    gx, gy = goal_src[0] / scale, goal_src[1] / scale

    straight = math.hypot(gx - sx, gy - sy)
    margin = max(30, int(straight * margin_fraction))

    x0 = max(0, int(math.floor(min(sx, gx) - margin)))
    x1 = min(cost.shape[1] - 1, int(math.ceil(max(sx, gx) + margin)))
    y0 = max(0, int(math.floor(min(sy, gy) - margin)))
    y1 = min(cost.shape[0] - 1, int(math.ceil(max(sy, gy) + margin)))

    local = cost[y0 : y1 + 1, x0 : x1 + 1].copy()

    start = (
        max(0, min(local.shape[0] - 1, int(round(sy)) - y0)),
        max(0, min(local.shape[1] - 1, int(round(sx)) - x0)),
    )
    goal = (
        max(0, min(local.shape[0] - 1, int(round(gy)) - y0)),
        max(0, min(local.shape[1] - 1, int(round(gx)) - x0)),
    )

    yy, xx = np.ogrid[: local.shape[0], : local.shape[1]]
    for py, px in (start, goal):
        endpoint = (xx - px) ** 2 + (yy - py) ** 2 <= 6**2
        local[endpoint] = np.minimum(local[endpoint], 1.4)

    path, _ = route_through_array(
        local,
        start,
        goal,
        fully_connected=True,
        geometric=True,
    )

    p = np.asarray(path, dtype=float)
    return np.column_stack(
        [
            (p[:, 1] + x0) * scale,
            (p[:, 0] + y0) * scale,
        ]
    )


def middleout_path(
    cost: np.ndarray,
    tee: tuple[float, float],
    badge: tuple[float, float],
    basket: tuple[float, float],
    scale: int,
) -> np.ndarray:
    """
    Recover tee -> badge -> basket as two independent middle-out legs.
    No bend truth is used.
    """
    badge_to_tee = route_leg(cost, badge, tee, scale)
    badge_to_basket = route_leg(cost, badge, basket, scale)

    return np.vstack(
        [
            badge_to_tee[::-1],
            badge_to_basket[1:],
        ]
    )


def point_segment_distance(
    px: float,
    py: float,
    a: tuple[float, float],
    b: tuple[float, float],
) -> float:
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    vv = vx * vx + vy * vy

    if vv < 1e-9:
        return math.hypot(px - ax, py - ay)

    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / vv))
    qx, qy = ax + t * vx, ay + t * vy
    return math.hypot(px - qx, py - qy)
