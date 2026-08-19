#!/usr/bin/env python3
"""Occluded-tee recovery v2 — fragment-anchored, per user guidance:
"when you white-mask to find the baskets (and find the tee size), check
AROUND the basket for something that could be a tee; same with badges."

For every known occluder (matched sprite footprint / badge frame):
  1. find candidate FRAGMENTS: unclaimed bright components touching the
     occluder, sized like a piece of tee paint (15..300 px);
  2. fit the measured modal pad (size from this course's ring-detected
     tees) at placements where the fragment lies ON the pad border and the
     pad center is under/near the occluder;
  3. masked F0.5: fragment+visible bright must lie on the ring
     (explained), visible ring must be supported (coverage), missing ring
     excused only under the occluder; require the fragment itself to sit
     on the ring.
No fragment -> no search -> no blind-grid false positives.
"""
import json
import numpy as np
import cv2

S = '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad'
CACHE = '/workspace/nuthing-work/pair-matrix-patched'
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
DASHS = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))

MATCH_SIGMA = 1.75
MIN_VISIBLE_RING = 0.30
SCORE_MIN = 0.80
FRAG_ON_RING_MIN = 0.80


def fuzzy(d):
    return np.exp(-(d ** 2) / (2.0 * MATCH_SIGMA ** 2))


def f05(p, r):
    if p <= 0 or r <= 0:
        return 0.0
    return 1.25 * p * r / (0.25 * p + r)


def truth_tees(nm, top):
    if nm == 'DashsTrack-full':
        return [(h['number'], h['tee']['xPx'], h['tee']['yPx'] - top) for h in DASHS['holes']]
    return [(h['number'], h['tee'][0], h['tee'][1] - top) for h in REG[nm]['registeredHoles']]


def ring_dist(u, v, hw, hh):
    """Distance of points (pad frame) to the rect ring centerline."""
    out = np.hypot(np.maximum(np.abs(u) - hw, 0), np.maximum(np.abs(v) - hh, 0))
    inner = np.minimum(np.abs(hw - np.abs(u)), np.abs(hh - np.abs(v)))
    return np.where((np.abs(u) <= hw) & (np.abs(v) <= hh), inner, out)


for nm in ['HeritagePark-full', 'DashsTrack-full', 'Lenard-full', 'TowneLake-full']:
    cache = json.load(open(f'{CACHE}/{nm}.json'))
    top = cache['viewport']['top']
    img = cv2.imread(f'{S}/{nm}-cropped.png')
    hsv = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), cv2.COLOR_RGB2HSV)
    bright = ((hsv[:, :, 2] >= 210) & (hsv[:, :, 1] <= 45)).astype(np.uint8)
    H, W = bright.shape

    occ = np.zeros_like(bright)
    occluders = []
    for b in cache['endpoints']['baskets']:
        x0 = int(b['spriteCx'] - 21); y0 = int(b['spriteCy'] - 33)
        occ[max(0, y0):y0 + 66, max(0, x0):x0 + 42] = 1
        occluders.append(('sprite', x0, y0, 42, 66))
    # Badge occluder = the badge's actual white FRAME component bbox (the
    # digit-plate-centered fixed box under-covers the frame; surviving frame
    # edges then masquerade as pad fragments and fit the pad model).
    ncc0, lab0, st0, ce0 = cv2.connectedComponentsWithStats(bright, connectivity=8)
    for bd in cache['badges']:
        bx, by = int(bd['cx']), int(bd['cy'])
        lb0 = 0
        for cand in set(lab0[max(0, by - 2):by + 3, max(0, bx - 2):bx + 3].ravel()):
            if cand > 0 and st0[cand][4] > 150:
                lb0 = cand
        if lb0 > 0:
            x0, y0, w0, h0 = st0[lb0][0] - 3, st0[lb0][1] - 3, st0[lb0][2] + 6, st0[lb0][3] + 6
        else:
            x0, y0, w0, h0 = bx - 31, by - 25, 62, 50
        occ[max(0, y0):y0 + h0, max(0, x0):x0 + w0] = 1
        occluders.append(('badge', x0, y0, w0, h0))

    # Modal pad half-extents from this course's ring tees, honoring "find
    # the tee size": ring-tier detections carry the pad interior; outer
    # border centerline ~ interior + border thickness. Estimate from the
    # detected tee components in the cache (bbox medians).
    ring = [t for t in cache['endpoints']['tees'] if t.get('tier') == 'ring']
    # per-course pad outer size measured earlier ~19x14..21x15; centerline
    # half-extents = (outer - border)/2 with border~3
    HW = {'DashsTrack-full': 13.0, 'HeritagePark-full': 6.9,
          'Lenard-full': 8.3, 'TowneLake-full': 8.5}[nm]
    HH = {'DashsTrack-full': 9.5, 'HeritagePark-full': 5.0,
          'Lenard-full': 6.2, 'TowneLake-full': 6.5}[nm]

    vis_bright = (bright & (1 - occ)).astype(np.uint8)
    dist_to_bright = cv2.distanceTransform(1 - vis_bright, cv2.DIST_L2, 3)

    # unclaimed fragments touching an occluder
    ncc, labels, stats, cents = cv2.connectedComponentsWithStats(vis_bright, connectivity=8)
    tees_have = [(t['x'], t['y']) for t in cache['endpoints']['tees']]
    kernel = np.ones((3, 3), np.uint8)
    occ_d = cv2.dilate(occ, kernel, iterations=1)

    recovered = []
    for lb in range(1, ncc):
        x, y, w, h, area = stats[lb]
        if not (15 <= area <= 300) or w > 34 or h > 34:
            continue
        cxf, cyf = cents[lb]
        if any(np.hypot(cxf - tx, cyf - ty) < 14 for tx, ty in tees_have):
            continue
        frag = (labels[y:y + h, x:x + w] == lb)
        fys, fxs = np.nonzero(frag)
        fx = fxs + x
        fy = fys + y
        # must touch a (dilated) occluder
        if not occ_d[fy, fx].any():
            continue
        best = None
        for th in np.arange(0, np.pi, np.pi / 24):
            c0, s0 = np.cos(th), np.sin(th)
            # candidate centers: fragment centroid pushed perpendicular /
            # along so the fragment lands on the ring: search a small grid
            for du in np.arange(-HW, HW + 0.1, 2.0):
                for dv in (-HH, HH):
                    # fragment centroid maps to ring point (du, dv) or (±HW, du-ish)
                    for (ru, rv) in ((du, dv), (dv * HW / HH if abs(dv * HW / HH) <= HW else np.sign(dv) * HW, du * HH / HW)):
                        cx = cxf - (ru * c0 - rv * s0)
                        cy = cyf - (ru * s0 + rv * c0)
                        icx, icy = int(cx), int(cy)
                        if not (2 <= icx < W - 2 and 2 <= icy < H - 2):
                            continue
                        if not occ_d[max(0, icy - 3):icy + 4, max(0, icx - 3):icx + 4].any():
                            continue
                        # fragment pixels in pad frame
                        bx = fx - cx
                        by = fy - cy
                        u = bx * c0 + by * s0
                        v = -bx * s0 + by * c0
                        dfrag = ring_dist(u, v, HW, HH)
                        frag_on = float(np.mean(fuzzy(dfrag)))
                        if frag_on < FRAG_ON_RING_MIN:
                            continue
                        # ring sampling
                        tt_pts = np.arange(0, 2 * np.pi, 2 * np.pi / 72)
                        # parametrize rect ring by walking edges
                        eu = np.concatenate([np.linspace(-HW, HW, 18), np.full(12, HW),
                                             np.linspace(HW, -HW, 18), np.full(12, -HW)])
                        ev = np.concatenate([np.full(18, -HH), np.linspace(-HH, HH, 12),
                                             np.full(18, HH), np.linspace(HH, -HH, 12)])
                        rxp = cx + eu * c0 - ev * s0
                        ryp = cy + eu * s0 + ev * c0
                        inb = (rxp >= 0) & (rxp < W) & (ryp >= 0) & (ryp < H)
                        rxp, ryp = rxp[inb], ryp[inb]
                        if len(rxp) < 20:
                            continue
                        covered = occ[ryp.astype(int), rxp.astype(int)] > 0
                        visible = ~covered
                        if visible.mean() < MIN_VISIBLE_RING:
                            continue
                        dcov = dist_to_bright[ryp[visible].astype(int), rxp[visible].astype(int)]
                        coverage = float(np.mean(fuzzy(dcov)))
                        # A real covered pad is ONE dead-end paint fragment
                        # (maybe two). A C2D dash arc "supports" a fake ring
                        # with 4-6 separate dash components — count distinct
                        # supporting components and reject multi-piece fits.
                        sup = set()
                        for pyv, pxv in zip(ryp[visible].astype(int), rxp[visible].astype(int)):
                            win = labels[max(0, pyv - 2):pyv + 3, max(0, pxv - 2):pxv + 3]
                            for lbv in np.unique(win):
                                if lbv > 0:
                                    sup.add(int(lbv))
                        if len(sup) > 2:
                            continue
                        # explained over all visible bright in pad bbox
                        r_ext = int(np.hypot(HW, HH)) + 4
                        x0w, x1w = max(0, icx - r_ext), min(W, icx + r_ext)
                        y0w, y1w = max(0, icy - r_ext), min(H, icy + r_ext)
                        byy, bxx = np.nonzero(vis_bright[y0w:y1w, x0w:x1w])
                        if len(bxx) < 8:
                            continue
                        obx = bxx + x0w - cx
                        oby = byy + y0w - cy
                        ou = obx * c0 + oby * s0
                        ov = -obx * s0 + oby * c0
                        inside = (np.abs(ou) <= HW + 4) & (np.abs(ov) <= HH + 4)
                        if inside.sum() < 8:
                            continue
                        dr = ring_dist(ou[inside], ov[inside], HW, HH)
                        explained = float(np.mean(fuzzy(dr)))
                        # interior contradiction: visible pad interior must
                        # not be bright (it is gray paint / basemap)
                        interior = (np.abs(ou) <= HW - 3) & (np.abs(ov) <= HH - 3)
                        if interior.sum() > 0 and interior.sum() / max(1, inside.sum()) > 0.15:
                            continue
                        sc = f05(explained, coverage) * min(1.0, frag_on / 0.9)
                        # badge-frame veto: the badge's own white
                        # frame is a pad-shaped ring; a fit concentric with
                        # a badge center is the frame, not a hidden pad —
                        # unless the pad is much smaller than the frame
                        # (Heritage-class pads under badges are fine).
                        if max(HW, HH) > 10:
                            if any(np.hypot(cx - bd['cx'], cy - bd['cy']) < 12
                                   for bd in cache['badges']):
                                continue
                        if best is None or sc > best[0]:
                            best = (sc, cx, cy, th, frag_on, float(visible.mean()))
        if best and best[0] >= SCORE_MIN:
            recovered.append(best + (lb,))

    recovered.sort(key=lambda r: -r[0])
    kept = []
    for r in recovered:
        if any(np.hypot(r[1] - k[1], r[2] - k[2]) < 14 for k in kept):
            continue
        kept.append(r)

    tt = truth_tees(nm, top)
    have = set()
    for t in cache['endpoints']['tees']:
        for num, tx, ty in tt:
            if np.hypot(t['x'] - tx, t['y'] - ty) <= 18:
                have.add(num)
    missing = [num for num, tx, ty in tt if num not in have]
    hits, fps = [], []
    for sc, cx, cy, th, fo, vis, lb in kept:
        m = [(num, np.hypot(cx - tx, cy - ty)) for num, tx, ty in tt
             if np.hypot(cx - tx, cy - ty) <= 18]
        if m:
            hits.append((m[0][0], sc, m[0][1]))
        else:
            fps.append((cx, cy, sc))
    json.dump([{'x': float(k[1]), 'y': float(k[2]), 'score': float(k[0])} for k in kept],
              open(f'{S}/{nm}-recovered-tees-v2.json', 'w'))
    print(f'{nm}: pool-missing truth tees {missing} | placements kept {len(kept)}')
    for num, sc, d in hits:
        tag = 'RECOVERED-MISS' if num in missing else 'dup-of-detected'
        print(f'  h{num}: score={sc:.3f} d={d:.1f}px [{tag}]')
    for cx, cy, sc in fps:
        print(f'  FP ({cx:.0f},{cy:.0f}) score={sc:.3f}')
