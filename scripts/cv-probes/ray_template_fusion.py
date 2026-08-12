#!/usr/bin/env python3
"""Ray + pad-template fusion: 1D tee localization along the middle-out ray.

Consumes the ray bearings recovered by hole_path_tee_recovery.py (badge-anchored,
free-tee-end ribbon search) and replaces its evidence-terminus distance rule with
a world-size pad template NCC swept ALONG the ray. The ribbon ray solves the
search space (direction from the badge); the hollow-pad template solves
localization (it peaks at the pad rim, not at generic bright terrain the
terminus rule walks into).

Template model matches src/lib/autoAnnotation/teePadOrientation.ts after the
world-scale fix: major sizes {24,28,32,36}px, aspect 1.45, rim 0.11*major,
levels bg=120 rim=235 interior=158. Pad major axis lies along the ray.
"""
import json
import math
import sys
import time
import zipfile
from io import BytesIO

import numpy as np
from PIL import Image

REPO = '/home/user/ChainSpot'
RESULTS = f'{REPO}/scripts/cv-probes/hole-path-results/tee-recovery-summary.json'
FIXTURES = {
    'GoldenTeeSet': f'{REPO}/resources/GoldenTeeSet.chainspot.zip',
    'AlexClarkSet': f'{REPO}/resources/AlexClarkSet.chainspot.zip',
}

MAJOR_SIZES = (24.0, 28.0, 32.0, 36.0)
ASPECT = 1.45
RIM_FRACTION = 0.11
MARGIN = 2
SEARCH_MIN_PX = 20.0     # start just past the badge body
SEARCH_MAX_PX = 400.0
ALONG_STEP_PX = 2.0
BEARING_SWEEP_DEG = (-4.0, -2.0, 0.0, 2.0, 4.0)
LATERAL_OFFSETS_PX = (-3.0, 0.0, 3.0)


def synth_template(major, angle_rad):
    minor = major / ASPECT
    rim = max(1.0, RIM_FRACTION * major)
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    ex = int(math.ceil(abs(major / 2 * c) + abs(minor / 2 * s))) + MARGIN
    ey = int(math.ceil(abs(major / 2 * s) + abs(minor / 2 * c))) + MARGIN
    ys, xs = np.mgrid[-ey:ey + 1, -ex:ex + 1]
    lx = xs * c + ys * s
    ly = -xs * s + ys * c
    outer = (np.abs(lx) <= major / 2) & (np.abs(ly) <= minor / 2)
    inner = (np.abs(lx) <= major / 2 - rim) & (np.abs(ly) <= minor / 2 - rim)
    t = np.full(outer.shape, 120.0)
    t[outer] = 235.0
    t[inner] = 158.0
    tc = t - t.mean()
    energy = float((tc * tc).sum())
    return tc, energy, ex, ey


def ncc_at(gray, tc, energy, ex, ey, cx, cy):
    x0, y0 = int(round(cx)) - ex, int(round(cy)) - ey
    h, w = tc.shape
    if x0 < 0 or y0 < 0 or x0 + w > gray.shape[1] or y0 + h > gray.shape[0]:
        return None
    patch = gray[y0:y0 + h, x0:x0 + w].astype(np.float64)
    pc = patch - patch.mean()
    pe = float((pc * pc).sum())
    if pe <= 1e-9 or energy <= 1e-9:
        return None
    return float((pc * tc).sum() / math.sqrt(pe * energy))


def load_fixture(zip_path):
    z = zipfile.ZipFile(zip_path)
    truth = {h['number']: h for h in json.load(z.open('project.json'))['holes']}
    img_name = next(n for n in z.namelist() if n.startswith('images/'))
    img = Image.open(BytesIO(z.read(img_name))).convert('L')
    return truth, np.asarray(img, dtype=np.float64)


def main():
    summary = json.load(open(RESULTS))
    out = {}
    for course, run in summary.items():
        if run.get('tag'):
            continue  # skip jitter runs
        truth, gray = load_fixture(FIXTURES[course])
        t0 = time.time()
        rows = []
        w13 = w25 = 0
        for h in run['holes']:
            bx, by = h['badgePx']
            base_bearing = math.radians(h['bearingDeg'])
            best = None
            for dbear in BEARING_SWEEP_DEG:
                ang = base_bearing + math.radians(dbear)
                dx, dy = math.cos(ang), math.sin(ang)
                px, py = -dy, dx  # perpendicular
                templates = [synth_template(m, ang) for m in MAJOR_SIZES]
                d = SEARCH_MIN_PX
                while d <= SEARCH_MAX_PX:
                    for lat in LATERAL_OFFSETS_PX:
                        cx = bx + dx * d + px * lat
                        cy = by + dy * d + py * lat
                        for (tc, energy, ex, ey), m in zip(templates, MAJOR_SIZES):
                            score = ncc_at(gray, tc, energy, ex, ey, cx, cy)
                            if score is not None and (best is None or score > best[0]):
                                best = (score, cx, cy, m, dbear, d)
                    d += ALONG_STEP_PX
            t = truth[h['hole']]['tee']
            if best is None:
                rows.append({'hole': h['hole'], 'error': None})
                continue
            score, cx, cy, major, dbear, dist = best
            err = math.hypot(cx - t['xPx'], cy - t['yPx'])
            w13 += err <= 13
            w25 += err <= 25
            rows.append({
                'hole': h['hole'], 'ncc': round(score, 3), 'recovered': [round(cx, 1), round(cy, 1)],
                'distErrPx': round(err, 1), 'major': major, 'bearingAdjDeg': dbear,
                'alongPx': round(dist, 1), 'rayErrWasPx': h['distErrPx'],
            })
        out[course] = {
            'within13': w13, 'within25': w25, 'n': len(rows),
            'wallClockS': round(time.time() - t0, 2), 'holes': rows,
        }
        print(f"{course}: within13={w13}/{len(rows)} within25={w25}/{len(rows)} "
              f"wall={out[course]['wallClockS']}s")
        for r in rows:
            if r.get('distErrPx') is None:
                print(f"  h{r['hole']:>2}: no valid window")
                continue
            flag = ' ***' if r['distErrPx'] > 25 else ''
            print(f"  h{r['hole']:>2}: err {r['distErrPx']:>6.1f}px (ray-only was {r['rayErrWasPx']:>6.1f}) "
                  f"ncc {r['ncc']:.2f} major {r['major']:.0f} along {r['alongPx']:>5.0f}px{flag}")
    json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else
                        '/home/user/ChainSpot/scripts/cv-probes/hole-path-results/ray-template-fusion.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
