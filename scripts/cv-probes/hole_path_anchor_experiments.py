#!/usr/bin/env python3
"""Anchor/mask experiments on top of the low-parameter hole-path fit.

Domain fact from the course author: UDisc places each hole's number badge ON
the fairway path, with a straight segment from the teepad center to the
badge center. Also: multiple bends are uncommon but not rare (hole 18 on
IMG_5641 is a real example), so all arms here allow up to 3 bends
(the baseline probe allowed 2).

Arms, sharing the evidence map and scorer of hole_path_lowparam_fit.py:

  baseline     tee -> basket fit, plain evidence (as committed, but K<=3)
  anchor       first segment FIXED tee -> badge center, then fit
               badge -> basket with 0..3 further bends
  mask         badge rectangles removed from the evidence (samples inside
               any badge box are excluded from scoring), tee -> basket fit
  mask+anchor  both of the above

Usage:
  python3 scripts/cv-probes/hole_path_anchor_experiments.py --out /tmp/chainspot-hole-path-exp

Writes per-arm results JSON, a 4-panel overlay contact sheet, and prints a
comparison table (per-hole bends/score, holes 1-3 golden containment).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import hole_path_lowparam_fit as base

BADGES = [  # mirror of courseGroundTruth.ts BADGES: (hole, xPx, yPx)
    (1, 754.5, 448.5), (2, 577.5, 582.0), (3, 606.5, 670.5), (4, 444.0, 744.0),
    (5, 550.5, 813.0), (6, 550.5, 884.5), (7, 444.0, 982.5), (8, 461.0, 1068.0),
    (9, 338.0, 1304.5), (10, 195.5, 1555.0), (11, 241.0, 1818.0),
    (12, 375.0, 1644.5), (13, 572.0, 1535.0), (14, 703.5, 1426.0),
    (15, 906.0, 1277.0), (16, 1140.0, 966.5), (17, 965.0, 922.0),
    (18, 862.5, 778.0),
]
BADGE_HALF_W, BADGE_HALF_H = 34, 24  # generous half-extents in source px
MAX_BENDS = 3


def make_scorer(ev, valid):
    """Like base.make_scorer but samples inside masked areas are excluded."""
    h, w = ev.shape

    def score(pts):
        p = base.sample(pts)
        xs = np.clip(p[:, 0].astype(int), 0, w - 1)
        ys = np.clip(p[:, 1].astype(int), 0, h - 1)
        keep = valid[ys, xs]
        v = ev[ys[keep], xs[keep]]
        if len(v) < 5:
            return -1.0
        v = np.sort(v)[int(0.2 * len(v)):]
        length = float(np.sum(np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))))
        straight = max(np.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]), 1e-6)
        return float(v.mean()) - base.LENGTH_ALPHA * max(0.0, length / straight - 1.0)

    return score


def split_longest(pts):
    segs = [np.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    i = int(np.argmax(segs))
    mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
    return pts[:i + 1] + [mid] + pts[i + 1:]


def fit(score, start, end, prefix=()):
    """Fit start->end with 0..MAX_BENDS interior bends; optional fixed prefix
    points (e.g. the tee when the anchor segment tee->badge is fixed)."""
    prefix = [list(p) for p in prefix]

    def full(pts):
        return prefix + pts

    cands = {0: ([list(start), list(end)], score(full([start, end])))}
    d = np.array([end[0] - start[0], end[1] - start[1]])
    length = max(np.hypot(*d), 1e-6)
    unit = d / length
    perp = np.array([-unit[1], unit[0]])
    best1 = None
    for t in np.linspace(0.25, 0.75, 7):
        for o in np.linspace(-0.45, 0.45, 15):
            mid = (np.array(start) + d * t + perp * o * length).tolist()
            s = score(full([start, mid, end]))
            if best1 is None or s > best1[1]:
                best1 = ([list(start), mid, list(end)], s)

    def climb(pts):
        movable = list(range(len(prefix) + 1, len(prefix) + len(pts) - 1))
        got, s = base.hill_climb(score, full(pts), movable)
        return got[len(prefix):], s

    cands[1] = climb(best1[0])
    for k in range(2, MAX_BENDS + 1):
        cands[k] = climb(split_longest(cands[k - 1][0]))

    k = 0
    for kk in range(1, MAX_BENDS + 1):
        if cands[kk][1] > cands[k][1] + base.BEND_MARGIN:
            k = kk
    pts, s = cands[k]
    return prefix + pts, k, s, {kk: round(v[1], 3) for kk, v in cands.items()}


def containment(results):
    if not base.GOLDEN.exists():
        return {}
    golden = json.loads(base.GOLDEN.read_text())
    src = golden["source"]
    out = {}
    for hole in golden["holes"]:
        poly = [(p["xPx"] / base.SCALE, p["yPx"] / base.SCALE) for p in hole["leftEdge"]] + \
               [(p["xPx"] / base.SCALE, p["yPx"] / base.SCALE) for p in reversed(hole["rightEdge"])]
        m = Image.new("1", (src["widthPx"] // base.SCALE, src["heightPx"] // base.SCALE))
        ImageDraw.Draw(m).polygon(poly, fill=1)
        m = np.asarray(m, bool)
        r = results[hole["number"]]
        p = base.sample([(x / base.SCALE, y / base.SCALE) for x, y in r["centerlinePx"]])
        xs = np.clip(p[:, 0].astype(int), 0, m.shape[1] - 1)
        ys = np.clip(p[:, 1].astype(int), 0, m.shape[0] - 1)
        out[hole["number"]] = round(float(m[ys, xs].mean()), 3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/chainspot-hole-path-exp")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    full_img = Image.open(base.SOURCE).convert("RGB")
    ev = base.evidence_map(full_img)
    h, w = ev.shape
    badge_mask = np.zeros((h, w), bool)
    badge_at = {n: (x, y) for n, x, y in BADGES}
    for _, bx, by in BADGES:
        x0 = max(0, int((bx - BADGE_HALF_W) / base.SCALE))
        x1 = min(w, int((bx + BADGE_HALF_W) / base.SCALE) + 1)
        y0 = max(0, int((by - BADGE_HALF_H) / base.SCALE))
        y1 = min(h, int((by + BADGE_HALF_H) / base.SCALE) + 1)
        badge_mask[y0:y1, x0:x1] = True

    plain = make_scorer(ev, np.ones((h, w), bool))
    masked = make_scorer(ev, ~badge_mask)
    arms = {
        "baseline": (plain, False),
        "anchor": (plain, True),
        "mask": (masked, False),
        "mask+anchor": (masked, True),
    }

    all_results = {}
    for arm, (score, anchored) in arms.items():
        results = {}
        for n, tx, ty, bx, by in base.HOLES:
            tee = (tx / base.SCALE, ty / base.SCALE)
            basket = (bx / base.SCALE, by / base.SCALE)
            if anchored:
                nx, ny = badge_at[n]
                badge = (nx / base.SCALE, ny / base.SCALE)
                pts, k, s, ks = fit(score, badge, basket, prefix=[tee])
            else:
                pts, k, s, ks = fit(score, tee, basket)
            results[n] = dict(
                bends=k, score=round(s, 3), scoresByK=ks,
                centerlinePx=[[round(x * base.SCALE, 1), round(y * base.SCALE, 1)]
                              for x, y in pts])
        results_by_hole = {n: r for n, r in results.items()}
        cont = containment(results_by_hole)
        for n, c in cont.items():
            results[n]["goldenContainment"] = c
        all_results[arm] = results
        print(f"[{arm}] golden containment 1-3: "
              f"{' '.join(f'{n}:{100*c:.1f}%' for n, c in cont.items())}")

    # comparison table
    header = "| hole | " + " | ".join(f"{a} bends/score" for a in arms) + " |"
    print(header)
    print("|" + "---|" * (len(arms) + 1))
    for n, *_ in base.HOLES:
        row = [f"| {n} "]
        for arm in arms:
            r = all_results[arm][n]
            row.append(f"| {r['bends']}/{r['score']:.3f} ")
        print("".join(row) + "|")

    (out / "experiments.json").write_text(json.dumps(all_results, indent=1) + "\n")

    panels = []
    for arm in arms:
        img = full_img.copy()
        d = ImageDraw.Draw(img)
        if "mask" in arm:
            for _, bx, by in BADGES:
                d.rectangle([bx - BADGE_HALF_W, by - BADGE_HALF_H,
                             bx + BADGE_HALF_W, by + BADGE_HALF_H],
                            outline=(0, 200, 255), width=2)
        for n, r in all_results[arm].items():
            pts = [tuple(p) for p in r["centerlinePx"]]
            d.line(pts, fill=(255, 60, 0), width=5)
            for x, y in pts[1:-1]:
                d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 0), width=3)
        img = img.resize((img.width // 2, img.height // 2))
        panels.append((arm, img))

    pw, ph = panels[0][1].size
    sheet = Image.new("RGB", (2 * pw + 18, 2 * (ph + 18) + 6), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for i, (name, img) in enumerate(panels):
        r, c = divmod(i, 2)
        x, y = 6 + c * (pw + 6), 6 + r * (ph + 18)
        d.text((x + 2, y + 2), name, fill=(240, 240, 240))
        sheet.paste(img, (x, y + 16))
    sheet.save(out / "experiments-contact-sheet.png")
    print(f"wrote {out}/experiments.json, experiments-contact-sheet.png")


if __name__ == "__main__":
    main()
