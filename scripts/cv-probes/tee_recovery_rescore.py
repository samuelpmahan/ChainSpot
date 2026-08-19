#!/usr/bin/env python3
"""Downstream of the tee-recovery replay node: re-score placements from the
frozen evidence in milliseconds. Used for the h6 positional-degeneracy
analysis — plateau extraction (the near-tied ridge of placements), the
plateau-midpoint estimator (option 2), and annotated fit screenshots.

Everything here touches ONLY the node snapshots; the expensive evidence
stage never re-runs.
"""
import json
import sys
import numpy as np
import cv2

sys.path.insert(0, '/home/user/ChainSpot/scripts/cv-probes')
from tee_recovery_node import load_node, S  # noqa: E402

CACHE = '/workspace/nuthing-work/pair-matrix-patched'
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
MATCH_SIGMA = 1.75
PAD = {'DashsTrack-full': (13.0, 9.5), 'HeritagePark-full': (6.9, 5.0),
       'Lenard-full': (8.3, 6.2), 'TowneLake-full': (8.5, 6.5)}


def fuzzy(d):
    return np.exp(-(d ** 2) / (2.0 * MATCH_SIGMA ** 2))


def f05(p, r):
    return 0.0 if p <= 0 or r <= 0 else 1.25 * p * r / (0.25 * p + r)


def ring_dist(u, v, hw, hh):
    out = np.hypot(np.maximum(np.abs(u) - hw, 0), np.maximum(np.abs(v) - hh, 0))
    inner = np.minimum(np.abs(hw - np.abs(u)), np.abs(hh - np.abs(v)))
    return np.where((np.abs(u) <= hw) & (np.abs(v) <= hh), inner, out)


def ring_pts(cx, cy, th, hw, hh):
    c0, s0 = np.cos(th), np.sin(th)
    eu = np.concatenate([np.linspace(-hw, hw, 18), np.full(12, hw),
                         np.linspace(hw, -hw, 18), np.full(12, -hw)])
    ev = np.concatenate([np.full(18, -hh), np.linspace(-hh, hh, 12),
                         np.full(18, hh), np.linspace(hh, -hh, 12)])
    return cx + eu * c0 - ev * s0, cy + eu * s0 + ev * c0


def score_at(node, cx, cy, th, hw, hh, sup_t=0.5):
    H, W = node['vis'].shape
    rxp, ryp = ring_pts(cx, cy, th, hw, hh)
    inb = (rxp >= 0) & (rxp < W) & (ryp >= 0) & (ryp < H)
    rxp, ryp = rxp[inb], ryp[inb]
    s = fuzzy(node['dtb'][ryp.astype(int), rxp.astype(int)])
    covered = node['occ_broad'][ryp.astype(int), rxp.astype(int)] > 0
    included = (~covered) | (s >= sup_t)
    if included.mean() < 0.30:
        return None
    coverage = float(np.mean(s[included]))
    icx, icy = int(cx), int(cy)
    r_ext = int(np.hypot(hw, hh)) + 4
    x0w, x1w = max(0, icx - r_ext), min(W, icx + r_ext)
    y0w, y1w = max(0, icy - r_ext), min(H, icy + r_ext)
    byy, bxx = np.nonzero(node['vis'][y0w:y1w, x0w:x1w])
    if len(bxx) < 8:
        return None
    c0, s0 = np.cos(th), np.sin(th)
    ou = (bxx + x0w - cx) * c0 + (byy + y0w - cy) * s0
    ov = -(bxx + x0w - cx) * s0 + (byy + y0w - cy) * c0
    inside = (np.abs(ou) <= hw + 4) & (np.abs(ov) <= hh + 4)
    if inside.sum() < 8:
        return None
    interior = (np.abs(ou) <= hw - 3) & (np.abs(ov) <= hh - 3)
    if interior.sum() > 0 and interior.sum() / max(1, inside.sum()) > 0.15:
        return None
    explained = float(np.mean(fuzzy(ring_dist(ou[inside], ov[inside], hw, hh))))
    return f05(explained, coverage)


def plateau(node, tx, ty, hw, hh, R=14, step=0.5, keep_frac=0.92):
    """Score landscape around (tx,ty); return argmax, the near-tied plateau
    (>= keep_frac * max) as points, its midpoint, and principal axis."""
    pts = []
    for dcx in np.arange(-R, R + 0.01, step):
        for dcy in np.arange(-R, R + 0.01, step):
            best = 0.0
            bth = 0.0
            for th in np.arange(0, np.pi, np.pi / 12):
                r = score_at(node, tx + dcx, ty + dcy, th, hw, hh)
                if r and r > best:
                    best, bth = r, th
            if best > 0:
                pts.append((best, dcx, dcy, bth))
    mx = max(p[0] for p in pts)
    arg = max(pts, key=lambda p: p[0])
    plat = [p for p in pts if p[0] >= keep_frac * mx]
    P = np.array([[p[1], p[2]] for p in plat])
    mid = P.mean(axis=0)
    Pc = P - mid
    if len(P) > 2:
        w, V = np.linalg.eigh(Pc.T @ Pc / len(P))
        axis = V[:, -1]
        extent = 2 * np.sqrt(max(w))
    else:
        axis, extent = np.array([1.0, 0.0]), 0.0
    return {'argmax': arg, 'max': mx, 'plateau': plat, 'mid': mid,
            'axis': axis, 'extentPx': float(extent)}


if __name__ == '__main__':
    nm = 'HeritagePark-full'
    node = load_node(nm)
    cache = json.load(open(f'{CACHE}/{nm}.json'))
    top = cache['viewport']['top']
    hw, hh = PAD[nm]
    img = cv2.imread(f'{S}/{nm}-cropped.png')
    imgf = img.astype(float)
    tiles = []
    for hole in (6, 5, 10):
        h = next(x for x in REG[nm]['registeredHoles'] if x['number'] == hole)
        tx, ty = h['tee'][0], h['tee'][1] - top
        pl = plateau(node, tx, ty, hw, hh)
        ag = pl['argmax']
        me = np.hypot(ag[1], ag[2])
        md = np.hypot(*pl['mid'])
        print(f'h{hole}: argmax err {me:.1f}px (score {ag[0]:.3f}) | '
              f'plateau n={len(pl["plateau"])} extent {pl["extentPx"]:.1f}px '
              f'axis ({pl["axis"][0]:+.2f},{pl["axis"][1]:+.2f}) | '
              f'MIDPOINT err {md:.1f}px')
        # annotated screenshot: observed | reconstructed, rects drawn
        L = 34
        icx, icy = int(tx), int(ty)
        crop = img[icy - L:icy + L, icx - L:icx + L].copy()
        # reconstruction panel for the nearest sprite bbox region
        rec = crop.copy().astype(float)
        origins = node['meta']['spriteOrigins']
        o = min(origins, key=lambda o: np.hypot(o['x0'] + 21 - tx, o['y0'] + 33 - ty))
        alpha, alphaS = node['alpha'], node['alphaS']
        den = np.clip(1 - alpha, 0.25, 1.0)[..., None]
        V = imgf[o['y0']:o['y0'] + 66, o['x0']:o['x0'] + 42]
        G = np.clip((V - alphaS) / den, 0, 255)
        m = alpha < 0.75
        gy0, gx0 = o['y0'] - (icy - L), o['x0'] - (icx - L)
        for yy in range(66):
            for xx in range(42):
                py, px = gy0 + yy, gx0 + xx
                if 0 <= py < 2 * L and 0 <= px < 2 * L and m[yy, xx]:
                    rec[py, px] = G[yy, xx]
        rec = rec.astype(np.uint8)
        SC = 7
        panels = []
        for base, lbl in ((crop, 'observed'), (rec, 'alpha-unblended')):
            p = cv2.resize(base, (2 * L * SC, 2 * L * SC), interpolation=cv2.INTER_NEAREST)
            vs = node['vis'][icy - L:icy + L, icx - L:icx + L]
            for (yy, xx) in zip(*np.nonzero(vs)):
                cv2.rectangle(p, (xx * SC, yy * SC), (xx * SC + SC - 2, yy * SC + SC - 2), (0, 0, 255), 1)
            for (ox, oy, th_, col) in [(0.0, 0.0, ag[3], (0, 255, 0)),
                                       (ag[1], ag[2], ag[3], (255, 0, 255)),
                                       (pl['mid'][0], pl['mid'][1], ag[3], (0, 255, 255))]:
                rx, ry = ring_pts(tx + ox, ty + oy, th_, hw, hh)
                for a, b in zip(range(len(rx) - 1), range(1, len(rx))):
                    cv2.line(p, (int((rx[a] - icx + L) * SC), int((ry[a] - icy + L) * SC)),
                             (int((rx[b] - icx + L) * SC), int((ry[b] - icy + L) * SC)), col, 2)
            cv2.rectangle(p, (0, 0), (p.shape[1], 20), (0, 0, 0), -1)
            cv2.putText(p, f'h{hole} {lbl}: truth-rect green, argmax magenta, plateau-mid yellow',
                        (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1)
            panels.append(p)
        tiles.append(np.hstack(panels))
    wmax = max(t.shape[1] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, 6, 0, wmax - t.shape[1], cv2.BORDER_CONSTANT, value=(30, 30, 30))
             for t in tiles]
    out = np.vstack(tiles)
    cv2.imwrite(f'{S}/tee-recovery-fits.png', out)
    print(f'wrote {S}/tee-recovery-fits.png')
