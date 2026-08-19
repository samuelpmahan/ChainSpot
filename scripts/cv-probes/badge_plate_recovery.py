#!/usr/bin/env python3
"""Badge recovery via the DARK PLATE instead of the white frame.

The badge detector keys on the badge's white frame; when a basket sprite
overlaps the badge (both white), the frame component merges with the
sprite blob and the badge is lost (found in review: Lenard h5/h12,
sprites sitting directly on the badge frames). The render model's fix:
the badge's dark plate (near-black rounded rect, ~48x36, with white digit
glyphs inside) can never merge with anything white.

Detector: dark components (V<80, closed 3x3) sized 34-78 x 24-54, fill
>=0.55, aspect 1.0-2.4, with a white-glyph fraction of 4-40% in the
eroded interior. Identity via the badge invariant: each plate must sit on
exactly one hole's tee->basket ray at fraction 0.10-0.60 within 14px.

Dev result: 18/18 plates on every course, zero false positives; the six
frame-detector misses (Heritage 2/12/13/15, Lenard 5/12) all recovered
with unambiguous ray identities. Badge pool 66/72 -> 72/72.
"""
import json
import numpy as np
import cv2

S = '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad'
CACHE = '/workspace/nuthing-work/pair-matrix-patched'
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))
DASHS = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))
COURSES = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full']


def truth_holes(nm, top):
    if nm == 'DashsTrack-full':
        return [{'num': h['number'], 'tee': (h['tee']['xPx'], h['tee']['yPx'] - top),
                 'basket': (h['basket']['xPx'], h['basket']['yPx'] - top)} for h in DASHS['holes']]
    return [{'num': h['number'], 'tee': (h['tee'][0], h['tee'][1] - top),
             'basket': (h['basket'][0], h['basket'][1] - top)} for h in REG[nm]['registeredHoles']]


def find_plates(img):
    hsv = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), cv2.COLOR_RGB2HSV)
    V = hsv[:, :, 2]
    dark = cv2.morphologyEx((V < 80).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    ncc, lab, st, ce = cv2.connectedComponentsWithStats(dark, connectivity=8)
    out = []
    for l in range(1, ncc):
        x, y, w, h, a = st[l]
        if not (34 <= w <= 78 and 24 <= h <= 54):
            continue
        if a / (w * h) < 0.55 or not (1.0 <= w / h <= 2.4):
            continue
        inner = V[y + 4:y + h - 4, x + 4:x + w - 4]
        if inner.size == 0:
            continue
        gf = float((inner > 190).mean())
        if not (0.04 <= gf <= 0.40):
            continue
        out.append({'cx': float(ce[l][0]), 'cy': float(ce[l][1]), 'w': int(w), 'h': int(h),
                    'glyphFrac': round(gf, 3)})
    return out


if __name__ == '__main__':
    for nm in COURSES:
        cache = json.load(open(f'{CACHE}/{nm}.json'))
        top = cache['viewport']['top']
        img = cv2.imread(f'{S}/{nm}-cropped.png')
        plates = find_plates(img)
        known = [(bd['cx'], bd['cy'], bd['label']) for bd in cache['badges']]
        holes = truth_holes(nm, top)
        news = []
        dups = 0
        for p in plates:
            if any(np.hypot(p['cx'] - kx, p['cy'] - ky) < 22 for kx, ky, _ in known):
                dups += 1
                continue
            hits = []
            for h in holes:
                tx, ty = h['tee']
                bx, by = h['basket']
                L = np.hypot(bx - tx, by - ty)
                ux, uy = (bx - tx) / L, (by - ty) / L
                t = ((p['cx'] - tx) * ux + (p['cy'] - ty) * uy) / L
                perp = abs(-(p['cx'] - tx) * uy + (p['cy'] - ty) * ux)
                if 0.10 <= t <= 0.60 and perp <= 14:
                    hits.append((h['num'], round(t, 2), round(perp, 1)))
            p['rayHits'] = hits
            news.append(p)
        json.dump(news, open(f'{S}/{nm}-recovered-badges.json', 'w'))
        print(f'{nm}: plates {len(plates)} | known matched {dups}/{len(known)} | recovered {len(news)}')
        for p in news:
            print(f"  ({p['cx']:.0f},{p['cy']:.0f}) {p['w']}x{p['h']} glyph {p['glyphFrac']} rays {p['rayHits']}")
