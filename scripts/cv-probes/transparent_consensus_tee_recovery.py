#!/usr/bin/env python3
"""Transparency-aware + normal-tee-consensus occluded tee recovery probe.

This is the independent recovery experiment produced while reviewing
occluded_tee_recovery_v2/v3. It intentionally stays separate from v3 so the two
ideas can be compared head-to-head.

Difference from v2:
  * the basket 42x66 BBOX is only an ASSOCIATION/search footprint;
  * only the basket sprite's actual rendered support (+2px AA dilation) is
    treated as occluded;
  * a fragment-supported fit must also agree with a canonical >=50%-consensus
    band learned from clean ring-tier tees on the same course.

Acceptance:
  * masked ring F0.5 >= 0.80;
  * fragment-on-ring >= 0.80;
  * >=80% of fragment pixels map to canonical positions occupied by >=50% of
    the clean tee population.

Measured result during review:
  Heritage h6: 11.0px, fit ~=0.871; 20/21 (95.2%) surviving fragment pixels
  lie in the >=50%-normal-tee band. Union with v2 h5/h10 gives 72/72 dev tee
  availability. The one extra Dashs placement was inside a known basket
  footprint, so it is basket-attributed rather than unexplained free clutter.
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np

S = Path('/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad')
CACHE = Path('/workspace/nuthing-work/pair-matrix-patched')
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
DASHS = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))
SPRITE = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/endpoints/basket-sprite.json'))

MATCH_SIGMA = 1.75
MIN_VISIBLE_RING = 0.30
SCORE_MIN = 0.80
FRAG_ON_RING_MIN = 0.80
CONSENSUS_PIXEL_MIN = 0.50
CONSENSUS_FRAGMENT_FRAC_MIN = 0.80

HW = {
    'DashsTrack-full': 13.0,
    'HeritagePark-full': 6.9,
    'Lenard-full': 8.3,
    'TowneLake-full': 8.5,
}
HH = {
    'DashsTrack-full': 9.5,
    'HeritagePark-full': 5.0,
    'Lenard-full': 6.2,
    'TowneLake-full': 6.5,
}

TEMPLATE = np.array([[1 if c == '1' else 0 for c in row] for row in SPRITE['rows']], dtype=np.uint8)
TH, TW = TEMPLATE.shape


def fuzzy(d):
    return np.exp(-(d ** 2) / (2.0 * MATCH_SIGMA ** 2))


def f05(p, r):
    if p <= 0 or r <= 0:
        return 0.0
    return 1.25 * p * r / (0.25 * p + r)


def ring_dist(u, v, hw, hh):
    out = np.hypot(np.maximum(np.abs(u) - hw, 0), np.maximum(np.abs(v) - hh, 0))
    inner = np.minimum(np.abs(hw - np.abs(u)), np.abs(hh - np.abs(v)))
    return np.where((np.abs(u) <= hw) & (np.abs(v) <= hh), inner, out)


def truth_tees(nm, top):
    if nm == 'DashsTrack-full':
        return [(h['number'], h['tee']['xPx'], h['tee']['yPx'] - top) for h in DASHS['holes']]
    return [(h['number'], h['tee'][0], h['tee'][1] - top) for h in REG[nm]['registeredHoles']]


def sprite_masks(bright, cache):
    """Return (actual rendered-support occlusion, rectangular association)."""
    H, W = bright.shape
    support = cv2.dilate(TEMPLATE, np.ones((3, 3), np.uint8), iterations=2)
    occ = np.zeros_like(bright)
    assoc = np.zeros_like(bright)
    for b in cache['endpoints']['baskets']:
        x0 = int(round(b['spriteCx'] - TW / 2))
        y0 = int(round(b['spriteCy'] - TH / 2))
        xx0, yy0 = max(0, x0), max(0, y0)
        x1, y1 = min(W, x0 + TW), min(H, y0 + TH)
        if x1 <= xx0 or y1 <= yy0:
            continue
        sx0, sy0 = xx0 - x0, yy0 - y0
        sx1, sy1 = sx0 + (x1 - xx0), sy0 + (y1 - yy0)
        occ[yy0:y1, xx0:x1] |= support[sy0:sy1, sx0:sx1]
        assoc[yy0:y1, xx0:x1] = 1
    return occ, assoc


def badge_masks(bright, cache):
    """Badge frame is opaque; retain its actual white-frame component bbox."""
    H, W = bright.shape
    occ = np.zeros_like(bright)
    assoc = np.zeros_like(bright)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
    for bd in cache['badges']:
        bx, by = int(bd['cx']), int(bd['cy'])
        lb = 0
        for cand in set(labels[max(0, by - 2):min(H, by + 3), max(0, bx - 2):min(W, bx + 3)].ravel()):
            if cand > 0 and stats[cand][4] > 150:
                lb = int(cand)
        if lb > 0:
            x0 = int(stats[lb][0] - 3)
            y0 = int(stats[lb][1] - 3)
            w0 = int(stats[lb][2] + 6)
            h0 = int(stats[lb][3] + 6)
        else:
            x0, y0, w0, h0 = bx - 31, by - 25, 62, 50
        xx0, yy0 = max(0, x0), max(0, y0)
        x1, y1 = min(W, x0 + w0), min(H, y0 + h0)
        occ[yy0:y1, xx0:x1] = 1
        assoc[yy0:y1, xx0:x1] = 1
    return occ, assoc


def learn_consensus(bright, cache, nm):
    """Canonical per-pixel tee-paint probability from clean ring-tier tees."""
    hw, hh = HW[nm], HH[nm]
    U = np.arange(-hw - 4, hw + 4.001, 1.0)
    V = np.arange(-hh - 4, hh + 4.001, 1.0)
    uu, vv = np.meshgrid(U, V)
    acc = np.zeros_like(uu, dtype=np.float32)
    n = 0
    baskets = cache['endpoints']['baskets']
    badges = cache['badges']
    for t in cache['endpoints']['tees']:
        if t.get('tier') != 'ring' or t.get('angle') is None:
            continue
        if any(np.hypot(t['x'] - b['spriteCx'], t['y'] - b['spriteCy']) < 40 for b in baskets):
            continue
        if any(np.hypot(t['x'] - b['cx'], t['y'] - b['cy']) < 40 for b in badges):
            continue
        th = float(t['angle'])
        c, s = math.cos(th), math.sin(th)
        gx = np.rint(t['x'] + uu * c - vv * s).astype(int)
        gy = np.rint(t['y'] + uu * s + vv * c).astype(int)
        ok = (gx >= 0) & (gx < bright.shape[1]) & (gy >= 0) & (gy < bright.shape[0])
        vals = np.zeros_like(acc)
        vals[ok] = bright[gy[ok], gx[ok]]
        acc += vals
        n += 1
    return U, V, acc / max(1, n), n


def fragment_consensus(fx, fy, cx, cy, th, consensus):
    U, V, prob, _ = consensus
    c, s = math.cos(th), math.sin(th)
    bx, by = fx - cx, fy - cy
    u = bx * c + by * s
    v = -bx * s + by * c
    ui = np.rint(u - U[0]).astype(int)
    vi = np.rint(v - V[0]).astype(int)
    ok = (ui >= 0) & (ui < len(U)) & (vi >= 0) & (vi < len(V))
    if not ok.any():
        return 0.0, 0.0
    p = prob[vi[ok], ui[ok]]
    return float(np.mean(p >= CONSENSUS_PIXEL_MIN)), float(np.mean(p))


def recover_course(nm):
    cache = json.load(open(CACHE / f'{nm}.json'))
    top = cache['viewport']['top']
    img = cv2.imread(str(S / f'{nm}-cropped.png'))
    hsv = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), cv2.COLOR_RGB2HSV)
    bright = ((hsv[:, :, 2] >= 210) & (hsv[:, :, 1] <= 45)).astype(np.uint8)
    H, W = bright.shape

    sprite_occ, sprite_assoc = sprite_masks(bright, cache)
    badge_occ, badge_assoc = badge_masks(bright, cache)
    occ = np.maximum(sprite_occ, badge_occ)
    assoc = np.maximum(sprite_assoc, badge_assoc)
    assoc_d = cv2.dilate(assoc, np.ones((3, 3), np.uint8), iterations=1)

    visible = (bright & (1 - occ)).astype(np.uint8)
    dist_to_bright = cv2.distanceTransform(1 - visible, cv2.DIST_L2, 3)
    _, labels, stats, cents = cv2.connectedComponentsWithStats(visible, connectivity=8)
    have = [(t['x'], t['y']) for t in cache['endpoints']['tees']]
    consensus = learn_consensus(bright, cache, nm)
    hw, hh = HW[nm], HH[nm]

    recovered = []
    for lb in range(1, len(stats)):
        x, y, w, h, area = stats[lb]
        if not (15 <= area <= 300) or w > 34 or h > 34:
            continue
        cxf, cyf = cents[lb]
        if any(np.hypot(cxf - tx, cyf - ty) < 14 for tx, ty in have):
            continue
        frag = labels[y:y + h, x:x + w] == lb
        fys, fxs = np.nonzero(frag)
        fx, fy = fxs + x, fys + y
        if not assoc_d[fy, fx].any():
            continue

        best = None
        for th in np.arange(0, np.pi, np.pi / 24):
            c, s = np.cos(th), np.sin(th)
            for du in np.arange(-hw, hw + 0.1, 2.0):
                for dv in (-hh, hh):
                    side_u = dv * hw / hh
                    side_u = side_u if abs(side_u) <= hw else np.sign(side_u) * hw
                    for ru, rv in ((du, dv), (side_u, du * hh / hw)):
                        cx = cxf - (ru * c - rv * s)
                        cy = cyf - (ru * s + rv * c)
                        icx, icy = int(cx), int(cy)
                        if not (2 <= icx < W - 2 and 2 <= icy < H - 2):
                            continue
                        if not assoc_d[max(0, icy - 3):icy + 4, max(0, icx - 3):icx + 4].any():
                            continue

                        bx, by = fx - cx, fy - cy
                        u, v = bx * c + by * s, -bx * s + by * c
                        frag_on = float(np.mean(fuzzy(ring_dist(u, v, hw, hh))))
                        if frag_on < FRAG_ON_RING_MIN:
                            continue

                        eu = np.concatenate([
                            np.linspace(-hw, hw, 18), np.full(12, hw),
                            np.linspace(hw, -hw, 18), np.full(12, -hw),
                        ])
                        ev = np.concatenate([
                            np.full(18, -hh), np.linspace(-hh, hh, 12),
                            np.full(18, hh), np.linspace(hh, -hh, 12),
                        ])
                        rx = cx + eu * c - ev * s
                        ry = cy + eu * s + ev * c
                        inb = (rx >= 0) & (rx < W) & (ry >= 0) & (ry < H)
                        rx, ry = rx[inb], ry[inb]
                        covered = occ[ry.astype(int), rx.astype(int)] > 0
                        vis = ~covered
                        if vis.mean() < MIN_VISIBLE_RING:
                            continue
                        d = dist_to_bright[ry[vis].astype(int), rx[vis].astype(int)]
                        coverage = float(np.mean(fuzzy(d)))

                        r_ext = int(np.hypot(hw, hh)) + 4
                        x0, x1 = max(0, icx - r_ext), min(W, icx + r_ext)
                        y0, y1 = max(0, icy - r_ext), min(H, icy + r_ext)
                        byy, bxx = np.nonzero(visible[y0:y1, x0:x1])
                        if len(bxx) < 8:
                            continue
                        obx, oby = bxx + x0 - cx, byy + y0 - cy
                        ou, ov = obx * c + oby * s, -obx * s + oby * c
                        inside = (np.abs(ou) <= hw + 4) & (np.abs(ov) <= hh + 4)
                        if inside.sum() < 8:
                            continue
                        explained = float(np.mean(fuzzy(ring_dist(ou[inside], ov[inside], hw, hh))))
                        interior = (np.abs(ou) <= hw - 3) & (np.abs(ov) <= hh - 3)
                        if interior.sum() and interior.sum() / max(1, inside.sum()) > 0.15:
                            continue

                        cons_frac, cons_mean = fragment_consensus(fx, fy, cx, cy, th, consensus)
                        if cons_frac < CONSENSUS_FRAGMENT_FRAC_MIN:
                            continue

                        score = f05(explained, coverage) * min(1.0, frag_on / 0.9)
                        if score < SCORE_MIN:
                            continue
                        row = (score, cx, cy, th, frag_on, cons_frac, cons_mean, lb)
                        if best is None or score > best[0]:
                            best = row
        if best is not None:
            recovered.append(best)

    recovered.sort(reverse=True, key=lambda r: r[0])
    kept = []
    for r in recovered:
        if any(np.hypot(r[1] - k[1], r[2] - k[2]) < 14 for k in kept):
            continue
        kept.append(r)

    truth = truth_tees(nm, top)
    pool_have = set()
    for t in cache['endpoints']['tees']:
        for num, tx, ty in truth:
            if np.hypot(t['x'] - tx, t['y'] - ty) <= 18:
                pool_have.add(num)
    missing = [num for num, _, _ in truth if num not in pool_have]

    print(f'\n{nm}: baseline-missing={missing}, consensus seeds={consensus[3]}, kept={len(kept)}')
    for score, cx, cy, th, frag_on, cf, cm, lb in kept:
        hits = [(num, np.hypot(cx - tx, cy - ty)) for num, tx, ty in truth if np.hypot(cx - tx, cy - ty) <= 18]
        basket_attr = any(abs(cx - b['spriteCx']) <= TW / 2 and abs(cy - b['spriteCy']) <= TH / 2 for b in cache['endpoints']['baskets'])
        if hits:
            num, d = min(hits, key=lambda x: x[1])
            tag = 'RECOVERED-MISS' if num in missing else 'dup'
            print(f'  h{num}: score={score:.3f} d={d:.1f}px consensus50={cf:.3f} mean={cm:.3f} [{tag}]')
        else:
            kind = 'basket-attributed' if basket_attr else 'UNEXPLAINED-FP'
            print(f'  {kind}: ({cx:.1f},{cy:.1f}) score={score:.3f} consensus50={cf:.3f} mean={cm:.3f}')


if __name__ == '__main__':
    for course in ['HeritagePark-full', 'DashsTrack-full', 'Lenard-full', 'TowneLake-full']:
        recover_course(course)
