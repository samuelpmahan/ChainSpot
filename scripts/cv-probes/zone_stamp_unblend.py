#!/usr/bin/env python3
"""Zone-stamp un-blend: the ENTIRE basket zone (sprite glyph + C1S/C2D
rings + C1F/C2F fills) is one repeated render stamp, pixel-locked to the
basket anchor. Stacking anchor-centered windows across a course's baskets
and inverting the alpha composite cancels the whole stamp at once —
revealing the ground AND the corridor's terminal cap underneath, in the
zone that has been the worst-measured part of every corridor.

Outputs per course:
  - zone-stamp arrays (alpha, alphaS) cached under the tee-recovery node dir
  - per-basket un-blended LIFT maps (recon gray minus robust local ground)
  - a near-field approach bearing per basket: argmax over theta of mean
    lift in a W-wide band r in [W/2+4, 60] — INSIDE the zone, where the
    backwalk could never look — validated against bend-aware truth.
"""
import json
import os
import numpy as np
import cv2

S = '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad'
import sys
CACHE = sys.argv[1] if len(sys.argv) > 1 else '/workspace/nuthing-work/pair-matrix-patched'
OUT_SUFFIX = sys.argv[2] if len(sys.argv) > 2 else ''
NODE_DIR = '/workspace/nuthing-work/tee-recovery-node'
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
DASHS = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))
COURSES = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full']
CW = {'DashsTrack-full': 40, 'HeritagePark-full': 30, 'Lenard-full': 37, 'TowneLake-full': 37}
R = 110  # window half-size: covers C2D (96) plus margin
A_TRUST = 0.8


def truth_holes(nm, top):
    out = []
    if nm == 'DashsTrack-full':
        for h in DASHS['holes']:
            out.append({'num': h['number'], 'tee': (h['tee']['xPx'], h['tee']['yPx'] - top),
                        'basket': (h['basket']['xPx'], h['basket']['yPx'] - top),
                        'bends': [(b['xPx'], b['yPx'] - top) for b in h.get('corridorBends', [])]})
    else:
        for h in REG[nm]['registeredHoles']:
            out.append({'num': h['number'], 'tee': (h['tee'][0], h['tee'][1] - top),
                        'basket': (h['basket'][0], h['basket'][1] - top),
                        'bends': [(b[0], b[1] - top) for b in h.get('corridorBends', [])]})
    return out


def ang_diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def build_stamp(nm):
    cache = json.load(open(f'{CACHE}/{nm}.json'))
    imgf = cv2.imread(f'{S}/{nm}-cropped.png').astype(float)
    H, W = imgf.shape[:2]
    crops = []
    kept = []
    for b in cache['endpoints']['baskets']:
        x0, y0 = int(round(b['x'] - R)), int(round(b['y'] - R))
        if 0 <= x0 and 0 <= y0 and x0 + 2 * R <= W and y0 + 2 * R <= H:
            crops.append(imgf[y0:y0 + 2 * R, x0:x0 + 2 * R])
            kept.append(b)
    stack = np.stack(crops)
    mean = stack.mean(axis=0)
    # per-pixel MEDIAN abs deviation is more robust than std here: half the
    # instances may have corridor paint at a given offset
    med = np.median(stack, axis=0)
    mad = np.median(np.abs(stack - med), axis=0).mean(axis=2)
    ring = mad[:12, :12].ravel()  # far corner: stamp-free
    sig_ref = float(np.median(np.concatenate([mad[:12, :12].ravel(), mad[:12, -12:].ravel(),
                                              mad[-12:, :12].ravel(), mad[-12:, -12:].ravel()])))
    alpha = np.clip(1.0 - mad / max(sig_ref, 1e-6), 0.0, 1.0)
    mu_g = np.median(np.stack([stack[:, :12, :12], stack[:, :12, -12:],
                               stack[:, -12:, :12], stack[:, -12:, -12:]]).reshape(-1, 3), axis=0)
    alphaS = med - (1 - alpha[..., None]) * mu_g
    d = f'{NODE_DIR}/{nm}'
    os.makedirs(d, exist_ok=True)
    np.save(f'{d}/zone_alpha.npy', alpha)
    np.save(f'{d}/zone_alphaS.npy', alphaS)
    return cache, imgf, kept, alpha, alphaS, sig_ref


def unblend(imgf, b, alpha, alphaS):
    x0, y0 = int(round(b['x'] - R)), int(round(b['y'] - R))
    V = imgf[y0:y0 + 2 * R, x0:x0 + 2 * R]
    den = np.clip(1 - alpha, 0.2, 1.0)[..., None]
    G = np.clip((V - alphaS) / den, 0, 255)
    Gg = G.mean(axis=2)
    trust = alpha < A_TRUST
    # lift vs robust ground: median of trusted pixels in the outer annulus
    yy, xx = np.mgrid[0:2 * R, 0:2 * R]
    rr = np.hypot(xx - R, yy - R)
    ground = np.median(Gg[(rr > 98) & trust])
    lift = Gg - ground
    return lift, trust


def furniture_mask(cache, b):
    """Window-local mask of KNOWN renders that are NOT part of this basket's
    stamp: other baskets' sprites, all badges, all tees. These sit at
    varying offsets so the stamp cannot cancel them — they must be excluded
    from the lift readout or their white dominates the bearing."""
    m = np.zeros((2 * R, 2 * R), dtype=bool)
    x0, y0 = int(round(b['x'] - R)), int(round(b['y'] - R))

    def box(cx, cy, hw, hh):
        xs, xe = int(cx - hw) - x0, int(cx + hw) - x0
        ys, ye = int(cy - hh) - y0, int(cy + hh) - y0
        m[max(0, ys):max(0, ye), max(0, xs):max(0, xe)] = True

    for ob in cache['endpoints']['baskets']:
        if ob['id'] == b['id']:
            continue
        box(ob['spriteCx'], ob['spriteCy'], 24, 36)
    for bd in cache['badges']:
        box(bd['cx'], bd['cy'], 30, 24)
    for t in cache['endpoints']['tees']:
        box(t['x'], t['y'], 18, 18)
    return m


def bearing_from_lift(lift, trust, Wc, furn=None):
    best = (None, -1e9)
    scores = {}
    ok = trust if furn is None else (trust & ~furn)
    for td in range(0, 360, 3):
        th = np.radians(td)
        ux, uy = np.cos(th), np.sin(th)
        nx, ny = -uy, ux
        vals = []
        for r in np.arange(Wc / 2 + 4, 60, 3):
            for o in (-0.3 * Wc, -0.1 * Wc, 0.1 * Wc, 0.3 * Wc):
                px, py = R + ux * r + nx * o, R + uy * r + ny * o
                ix, iy = int(px), int(py)
                if 0 <= ix < 2 * R and 0 <= iy < 2 * R and ok[iy, ix]:
                    vals.append(lift[iy, ix])
        if len(vals) >= 12:
            sc = float(np.mean(vals))
            scores[td] = sc
            if sc > best[1]:
                best = (td, sc)
    return best[0], scores


if __name__ == '__main__':
    pooled_good = pooled_cat = pooled_n = 0
    for nm in COURSES:
        cache, imgf, kept, alpha, alphaS, sig_ref = build_stamp(nm)
        top = cache['viewport']['top']
        holes = truth_holes(nm, top)
        Wc = CW[nm]
        good = cat = n = 0
        rows = []
        for b in kept:
            cand = min(holes, key=lambda h: np.hypot(b['x'] - h['basket'][0], b['y'] - h['basket'][1]))
            if np.hypot(b['x'] - cand['basket'][0], b['y'] - cand['basket'][1]) > 25:
                continue
            prev = cand['bends'][-1] if cand['bends'] else cand['tee']
            tb = float(np.degrees(np.arctan2(prev[1] - b['y'], prev[0] - b['x'])) % 360)
            lift, trust = unblend(imgf, b, alpha, alphaS)
            est, _ = bearing_from_lift(lift, trust, Wc, furniture_mask(cache, b))
            if est is None:
                continue
            e = ang_diff(est, tb)
            n += 1
            if e <= 15:
                good += 1
            if e > 45:
                cat += 1
            rows.append({'id': b['id'], 'hole': cand['num'], 'est': est, 'truth': tb, 'err': e})
        json.dump(rows, open(f'{S}/{nm}-zone-bearings{OUT_SUFFIX}.json', 'w'))
        pooled_good += good
        pooled_cat += cat
        pooled_n += n
        errs = sorted(r['err'] for r in rows)
        print(f'{nm}: sig_ref={sig_ref:.1f} n={n} median {errs[len(errs)//2]:.0f}deg '
              f'good<=15: {good} cat>45: {cat}')
        bad = [r for r in rows if r['err'] > 45]
        if bad:
            print('  cat:', ' '.join(f"h{r['hole']}({r['err']:.0f})" for r in bad))
    print(f'\nPOOLED: n={pooled_n} good {pooled_good} ({pooled_good/pooled_n:.0%}) '
          f'catastrophic {pooled_cat} ({pooled_cat/pooled_n:.0%}) '
          f'[backwalk baseline on same truth: 43/72 good, 22/72 cat]')
