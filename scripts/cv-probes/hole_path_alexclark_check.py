#!/usr/bin/env python3
"""Second-course check of the hole-path fit: AlexClark (McKinney, TX).

Fixture: resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX.jpg with
hand-drawn gutter labels for the course's three BENT holes in
AlexClark-McKinney-TX-labels.json (the "number" field is a label index, not
the course hole number). No badge ground truth exists for this course, so
the fit runs unanchored tee -> basket.

Two-stage fit:
  A) bend-count selection with saturated evidence clip(dL/4) and margin 0.05
     (the --final config from hole_path_anchor_experiments.py);
  B) bend-position refinement with graded evidence clip(dL/12), which
     recenters the line inside narrow corridors (structure kept fixed).

Usage:
  python3 scripts/cv-probes/hole_path_alexclark_check.py --out /tmp/chainspot-alexclark
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.color import rgb2lab

import hole_path_anchor_experiments as exp
import hole_path_lowparam_fit as base

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX.jpg"
LABELS = REPO / "resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX-labels.json"
S = 3


def containment_mask(hole, size):
    tee = np.array([hole["tee"]["xPx"], hole["tee"]["yPx"]])
    left = [(p["xPx"] / S, p["yPx"] / S) for p in hole["left"]]
    right = [(p["xPx"] / S, p["yPx"] / S) for p in hole["right"]]
    # orient the right edge basket->tee so left + right forms a simple loop
    if np.hypot(right[0][0] * S - tee[0], right[0][1] * S - tee[1]) < \
       np.hypot(right[-1][0] * S - tee[0], right[-1][1] * S - tee[1]):
        right = right[::-1]
    m = Image.new("1", size)
    ImageDraw.Draw(m).polygon(left + right, fill=1)
    return np.asarray(m, bool)


def containment(mask, pts):
    p = base.sample(pts)
    xs = np.clip(p[:, 0].astype(int), 0, mask.shape[1] - 1)
    ys = np.clip(p[:, 1].astype(int), 0, mask.shape[0] - 1)
    return float(mask[ys, xs].mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/chainspot-alexclark")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    base.EVIDENCE_DL, base.BEND_MARGIN = 4.0, 0.05
    full = Image.open(SOURCE).convert("RGB")
    im = np.asarray(full.resize((full.width // S, full.height // S),
                                Image.LANCZOS)).astype(np.float32) / 255
    lightness = rgb2lab(im)[..., 0]
    d_l = lightness - ndi.uniform_filter(lightness, 41)
    ones = np.ones(d_l.shape, bool)
    sc_flat = exp.make_scorer(np.clip(d_l / 4, 0, 1), ones)
    sc_graded = exp.make_scorer(np.clip(d_l / 12, 0, 1), ones)

    labels = json.loads(LABELS.read_text())
    results = {}
    for hole in labels["holes"]:
        n = hole["number"]
        tee = (hole["tee"]["xPx"] / S, hole["tee"]["yPx"] / S)
        basket = (hole["basket"]["xPx"] / S, hole["basket"]["yPx"] / S)
        pts, k, s, ks = exp.fit(sc_flat, tee, basket)
        refined, _ = base.hill_climb(sc_graded, pts, list(range(1, len(pts) - 1)))
        m = containment_mask(hole, (d_l.shape[1], d_l.shape[0]))
        results[n] = dict(
            bends=k,
            scoresByK={a: round(float(v), 3) for a, v in ks.items()},
            containmentStageA=round(containment(m, pts), 3),
            containmentRefined=round(containment(m, refined), 3),
            centerlinePx=[[round(x * S, 1), round(y * S, 1)] for x, y in refined],
        )
        r = results[n]
        print(f"label-hole {n}: bends={k} scoresByK={r['scoresByK']} "
              f"containment {100 * r['containmentStageA']:.1f}% -> "
              f"refined {100 * r['containmentRefined']:.1f}%")

    (out / "alexclark-hole-paths.json").write_text(json.dumps(results, indent=1) + "\n")
    ov = full.copy()
    d = ImageDraw.Draw(ov)
    for hole in labels["holes"]:
        for e in ("left", "right"):
            d.line([(p["xPx"], p["yPx"]) for p in hole[e]], fill=(0, 255, 0), width=3)
    for r in results.values():
        pts = [tuple(p) for p in r["centerlinePx"]]
        d.line(pts, fill=(255, 60, 0), width=4)
        for x, y in pts[1:-1]:
            d.ellipse([x - 6, y - 6, x + 6, y + 6], outline=(255, 255, 0), width=2)
    ov.save(out / "alexclark-overlay.png")
    print(f"wrote {out}/alexclark-hole-paths.json, alexclark-overlay.png")


if __name__ == "__main__":
    main()
