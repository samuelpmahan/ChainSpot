"""
Experiment: near-basket occlusion / C1-C2 filter handling for MiddleOut.

This is a sibling experiment file. It does NOT modify middleout.py (the
validated reference the TS port is based on) — it imports from it and adds
new functions that prototype a fix for the near-basket routing zone.

Context: see the "CV Stabilization" project doc on how UDisc renders basket
circles (C2 dashed ring ~20m, C2 translucent filter, C1 solid ring ~10m, C1
translucent filter) and the hole-path ribbon. This module:

  1. detect_ring_radii(): empirically locates the C1 (solid) and C2 (dashed)
     ring radii, in source pixels, around a *known* basket anchor (basket
     location is assumed already available -- this experiment does not try
     to find baskets from scratch, only their surrounding ring geometry).

  2. cap_icon_false_positive(): paired_bandness produces a strong, highly
     consistent FALSE-POSITIVE ceiling spike on the basket sprite's own
     silhouette edges (see report). This caps that spike so it can't act as
     a spurious near-zero-cost sink for the router.

  3. route_leg_v2(): direction-aware replacement for route_leg()'s fixed
     r=6 (cost-grid px) isotropic waived disk. Uses detected ring geometry
     to size an icon-footprint waiver (isotropic, small) plus a bearing-
     biased partial waiver out to the C1 ring, so a large near-basket
     low-cost zone can't bleed sideways into an adjacent hole's territory.
"""
from __future__ import annotations

import math
from typing import Optional

import cv2
import numpy as np
from skimage.graph import route_through_array

from middleout import support_cost


def radial_profile(
    channel: np.ndarray,
    center_src: tuple[float, float],
    r_min: int = 20,
    r_max: int = 140,
    n_angles: int = 240,
) -> dict:
    """Per-radius angular mean/std of a single-channel image around center_src."""
    cx, cy = center_src
    h, w = channel.shape
    angles = np.linspace(0, 2 * np.pi, n_angles, endpoint=False)
    cos_a, sin_a = np.cos(angles), np.sin(angles)

    radii = np.arange(r_min, r_max)
    means = np.empty(len(radii), dtype=np.float64)
    stds = np.empty(len(radii), dtype=np.float64)

    for i, r in enumerate(radii):
        xs = np.clip((cx + r * cos_a).astype(int), 0, w - 1)
        ys = np.clip((cy + r * sin_a).astype(int), 0, h - 1)
        vals = channel[ys, xs]
        means[i] = vals.mean()
        stds[i] = vals.std()

    return {"radii": radii, "means": means, "stds": stds}


def _smooth(x: np.ndarray, k: int = 5) -> np.ndarray:
    kernel = np.ones(k) / k
    return np.convolve(x, kernel, mode="same")


def detect_ring_radii(
    img: np.ndarray,
    center_src: tuple[float, float],
    r_min: int = 20,
    r_max: int = 140,
) -> dict:
    """
    Detect C1 (solid ring) and C2 (dashed ring) radii, in source px, around
    a known basket anchor, using the HSV *saturation* channel.

    Rationale (empirically validated against manual measurement on
    DashsTrack hole 1, C1~50px/C2~80px by eye): both rings are rendered as
    desaturated gray over saturated green grass/fairway, which gives a much
    cleaner signal than raw luminance (which is dominated by the basket
    sprite's own high-contrast black/white silhouette near the center, and
    by grass-texture noise further out). The angular-mean saturation
    profile shows two clear local minima moving outward from the basket:
    the first is the C1 solid-ring boundary, the second is the C2
    dashed-ring band (dashes + gaps both average out to low-ish saturation,
    but the true dash line sits at the minimum of that dip).

    Returns {"c1": float|None, "c2": float|None, "profile": <radial_profile dict>}
    """
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV).astype(np.float32)
    sat = cv2.GaussianBlur(hsv[:, :, 1], (0, 0), 1.2)

    prof = radial_profile(sat, center_src, r_min=r_min, r_max=r_max)
    radii, means = prof["radii"], prof["means"]
    means_s = _smooth(means, 5)

    def local_minima(start_idx: int, end_idx: int, min_dip: float) -> Optional[int]:
        best_idx = None
        best_dip = min_dip
        for i in range(max(start_idx, 3) + 2, min(end_idx, n - 3) - 2):
            left, right = means_s[i - 3], means_s[i + 3]
            dip = ((left + right) / 2.0) - means_s[i]
            if dip > best_dip and means_s[i] <= means_s[i - 2] and means_s[i] <= means_s[i + 2]:
                best_dip = dip
                best_idx = i
        return best_idx

    n = len(radii)
    c1_idx = local_minima(0, int(n * 0.55), min_dip=1.5)
    c2_start = (c1_idx + 8) if c1_idx is not None else int(n * 0.25)
    c2_idx = local_minima(c2_start, n, min_dip=1.0)

    c1 = float(radii[c1_idx]) if c1_idx is not None else None
    c2 = float(radii[c2_idx]) if c2_idx is not None else None

    return {"c1": c1, "c2": c2, "profile": prof}


def estimate_course_ring_radii(
    img: np.ndarray,
    basket_centers_src: list[tuple[float, float]],
    r_min: int = 20,
    r_max: int = 140,
) -> dict:
    """
    Run detect_ring_radii() over several baskets on the same course/image
    (one fixed zoom level per screenshot) and take the median as the
    course-wide C1/C2 radius estimate. Falls back to None if too few
    baskets produce a confident detection.
    """
    c1s, c2s = [], []
    for center in basket_centers_src:
        r = detect_ring_radii(img, center, r_min=r_min, r_max=r_max)
        if r["c1"] is not None:
            c1s.append(r["c1"])
        if r["c2"] is not None:
            c2s.append(r["c2"])
    c1 = float(np.median(c1s)) if c1s else None
    c2 = float(np.median(c2s)) if c2s else None
    return {"c1": c1, "c2": c2, "n_c1": len(c1s), "n_c2": len(c2s), "n_total": len(basket_centers_src)}


def cap_icon_false_positive(
    support: np.ndarray,
    scale: int,
    basket_centers_src: list[tuple[float, float]],
    icon_radius_src: float,
    cap: float = 0.55,
) -> np.ndarray:
    """
    The basket sprite's own silhouette edges produce a near-ceiling
    paired_bandness false positive (empirically: max ~0.97-1.0 within
    ~35px of *every* basket on DashsTrack, offset ~34px "up" from the
    basket anchor -- the flag-top of the sprite). That creates a spurious
    near-zero-cost sink unrelated to the true ribbon.

    This clips support to at most `cap` within icon_radius_src of each
    known basket center, leaving genuine sub-cap ribbon evidence (typically
    0.2-0.5 in our measurements) untouched. It only pulls down spikes, it
    never raises anything.
    """
    out = support.copy()
    eh, ew = out.shape
    yy, xx = np.mgrid[0:eh, 0:ew]
    r_grid = icon_radius_src / scale

    for (bx, by) in basket_centers_src:
        gx, gy = bx / scale, by / scale
        mask = (xx - gx) ** 2 + (yy - gy) ** 2 <= r_grid ** 2
        np.minimum(out, cap, out=out, where=mask)

    return out


def route_leg_v2(
    cost: np.ndarray,
    start_src: tuple[float, float],
    goal_src: tuple[float, float],
    scale: int,
    icon_radius_src: float = 35.0,
    c1_radius_src: Optional[float] = 50.0,
    wedge_half_angle_deg: float = 55.0,
    margin_fraction: float = 0.60,
) -> np.ndarray:
    """
    route_leg() with a geometry-aware, direction-aware endpoint waiver
    instead of a fixed isotropic r=6 (cost-grid px) disk.

    - Within icon_radius_src (source px) of an endpoint: isotropic full
      waiver (matches sprite footprint -- the icon can locally occlude the
      true crossing point regardless of approach direction).
    - Between icon_radius_src and c1_radius_src: a bearing-biased partial
      waiver, active only within +/-wedge_half_angle_deg of the bearing
      from the *other* endpoint of this leg towards this endpoint (i.e.
      the direction the ribbon should be arriving from), tapering with
      both radius and angle. This is what stops a large near-basket
      low-cost zone from bleeding sideways into a neighboring hole's
      territory when C1/C2 circles overlap.
    - No broad discount is applied between c1_radius_src and the C2 ring:
      empirical on-ribbon support there was statistically indistinguishable
      from open-fairway support (see report), so no correction is used.

    Returns source-space (x, y) coordinates, same contract as route_leg().
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

    icon_r_grid = icon_radius_src / scale
    c1_r_grid = (c1_radius_src / scale) if c1_radius_src else icon_r_grid
    wedge_half = math.radians(wedge_half_angle_deg)

    endpoints = ((start, (gx - x0, gy - y0)), (goal, (sx - x0, sy - y0)))
    for (py, px), (other_x, other_y) in endpoints:
        dx = xx - px
        dy = yy - py
        dist = np.sqrt(dx * dx + dy * dy)

        # incoming bearing: direction from the *other* endpoint towards
        # this one, i.e. the direction the ribbon should approach from.
        bear_x, bear_y = px - other_x, py - other_y
        bear_norm = math.hypot(bear_x, bear_y) + 1e-6
        bear_x, bear_y = bear_x / bear_norm, bear_y / bear_norm

        with np.errstate(invalid="ignore", divide="ignore"):
            px_dir = dx / (dist + 1e-6)
            py_dir = dy / (dist + 1e-6)
        cos_ang = px_dir * bear_x + py_dir * bear_y
        ang = np.arccos(np.clip(cos_ang, -1, 1))

        # Full isotropic waiver inside the icon footprint.
        icon_mask = dist <= icon_r_grid
        local[icon_mask] = np.minimum(local[icon_mask], 1.4)

        # Bearing-biased partial waiver from icon edge out to C1 radius.
        band_mask = (dist > icon_r_grid) & (dist <= c1_r_grid) & (ang <= wedge_half)
        if np.any(band_mask):
            radial_t = (dist[band_mask] - icon_r_grid) / max(1e-6, (c1_r_grid - icon_r_grid))
            angular_t = ang[band_mask] / wedge_half
            strength = (1.0 - radial_t) * (1.0 - angular_t)  # 1 at icon edge/bearing, 0 at c1/wedge edge
            waived = 1.4 + (local[band_mask] - 1.4) * (1.0 - np.clip(strength, 0, 1))
            local[band_mask] = np.minimum(local[band_mask], waived)

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


def middleout_path_v2(
    support: np.ndarray,
    scale: int,
    tee: tuple[float, float],
    badge: tuple[float, float],
    basket: tuple[float, float],
    all_basket_centers_src: list[tuple[float, float]],
    icon_radius_src: float = 35.0,
    c1_radius_src: float = 50.0,
    icon_cap: float = 0.55,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Full fixed-up pipeline for one hole: cap the sprite false-positive
    spike for ALL baskets on the course (so neighboring baskets can't act
    as attractors either), recompute cost, then route both legs with the
    direction-aware endpoint waiver.

    Returns (path, capped_support).
    """
    capped = cap_icon_false_positive(
        support, scale, all_basket_centers_src, icon_radius_src, cap=icon_cap
    )
    cost = support_cost(capped)

    badge_to_tee = route_leg_v2(
        cost, badge, tee, scale,
        icon_radius_src=icon_radius_src, c1_radius_src=c1_radius_src,
    )
    badge_to_basket = route_leg_v2(
        cost, badge, basket, scale,
        icon_radius_src=icon_radius_src, c1_radius_src=c1_radius_src,
    )

    path = np.vstack([badge_to_tee[::-1], badge_to_basket[1:]])
    return path, capped
