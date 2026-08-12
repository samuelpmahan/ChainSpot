#!/usr/bin/env python3
"""Fresh hole-path (fairway corridor) probe: low-parameter centerline fit.

A from-scratch approach to per-hole path detection on the clean course map,
deliberately independent of the paused band-detection / badge-anchored
tracing probes (which it does not import or modify). Two ideas:

1. The UDisc fairway ribbon has no usable edges, but it DOES have a robust
   region signal: it composites translucent white, so ribbon pixels are
   brighter than their large-window local background. Evidence map =
   clip((L - boxmean(L, 41)) / 12, 0, 1) at 1/3 scale (LAB lightness).
   Chroma is not used: it is unreliable on this fixture (and the committed
   raster has the holes-1..3 golden annotation dots baked in, which
   contaminate chroma but not meaningfully lightness).

2. Hole-path geometry is extremely low-complexity -- a corridor edge is
   ~3 points, so a centerline is tee -> at most 2 interior bends -> basket.
   Instead of tracing pixels, fit that tiny parametric model directly:
   maximize the trimmed mean (top 80%, which shrugs off badge/icon
   occlusions) of evidence sampled along the polyline, minus a mild
   excess-length penalty. Coarse grid over the single-bend position, then
   hill-climb; a second bend is seeded by splitting the longer segment.
   More bends must beat the simpler model by a margin (0.025) to be kept.

Endpoints come from the committed IMG_5641 ground truth (tee/basket
detection is a separately solved problem: 18/18 in the static parser).

Usage:
  python3 scripts/cv-probes/hole_path_lowparam_fit.py --out /tmp/chainspot-hole-path

Writes: hole-paths.json (per hole: bend count, score, centerline in
source px, estimated corridor half-width), overlay.png, evidence.png, and
prints the golden-gutter containment metric for holes 1-3.
Dependencies: numpy, scipy, scikit-image, Pillow.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.color import rgb2lab

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "resources/ribbon-reference/IMG_5641-ribbon-golden.png"
GOLDEN = REPO / "resources/ribbon-reference/IMG_5641-ribbon-golden.json"

SCALE = 3           # work at 1/3 resolution
EVIDENCE_DL = 12.0  # LAB L units of local brightening that count as "full" ribbon
LENGTH_ALPHA = 0.2  # penalty per unit of excess length ratio
BEND_MARGIN = 0.025 # score gain a extra bend must provide

# Mirror of IMG_5641_GROUND_TRUTH in src/lib/autoAnnotation/courseGroundTruth.ts
# (hole, teeX, teeY, basketX, basketY) in source px.
HOLES = [
    (1, 884.8, 431.9, 520.9, 426.5), (2, 458.2, 572.4, 764.9, 561.3),
    (3, 736.6, 714.6, 495.1, 627.1), (4, 430.7, 644.5, 432.3, 863.9),
    (5, 491.6, 853.0, 685.3, 796.3), (6, 680.4, 850.5, 438.8, 914.8),
    (7, 368.7, 982.3, 618.8, 950.4), (8, 514.9, 1010.9, 423.5, 1176.3),
    (9, 372.6, 1181.8, 306.9, 1413.0), (10, 260.3, 1463.1, 138.4, 1640.6),
    (11, 73.6, 1827.7, 391.3, 1807.8), (12, 419.2, 1770.3, 339.1, 1531.1),
    (13, 446.9, 1473.0, 688.8, 1590.6), (14, 680.1, 1506.9, 816.6, 1323.7),
    (15, 875.2, 1361.8, 1034.4, 1084.9), (16, 1156.2, 1179.3, 1128.1, 763.7),
    (17, 1070.0, 852.8, 872.9, 986.6), (18, 788.6, 850.4, 1000.2, 438.4),
]


def evidence_map(full: Image.Image) -> np.ndarray:
    im = np.asarray(full.resize((full.width // SCALE, full.height // SCALE),
                                Image.LANCZOS)).astype(np.float32) / 255
    lightness = rgb2lab(im)[..., 0]
    d_l = lightness - ndi.uniform_filter(lightness, 41)
    return np.clip(d_l / EVIDENCE_DL, 0, 1)


def sample(pts, step=2.0):
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(2, int(np.hypot(x1 - x0, y1 - y0) / step))
        t = np.linspace(0, 1, n, endpoint=False)
        out.append(np.stack([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], 1))
    out.append(np.array([pts[-1]], float))
    return np.concatenate(out)


def make_scorer(ev):
    h, w = ev.shape

    def score(pts):
        p = sample(pts)
        xs = np.clip(p[:, 0].astype(int), 0, w - 1)
        ys = np.clip(p[:, 1].astype(int), 0, h - 1)
        v = np.sort(ev[ys, xs])[int(0.2 * len(p)):]
        length = float(np.sum(np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))))
        straight = max(np.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]), 1e-6)
        return float(v.mean()) - LENGTH_ALPHA * max(0.0, length / straight - 1.0)

    return score


def hill_climb(score, pts, movable, steps=(8, 4, 2, 1)):
    pts = [list(p) for p in pts]
    for st in steps:
        improved = True
        while improved:
            improved = False
            for i in movable:
                best, bp = score(pts), tuple(pts[i])
                for dx, dy in ((st, 0), (-st, 0), (0, st), (0, -st),
                               (st, st), (st, -st), (-st, st), (-st, -st)):
                    pts[i] = [bp[0] + dx, bp[1] + dy]
                    s = score(pts)
                    if s > best:
                        best, bp, improved = s, tuple(pts[i]), True
                pts[i] = list(bp)
    return pts, score(pts)


def fit_hole(score, tee, basket):
    cands = {0: ([list(tee), list(basket)], score([tee, basket]))}
    d = np.array([basket[0] - tee[0], basket[1] - tee[1]])
    length = np.hypot(*d)
    unit = d / length
    perp = np.array([-unit[1], unit[0]])
    best1 = None
    for t in np.linspace(0.25, 0.75, 7):
        for o in np.linspace(-0.45, 0.45, 15):
            mid = (np.array(tee) + d * t + perp * o * length).tolist()
            s = score([tee, mid, basket])
            if best1 is None or s > best1[1]:
                best1 = ([list(tee), mid, list(basket)], s)
    cands[1] = hill_climb(score, best1[0], [1])
    a, m, b = cands[1][0]
    if np.hypot(m[0] - a[0], m[1] - a[1]) > np.hypot(b[0] - m[0], b[1] - m[1]):
        init = [a, [(a[0] + m[0]) / 2, (a[1] + m[1]) / 2], m, b]
    else:
        init = [a, m, [(m[0] + b[0]) / 2, (m[1] + b[1]) / 2], b]
    cands[2] = hill_climb(score, init, [1, 2])

    k = 0
    for kk in (1, 2):
        if cands[kk][1] > cands[k][1] + BEND_MARGIN:
            k = kk
    return k, cands


def half_width(ev, pts, max_r=18):
    """Median run of evidence>0.5 along perpendicular cuts (small-scale px)."""
    p = sample(pts, step=4.0)
    if len(p) < 3:
        return 0.0
    tang = np.gradient(p, axis=0)
    tang /= np.maximum(np.hypot(tang[:, 0], tang[:, 1]), 1e-6)[:, None]
    perp = np.stack([-tang[:, 1], tang[:, 0]], 1)
    h, w = ev.shape
    widths = []
    for (x, y), (px, py) in zip(p, perp):
        run = 0
        for sgn in (1, -1):
            for r in range(1, max_r):
                xi, yi = int(x + sgn * r * px), int(y + sgn * r * py)
                if not (0 <= xi < w and 0 <= yi < h) or ev[yi, xi] < 0.5:
                    break
                run += 1
        widths.append(run / 2)
    return float(np.median(widths))


def golden_containment(results):
    if not GOLDEN.exists():
        return
    golden = json.loads(GOLDEN.read_text())
    src = json.loads(GOLDEN.read_text())["source"]
    for hole in golden["holes"]:
        poly = [(p["xPx"] / SCALE, p["yPx"] / SCALE) for p in hole["leftEdge"]] + \
               [(p["xPx"] / SCALE, p["yPx"] / SCALE) for p in reversed(hole["rightEdge"])]
        m = Image.new("1", (src["widthPx"] // SCALE, src["heightPx"] // SCALE))
        ImageDraw.Draw(m).polygon(poly, fill=1)
        m = np.asarray(m, bool)
        r = results[hole["number"]]
        p = sample([(x / SCALE, y / SCALE) for x, y in r["centerlinePx"]])
        xs = np.clip(p[:, 0].astype(int), 0, m.shape[1] - 1)
        ys = np.clip(p[:, 1].astype(int), 0, m.shape[0] - 1)
        frac = float(m[ys, xs].mean())
        r["goldenContainment"] = round(frac, 3)
        print(f"hole {hole['number']}: {100 * frac:.1f}% of centerline inside golden gutters")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/chainspot-hole-path")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    full = Image.open(SOURCE).convert("RGB")
    ev = evidence_map(full)
    Image.fromarray((ev * 255).astype(np.uint8)).save(out / "evidence.png")
    score = make_scorer(ev)

    results = {}
    for n, tx, ty, bx, by in HOLES:
        tee, basket = (tx / SCALE, ty / SCALE), (bx / SCALE, by / SCALE)
        k, cands = fit_hole(score, tee, basket)
        pts, s = cands[k]
        results[n] = dict(
            bends=k,
            score=round(s, 3),
            straightScore=round(cands[0][1], 3),
            halfWidthPx=round(half_width(ev, pts) * SCALE, 1),
            centerlinePx=[[round(x * SCALE, 1), round(y * SCALE, 1)] for x, y in pts],
        )
        print(f"hole {n:2d}: bends={k} score={s:.3f} "
              f"(straight {cands[0][1]:.3f}) halfWidth~{results[n]['halfWidthPx']}px")

    golden_containment(results)
    (out / "hole-paths.json").write_text(json.dumps(results, indent=1) + "\n")

    overlay = full.copy()
    d = ImageDraw.Draw(overlay)
    for n, r in results.items():
        pts = [tuple(p) for p in r["centerlinePx"]]
        d.line(pts, fill=(255, 60, 0), width=5)
        for x, y in pts[1:-1]:
            d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 0), width=3)
    overlay.save(out / "overlay.png")
    print(f"wrote {out}/hole-paths.json, overlay.png, evidence.png")


if __name__ == "__main__":
    main()
