#!/usr/bin/env python3
"""Hole-path fit v2: capsule (corridor-region) scoring for bend structure.

Line-sampling scoring (hole_path_lowparam_fit.py + anchor experiments) could
not separate real shallow bends from spurious micro-bends: with author truth
for all bent holes on IMG_5641 ({4,5,7,8,14,15,18}), bent holes 4/7/15 show
ZERO line-score gain under flat evidence while straight hole 10 shows the
largest gain under graded evidence. The fix is to score the corridor as a
REGION: dilate the candidate centerline to a capsule of corridor half-width
(~21 px) and average graded evidence clip(dL/12) inside it.

- off-ridge anchors and micro-wiggles gain ~nothing (the capsule covers the
  same band pixels either way);
- a real bend leaves part of the straight capsule over dark terrain, a
  signal proportional to how far the corridor actually turns.

Measured on IMG_5641 (mask+anchor, K1 capsule gain per hole): bent holes
score 0.057-0.386, straight holes 0.001-0.015 -- a clean 4x gap; the
acceptance threshold 0.03 sits in it. Known edge cases: hole 4's bend
(~half a corridor width) falls below the gap and fits straight; holes 1-2
land above it (0.188/0.070) -- consistent with the author's earlier
"edges of 1+2 are 3 points each" and the hole-1 golden's gentle sag, though
the bent-holes-only label file omits them.

Pipeline per hole: fixed tee -> badge anchor segment, badge boxes masked;
bend structure chosen by capsule gain (up to 3 bends, each must add >0.03);
final bend positions refined with graded line evidence (recenters within
narrow corridors; see the AlexClark check).

Usage:
  python3 scripts/cv-probes/hole_path_capsule_fit.py --out /tmp/chainspot-hole-path-v2
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
BENT_LABELS = REPO / "resources/ribbon-reference/IMG_5641-bent-holes-labels.json"
S = base.SCALE
CAPSULE_R = 7        # capsule half-width, 1/3-scale px (~21 px source)
CAPSULE_MARGIN = 0.03
MAX_BENDS = 3


def make_capsule_scorer(ev, valid, alpha=0.2):
    h, w = ev.shape

    def score(pts):
        m = Image.new("1", (w, h))
        d = ImageDraw.Draw(m)
        d.line([tuple(p) for p in pts], fill=1, width=2 * CAPSULE_R + 1, joint="curve")
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - CAPSULE_R, y - CAPSULE_R, x + CAPSULE_R, y + CAPSULE_R], fill=1)
        mm = np.asarray(m, bool) & valid
        if mm.sum() < 10:
            return -1.0
        length = sum(np.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        straight = max(np.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]), 1e-6)
        return float(ev[mm].mean()) - alpha * max(0.0, length / straight - 1.0)

    return score


def fit_capsule(cscore, start, end, prefix):
    """Choose 0..MAX_BENDS bends by capsule gain; each extra bend must add
    more than CAPSULE_MARGIN."""
    prefix = [list(p) for p in prefix]
    cur = prefix + [list(start), list(end)]
    cur_s = cscore(cur)
    bends = 0
    for _ in range(MAX_BENDS):
        d = np.array([end[0] - start[0], end[1] - start[1]])
        length = max(np.hypot(*d), 1e-6)
        unit = d / length
        perp = np.array([-unit[1], unit[0]])
        best = None
        for t in np.linspace(0.3, 0.7, 5):
            for o in np.linspace(-0.4, 0.4, 9):
                mid = (np.array(start) + d * t + perp * o * length).tolist()
                cand = exp.split_longest(cur[len(prefix):]) if bends else \
                    [list(start), mid, list(end)]
                if bends:  # seed the extra bend by splitting; nudge via climb
                    cand = cand
                s = cscore(prefix + cand)
                if best is None or s > best[1]:
                    best = (cand, s)
                if bends:
                    break  # split seed does not depend on the grid
            if bends:
                break
        movable = list(range(len(prefix) + 1, len(prefix) + len(best[0]) - 1))
        got, s = base.hill_climb(cscore, prefix + best[0], movable, steps=(6, 3, 1))
        if s > cur_s + CAPSULE_MARGIN:
            cur, cur_s, bends = got, s, bends + 1
        else:
            break
    return cur, bends, cur_s


def gutter_mask(hole, size):
    tee = np.array([hole["tee"]["xPx"], hole["tee"]["yPx"]])
    left = [(p["xPx"] / S, p["yPx"] / S) for p in hole["left"]]
    right = [(p["xPx"] / S, p["yPx"] / S) for p in hole["right"]]
    if np.hypot(right[0][0] * S - tee[0], right[0][1] * S - tee[1]) < \
       np.hypot(right[-1][0] * S - tee[0], right[-1][1] * S - tee[1]):
        right = right[::-1]
    m = Image.new("1", size)
    ImageDraw.Draw(m).polygon(left + right, fill=1)
    return np.asarray(m, bool)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/chainspot-hole-path-v2")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    full = Image.open(base.SOURCE).convert("RGB")
    im = np.asarray(full.resize((full.width // S, full.height // S),
                                Image.LANCZOS)).astype(np.float32) / 255
    lightness = rgb2lab(im)[..., 0]
    d_l = lightness - ndi.uniform_filter(lightness, 41)
    ev = np.clip(d_l / 12, 0, 1)
    h, w = ev.shape
    badge_mask = np.zeros((h, w), bool)
    badge_at = {n: (x, y) for n, x, y in exp.BADGES}
    for _, bx, by in exp.BADGES:
        badge_mask[max(0, int((by - 24) / S)):int((by + 24) / S) + 1,
                   max(0, int((bx - 34) / S)):int((bx + 34) / S) + 1] = True
    cscore = make_capsule_scorer(ev, ~badge_mask)
    line_score = exp.make_scorer(ev, ~badge_mask)

    bent_truth = {}
    if BENT_LABELS.exists():
        bent_labels = json.loads(BENT_LABELS.read_text())
        bent_truth = {hl["number"]: hl for hl in bent_labels["holes"]}

    results = {}
    for n, tx, ty, bx, by in base.HOLES:
        nx, ny = badge_at[n]
        start, end = (nx / S, ny / S), (bx / S, by / S)
        pts, bends, cs = fit_capsule(cscore, start, end, [(tx / S, ty / S)])
        refined, _ = base.hill_climb(line_score, pts, list(range(2, len(pts) - 1)))
        row = dict(bends=bends, capsuleScore=round(cs, 3),
                   centerlinePx=[[round(x * S, 1), round(y * S, 1)] for x, y in refined])
        if n in bent_truth:
            m = gutter_mask(bent_truth[n], (w, h))
            p = base.sample(refined)
            xs = np.clip(p[:, 0].astype(int), 0, w - 1)
            ys = np.clip(p[:, 1].astype(int), 0, h - 1)
            row["gutterContainment"] = round(float(m[ys, xs].mean()), 3)
        results[n] = row
        truth = "bent" if n in bent_truth else "straight"
        extra = f" containment={row.get('gutterContainment', '')}" if n in bent_truth else ""
        print(f"hole {n:2d}: bends={bends} (truth: {truth}){extra}")

    bent_set = set(bent_truth)
    got_bent = {n for n, r in results.items() if r["bends"] > 0}
    print(f"\nbent recall: {len(got_bent & bent_set)}/{len(bent_set)}"
          f"  spurious bends on straight holes: {sorted(got_bent - bent_set)}")
    (out / "hole-paths-v2.json").write_text(json.dumps(results, indent=1) + "\n")

    ov = full.copy()
    d = ImageDraw.Draw(ov)
    for hl in bent_truth.values():
        for e in ("left", "right"):
            d.line([(p["xPx"], p["yPx"]) for p in hl[e]], fill=(0, 255, 0), width=3)
    for r in results.values():
        pts = [tuple(p) for p in r["centerlinePx"]]
        d.line(pts, fill=(255, 60, 0), width=5)
        for x, y in pts[1:-1]:
            d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 0), width=3)
    ov.save(out / "overlay-v2.png")
    print(f"wrote {out}/hole-paths-v2.json, overlay-v2.png")


if __name__ == "__main__":
    main()
