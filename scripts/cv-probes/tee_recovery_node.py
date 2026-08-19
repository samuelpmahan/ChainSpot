#!/usr/bin/env python3
"""Replay node for occluded-tee recovery: freeze the expensive evidence
stage (sprite instance stacking, alpha inversion, reconstruction,
uniqueness filtering, occluder assembly) as immutable per-course snapshots
so every downstream refinement — score-family tweaks, placement
diagnostics, plateau analyses — re-scores from cache in milliseconds.

Snapshot layout (NODE_DIR/<course>/):
  ev.png         combined evidence bitmask (raw bright + unique recon bright)
  occ_broad.png  generous sprite mask + badge boxes (excusal-if-unsupported)
  occ_core.png   opaque sprite core + badge boxes (evidence unreadable)
  occ_gate.png   rect sprite bboxes + badge boxes (search gating)
  alpha.npy      42x66 per-pixel sprite opacity estimate
  alphaS.npy     42x66x3 premultiplied sprite color (for reconstruction/display)
  meta.json      sig_ref, otsu_t, params, basket bbox origins

Run:  python3 scripts/cv-probes/tee_recovery_node.py   (rebuilds all courses)
Load: from tee_recovery_node import load_node
"""
import json
import os
import numpy as np
import cv2

S = '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad'
CACHE = '/workspace/nuthing-work/pair-matrix-patched'
NODE_DIR = '/workspace/nuthing-work/tee-recovery-node'
COURSES = ['HeritagePark-full', 'DashsTrack-full', 'Lenard-full', 'TowneLake-full']
A_CUT = 0.75
RECON_V = 195
UNIQ_MAX = 2


def build_course(nm):
    cache = json.load(open(f'{CACHE}/{nm}.json'))
    imgf = cv2.imread(f'{S}/{nm}-cropped.png').astype(float)
    img = imgf.astype(np.uint8)
    H, W = imgf.shape[:2]
    hsv = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), cv2.COLOR_RGB2HSV)
    bright = ((hsv[:, :, 2] >= 210) & (hsv[:, :, 1] <= 45)).astype(np.uint8)
    bs = cache['endpoints']['baskets']
    crops, idxs = [], []
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

    occ_gate = np.zeros_like(bright)
    occ_broad = np.zeros_like(bright)
    occ_core = np.zeros_like(bright)
    ev = bright.copy()
    origins = []
    for k, i in enumerate(idxs):
        b = bs[i]
        x0 = int(round(b['spriteCx'] - 21))
        y0 = int(round(b['spriteCy'] - 33))
        origins.append({'id': b['id'], 'x0': x0, 'y0': y0})
        xs, ys = max(0, x0), max(0, y0)
        xe, ye = min(W, x0 + 42), min(H, y0 + 66)
        occ_gate[ys:ye, xs:xe] = 1
        occ_broad[ys:ye, xs:xe] |= broad[ys - y0:ye - y0, xs - x0:xe - x0]
        occ_core[ys:ye, xs:xe] |= core[ys - y0:ye - y0, xs - x0:xe - x0]
        ev[ys:ye, xs:xe] |= (br_all[k] & uniq_ok)[ys - y0:ye - y0, xs - x0:xe - x0]
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

    d = f'{NODE_DIR}/{nm}'
    os.makedirs(d, exist_ok=True)
    for name, arr in [('ev', ev), ('occ_broad', occ_broad),
                      ('occ_core', occ_core), ('occ_gate', occ_gate)]:
        cv2.imwrite(f'{d}/{name}.png', arr * 255)
    np.save(f'{d}/alpha.npy', alpha)
    np.save(f'{d}/alphaS.npy', alphaS)
    json.dump({'sig_ref': sig_ref, 'otsu_t': float(otsu_t),
               'params': {'A_CUT': A_CUT, 'RECON_V': RECON_V, 'UNIQ_MAX': UNIQ_MAX},
               'spriteOrigins': origins}, open(f'{d}/meta.json', 'w'))
    return sig_ref


def load_node(nm):
    """Load a course's frozen evidence. Returns dict with binary masks,
    alpha model, and a ready distance transform of the evidence."""
    d = f'{NODE_DIR}/{nm}'
    out = {name: (cv2.imread(f'{d}/{name}.png', cv2.IMREAD_GRAYSCALE) > 0).astype(np.uint8)
           for name in ['ev', 'occ_broad', 'occ_core', 'occ_gate']}
    out['alpha'] = np.load(f'{d}/alpha.npy')
    out['alphaS'] = np.load(f'{d}/alphaS.npy')
    out['meta'] = json.load(open(f'{d}/meta.json'))
    out['vis'] = (out['ev'] & (1 - out['occ_core'])).astype(np.uint8)
    out['dtb'] = cv2.distanceTransform(1 - out['vis'], cv2.DIST_L2, 3)
    return out


if __name__ == '__main__':
    for nm in COURSES:
        sig = build_course(nm)
        print(f'{nm}: node written (sig_ref={sig:.0f})')
