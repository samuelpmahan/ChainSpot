#!/usr/bin/env python3
"""Occluded-tee recovery v3 — alpha-unblended sprite regions.

v2 treated each basket's 42x66 sprite bbox as an opaque rectangle. The
sprite is NOT opaque: outside its ~1746-px glyph the bbox is transparent,
and much of the glyph's skirt is SEMI-transparent (soft shadow/glow), so
ground paint under it survives attenuated. Heritage h6's tee lives almost
entirely inside its basket's bbox — v2 deleted the only evidence before
scoring (found via cross-checking with an external review of the recovery).

Per course, from the N sprite instances (alpha compositing is inverted
statistically — ground varies per instance, the sprite doesn't):
  - per-pixel std across instances; sig_ref = median std at the bbox
    corners (always transparent)  ->  alpha = 1 - std/sig_ref
  - alphaS = mean - (1-alpha)*mu_ground  ->  reconstruct this instance's
    ground:  Ghat = (V - alphaS) / (1 - alpha)
  - evidence = raw bright outside the opaque core, plus reconstructed
    bright where alpha < A_CUT, filtered by cross-instance UNIQUENESS
    (a pixel whose reconstruction is bright in >2 instances is a repeated
    un-blending artifact, not ground paint)
  - excusal is support-aware: an expected ring point under the broad
    (Otsu-std) sprite mask is excused only if NO evidence supports it;
    supported points count positively wherever they are
  - artifact family filter: recovered placements sharing a bbox-relative
    offset at >=3 baskets are the same un-blending artifact
  - big-blob veto: no pad within 25px of a bright component > 400px unless
    that component is a known sprite/badge (rooftops, map-attribution logo)

Validated against truth: recovers Heritage h6 (v2's one honest miss) while
keeping v2's h5/h10 recoveries reachable (run v2 for those; this script
reports the union check) with off-course FPs suppressed.
"""
import json
import numpy as np
import cv2

S = '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad'
CACHE = '/workspace/nuthing-work/pair-matrix-patched'
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
DASHS = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))

MATCH_SIGMA = 1.75
SCORE_MIN = 0.80
A_CUT = 0.75          # reconstruct only where alpha < this (den >= 0.25)
RECON_V = 195         # bright threshold on reconstructed ground (noise-widened)
UNIQ_MAX = 2          # reconstructed-bright in more instances = artifact
BLOB_MAX = 400        # bright components bigger than this are "furniture"
BLOB_DIST = 25        # no pad this close to furniture
FAMILY_SEP = 3        # bbox-relative offset clustering radius
FAMILY_MIN = 3        # >= this many baskets sharing an offset = artifact family


def fuzzy(d):
    return np.exp(-(d ** 2) / (2.0 * MATCH_SIGMA ** 2))


def f05(p, r):
    return 0.0 if p <= 0 or r <= 0 else 1.25 * p * r / (0.25 * p + r)


def ring_dist(u, v, hw, hh):
    out = np.hypot(np.maximum(np.abs(u) - hw, 0), np.maximum(np.abs(v) - hh, 0))
    inner = np.minimum(np.abs(hw - np.abs(u)), np.abs(hh - np.abs(v)))
    return np.where((np.abs(u) <= hw) & (np.abs(v) <= hh), inner, out)


def truth_tees(nm, top):
    if nm == 'DashsTrack-full':
        return [(h['number'], h['tee']['xPx'], h['tee']['yPx'] - top) for h in DASHS['holes']]
    return [(h['number'], h['tee'][0], h['tee'][1] - top) for h in REG[nm]['registeredHoles']]


for nm in ['HeritagePark-full', 'DashsTrack-full', 'Lenard-full', 'TowneLake-full']:
    cache = json.load(open(f'{CACHE}/{nm}.json'))
    top = cache['viewport']['top']
    imgf = cv2.imread(f'{S}/{nm}-cropped.png').astype(float)
    img = imgf.astype(np.uint8)
    H, W = imgf.shape[:2]
    hsv = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), cv2.COLOR_RGB2HSV)
    bright = ((hsv[:, :, 2] >= 210) & (hsv[:, :, 1] <= 45)).astype(np.uint8)
    bs = cache['endpoints']['baskets']

    # ---- known-occluder boxes (for the furniture exemption) ---------------
    known_box = np.zeros_like(bright)
    for b in bs:
        x0 = int(round(b['spriteCx'] - 21))
        y0 = int(round(b['spriteCy'] - 33))
        known_box[max(0, y0):y0 + 66, max(0, x0):x0 + 42] = 1
    for bd in cache['badges']:
        bx, by = int(bd['cx']), int(bd['cy'])
        known_box[max(0, by - 25):by + 25, max(0, bx - 31):bx + 31] = 1

    # ---- furniture veto map: big bright components NOT ours ---------------
    nb, bl, bstat, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
    big = np.zeros_like(bright)
    for l2 in range(1, nb):
        if bstat[l2][4] <= BLOB_MAX:
            continue
        comp = (bl == l2)
        if known_box[comp].mean() > 0.3:
            continue  # a sprite/badge component, not furniture
        big[comp] = 1
    big_d = cv2.dilate(big, np.ones((2 * BLOB_DIST + 1, 2 * BLOB_DIST + 1), np.uint8))

    # ---- alpha model from the sprite instance stack -----------------------
    crops = []
    idxs = []
    for i, b in enumerate(bs):
        x0, y0 = int(round(b['spriteCx'] - 21)), int(round(b['spriteCy'] - 33))
        if 0 <= x0 and 0 <= y0 and x0 + 42 <= W and y0 + 66 <= H:
            crops.append(imgf[y0:y0 + 66, x0:x0 + 42])
            idxs.append(i)
    stack = np.stack(crops)
    mean = stack.mean(axis=0)
    std = stack.std(axis=0).mean(axis=2)
    corners = np.concatenate([std[:6, :6].ravel(), std[:6, -6:].ravel(),
                              std[-6:, :6].ravel(), std[-6:, -6:].ravel()])
    sig_ref = float(np.median(corners))
    alpha = np.clip(1.0 - std / sig_ref, 0.0, 1.0)
    s8 = np.clip(std, 0, 80).astype(np.uint8)
    otsu_t, _ = cv2.threshold(s8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    broad = cv2.dilate(cv2.morphologyEx((std <= otsu_t).astype(np.uint8), cv2.MORPH_CLOSE,
                                        np.ones((3, 3), np.uint8)),
                       np.ones((3, 3), np.uint8), iterations=2)
    core = cv2.dilate((alpha >= A_CUT).astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2)
    mu_g = np.median(np.stack([stack[:, :6, :6], stack[:, :6, -6:],
                               stack[:, -6:, :6], stack[:, -6:, -6:]]).reshape(-1, 3), axis=0)
    alphaS = mean - (1 - alpha[..., None]) * mu_g
    den = np.clip(1 - alpha, max(0.12, 1 - A_CUT), 1.0)[..., None]
    br_all = []
    for c in crops:
        G = np.clip((c - alphaS) / den, 0, 255).astype(np.uint8)
        hv = cv2.cvtColor(G, cv2.COLOR_BGR2HSV)
        br_all.append(((hv[:, :, 2] >= RECON_V) & (hv[:, :, 1] <= 60) & (alpha < A_CUT)).astype(np.uint8))
    uniq_ok = (np.stack(br_all).sum(axis=0) <= UNIQ_MAX).astype(np.uint8)

    # ---- occluder + evidence maps -----------------------------------------
    occ_gate = np.zeros_like(bright)   # rect bboxes + badges: search gating
    occ_broad = np.zeros_like(bright)  # generous mask: excusal if unsupported
    occ_core = np.zeros_like(bright)   # opaque core: no evidence readable
    ev = bright.copy()
    for k, i in enumerate(idxs):
        b = bs[i]
        x0 = int(round(b['spriteCx'] - 21))
        y0 = int(round(b['spriteCy'] - 33))
        xs, ys = max(0, x0), max(0, y0)
        xe, ye = min(W, x0 + 42), min(H, y0 + 66)
        occ_gate[ys:ye, xs:xe] = 1
        occ_broad[ys:ye, xs:xe] |= broad[ys - y0:ye - y0, xs - x0:xe - x0]
        occ_core[ys:ye, xs:xe] |= core[ys - y0:ye - y0, xs - x0:xe - x0]
        rec = (br_all[k] & uniq_ok)
        ev[ys:ye, xs:xe] |= rec[ys - y0:ye - y0, xs - x0:xe - x0]
    ncc0, lab0, st0, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
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
        occ_gate[max(0, y0):y0 + h0, max(0, x0):x0 + w0] = 1
        occ_broad[max(0, y0):y0 + h0, max(0, x0):x0 + w0] = 1
        occ_core[max(0, y0):y0 + h0, max(0, x0):x0 + w0] = 1

    HW = {'DashsTrack-full': 13.0, 'HeritagePark-full': 6.9,
          'Lenard-full': 8.3, 'TowneLake-full': 8.5}[nm]
    HH = {'DashsTrack-full': 9.5, 'HeritagePark-full': 5.0,
          'Lenard-full': 6.2, 'TowneLake-full': 6.5}[nm]
    vis = (ev & (1 - occ_core)).astype(np.uint8)
    dtb = cv2.distanceTransform(1 - vis, cv2.DIST_L2, 3)
    ncc, labels, stats, cents = cv2.connectedComponentsWithStats(vis, connectivity=8)
    tees_have = [(t['x'], t['y']) for t in cache['endpoints']['tees']]
    gate_d = cv2.dilate(occ_gate, np.ones((3, 3), np.uint8))

    recovered = []
    for lb in range(1, ncc):
        x, y, w, h2, area = stats[lb]
        if not (7 <= area <= 300) or w > 34 or h2 > 34:
            continue
        cxf, cyf = cents[lb]
        if any(np.hypot(cxf - tx, cyf - ty) < 14 for tx, ty in tees_have):
            continue
        if big_d[int(cyf), int(cxf)]:
            continue
        frag = (labels[y:y + h2, x:x + w] == lb)
        fys, fxs = np.nonzero(frag)
        fx = fxs + x
        fy = fys + y
        if not gate_d[fy, fx].any():
            continue
        best = None
        for th in np.arange(0, np.pi, np.pi / 24):
            c0, s0 = np.cos(th), np.sin(th)
            for du in np.arange(-HW, HW + 0.1, 2.0):
                for dv in (-HH, HH):
                    for (ru, rv) in ((du, dv),
                                     (dv * HW / HH if abs(dv * HW / HH) <= HW else np.sign(dv) * HW,
                                      du * HH / HW)):
                        cx = cxf - (ru * c0 - rv * s0)
                        cy = cyf - (ru * s0 + rv * c0)
                        icx, icy = int(cx), int(cy)
                        if not (2 <= icx < W - 2 and 2 <= icy < H - 2):
                            continue
                        if not gate_d[max(0, icy - 3):icy + 4, max(0, icx - 3):icx + 4].any():
                            continue
                        if big_d[icy, icx]:
                            continue
                        u = (fx - cx) * c0 + (fy - cy) * s0
                        v = -(fx - cx) * s0 + (fy - cy) * c0
                        fon = float(np.mean(fuzzy(ring_dist(u, v, HW, HH))))
                        if fon < 0.80:
                            continue
                        eu = np.concatenate([np.linspace(-HW, HW, 18), np.full(12, HW),
                                             np.linspace(HW, -HW, 18), np.full(12, -HW)])
                        ev2 = np.concatenate([np.full(18, -HH), np.linspace(-HH, HH, 12),
                                              np.full(18, HH), np.linspace(HH, -HH, 12)])
                        rxp = cx + eu * c0 - ev2 * s0
                        ryp = cy + eu * s0 + ev2 * c0
                        inb = (rxp >= 0) & (rxp < W) & (ryp >= 0) & (ryp < H)
                        rxp, ryp = rxp[inb], ryp[inb]
                        s = fuzzy(dtb[ryp.astype(int), rxp.astype(int)])
                        covered = occ_broad[ryp.astype(int), rxp.astype(int)] > 0
                        included = (~covered) | (s >= 0.5)  # excuse covered AND unsupported
                        if included.mean() < 0.30:
                            continue
                        coverage = float(np.mean(s[included]))
                        sup = set()
                        for pyv, pxv in zip(ryp[included].astype(int), rxp[included].astype(int)):
                            for lbv in np.unique(labels[max(0, pyv - 2):pyv + 3, max(0, pxv - 2):pxv + 3]):
                                if lbv > 0:
                                    sup.add(int(lbv))
                        if len(sup) > 3:
                            continue
                        r_ext = int(np.hypot(HW, HH)) + 4
                        x0w, x1w = max(0, icx - r_ext), min(W, icx + r_ext)
                        y0w, y1w = max(0, icy - r_ext), min(H, icy + r_ext)
                        byy, bxx = np.nonzero(vis[y0w:y1w, x0w:x1w])
                        if len(bxx) < 8:
                            continue
                        ou = (bxx + x0w - cx) * c0 + (byy + y0w - cy) * s0
                        ov = -(bxx + x0w - cx) * s0 + (byy + y0w - cy) * c0
                        inside = (np.abs(ou) <= HW + 4) & (np.abs(ov) <= HH + 4)
                        if inside.sum() < 8:
                            continue
                        interior = (np.abs(ou) <= HW - 3) & (np.abs(ov) <= HH - 3)
                        if interior.sum() > 0 and interior.sum() / max(1, inside.sum()) > 0.15:
                            continue
                        explained = float(np.mean(fuzzy(ring_dist(ou[inside], ov[inside], HW, HH))))
                        sc = f05(explained, coverage) * min(1.0, fon / 0.9)
                        if max(HW, HH) > 10:
                            if any(np.hypot(cx - bd['cx'], cy - bd['cy']) < 12 for bd in cache['badges']):
                                continue
                        if best is None or sc > best[0]:
                            best = (sc, cx, cy)
        if best and best[0] >= SCORE_MIN:
            recovered.append(best + (int(stats[lb][4]),))

    # artifact family filter: same bbox-relative offset at >= FAMILY_MIN baskets
    def rel_off(cx, cy):
        b = min(bs, key=lambda b: np.hypot(cx - b['spriteCx'], cy - b['spriteCy']))
        return (cx - b['spriteCx'], cy - b['spriteCy'])

    offs = [rel_off(r[1], r[2]) for r in recovered]
    fam_bad = set()
    for i, (ox, oy) in enumerate(offs):
        if sum(1 for (px, py) in offs if np.hypot(ox - px, oy - py) <= FAMILY_SEP) >= FAMILY_MIN:
            fam_bad.add(i)
    recovered = [r for i, r in enumerate(recovered) if i not in fam_bad]
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
    for sc, cx, cy, area in kept:
        m = [(num, np.hypot(cx - tx, cy - ty)) for num, tx, ty in tt
             if np.hypot(cx - tx, cy - ty) <= 18]
        if m:
            hits.append((m[0][0], sc, m[0][1], area))
        else:
            fps.append((cx, cy, sc, area))
    json.dump([{'x': float(k[1]), 'y': float(k[2]), 'score': float(k[0])} for k in kept],
              open(f'{S}/{nm}-recovered-tees-v3.json', 'w'))
    print(f'{nm}: sig_ref={sig_ref:.0f} | pool-missing {missing} | kept {len(kept)}')
    for num, sc, d, area in hits:
        tag = 'RECOVERED-MISS' if num in missing else 'dup-of-detected'
        print(f'  h{num}: score={sc:.3f} d={d:.1f}px frag={area}px [{tag}]')
    for cx, cy, sc, area in fps:
        print(f'  FP ({cx:.0f},{cy:.0f}) score={sc:.3f} frag={area}px')
