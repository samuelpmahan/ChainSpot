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

All stage-2 knobs are exposed as `Stage2Params` (see below), including the
NCC GATE THRESHOLD that separates confident (auto-suggest) recoveries from
rejected ones -- see grayt-tuning-report.md for the cross-validated search.
CLI defaults are unchanged from the original hardcoded constants.
"""
import argparse
import dataclasses
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

TOLERANCE_PX = 12.691304347826087


@dataclasses.dataclass(frozen=True)
class Stage2Params:
    major_sizes: tuple = (24.0, 28.0, 32.0, 36.0)
    aspect: float = 1.45
    rim_fraction: float = 0.11
    gray_bg: float = 120.0
    gray_rim: float = 235.0
    gray_interior: float = 158.0
    margin: int = 2
    search_min_px: float = 20.0     # start just past the badge body
    search_max_px: float = 400.0
    along_step_px: float = 2.0
    bearing_refine_degs: tuple = (-4.0, -2.0, 0.0, 2.0, 4.0)
    lateral_offsets_px: tuple = (-3.0, 0.0, 3.0)
    gate_threshold: float = 0.55    # NCC gate: >= this is a confident auto-suggest

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["major_sizes"] = list(d["major_sizes"])
        d["bearing_refine_degs"] = list(d["bearing_refine_degs"])
        d["lateral_offsets_px"] = list(d["lateral_offsets_px"])
        return d


DEFAULT_STAGE2 = Stage2Params()


def synth_template(major, angle_rad, params: Stage2Params = DEFAULT_STAGE2):
    minor = major / params.aspect
    rim = max(1.0, params.rim_fraction * major)
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    ex = int(math.ceil(abs(major / 2 * c) + abs(minor / 2 * s))) + params.margin
    ey = int(math.ceil(abs(major / 2 * s) + abs(minor / 2 * c))) + params.margin
    ys, xs = np.mgrid[-ey:ey + 1, -ex:ex + 1]
    lx = xs * c + ys * s
    ly = -xs * s + ys * c
    outer = (np.abs(lx) <= major / 2) & (np.abs(ly) <= minor / 2)
    inner = (np.abs(lx) <= major / 2 - rim) & (np.abs(ly) <= minor / 2 - rim)
    t = np.full(outer.shape, params.gray_bg)
    t[outer] = params.gray_rim
    t[inner] = params.gray_interior
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


def fuse_hole(bx, by, bearing_deg, gray, params: Stage2Params = DEFAULT_STAGE2):
    """Slide the pad-template bank along the ray from (bx,by) at bearing_deg
    (+/- refinement), return the best-scoring candidate as a dict."""
    base_bearing = math.radians(bearing_deg)
    best = None
    for dbear in params.bearing_refine_degs:
        ang = base_bearing + math.radians(dbear)
        dx, dy = math.cos(ang), math.sin(ang)
        px, py = -dy, dx  # perpendicular
        templates = [synth_template(m, ang, params) for m in params.major_sizes]
        d = params.search_min_px
        while d <= params.search_max_px:
            for lat in params.lateral_offsets_px:
                cx = bx + dx * d + px * lat
                cy = by + dy * d + py * lat
                for (tc, energy, ex, ey), m in zip(templates, params.major_sizes):
                    score = ncc_at(gray, tc, energy, ex, ey, cx, cy)
                    if score is not None and (best is None or score > best[0]):
                        best = (score, cx, cy, m, dbear, d)
            d += params.along_step_px
    if best is None:
        return None
    score, cx, cy, major, dbear, dist = best
    return dict(ncc=round(score, 3), recovered=(round(cx, 1), round(cy, 1)), major=major,
                bearingAdjDeg=dbear, alongPx=round(dist, 1))


def fuse_course(rows, gray, params: Stage2Params = DEFAULT_STAGE2):
    """rows: stage-1 per-hole dicts (badgePx, bearingDeg, hole, optionally
    truthTeePx/distErrPx). Returns fused per-hole rows with ncc/recovered/
    gatePass, plus distErrPx when truth is available."""
    out_rows = []
    for h in rows:
        bx, by = h['badgePx']
        best = fuse_hole(bx, by, h['bearingDeg'], gray, params)
        row = dict(hole=h['hole'])
        if best is None:
            row['error'] = None
            out_rows.append(row)
            continue
        row.update(best)
        row['gatePass'] = best['ncc'] >= params.gate_threshold
        row['rayErrWasPx'] = h.get('distErrPx')
        if 'truthTeePx' in h:
            tx, ty = h['truthTeePx']
            cx, cy = best['recovered']
            row['distErrPx'] = round(math.hypot(cx - tx, cy - ty), 1)
        out_rows.append(row)
    return out_rows


def add_stage2_cli_args(ap: argparse.ArgumentParser) -> None:
    d = DEFAULT_STAGE2
    ap.add_argument("--major-sizes", type=str, default=",".join(str(x) for x in d.major_sizes),
                     help="comma-separated template major-axis sizes (px)")
    ap.add_argument("--aspect", type=float, default=d.aspect)
    ap.add_argument("--rim-fraction", type=float, default=d.rim_fraction)
    ap.add_argument("--gray-bg", type=float, default=d.gray_bg)
    ap.add_argument("--gray-rim", type=float, default=d.gray_rim)
    ap.add_argument("--gray-interior", type=float, default=d.gray_interior)
    ap.add_argument("--search-min-px", type=float, default=d.search_min_px)
    ap.add_argument("--search-max-px", type=float, default=d.search_max_px)
    ap.add_argument("--along-step-px", type=float, default=d.along_step_px)
    ap.add_argument("--bearing-refine-deg", type=float, default=4.0,
                     help="+/- bearing refinement width (deg)")
    ap.add_argument("--bearing-refine-step-deg", type=float, default=2.0)
    ap.add_argument("--lateral-offset-px", type=float, default=3.0,
                     help="+/- lateral offset width (px)")
    ap.add_argument("--lateral-step-px", type=float, default=3.0)
    ap.add_argument("--gate-threshold", type=float, default=d.gate_threshold)


def stage2_params_from_args(args) -> Stage2Params:
    major_sizes = tuple(float(x) for x in args.major_sizes.split(","))
    if args.bearing_refine_deg <= 0:
        bearing_refine_degs = (0.0,)
    else:
        n = max(1, int(round(args.bearing_refine_deg / args.bearing_refine_step_deg)))
        bearing_refine_degs = tuple(
            -args.bearing_refine_deg + i * args.bearing_refine_step_deg for i in range(2 * n + 1))
    if args.lateral_offset_px <= 0:
        lateral_offsets_px = (0.0,)
    else:
        n = max(1, int(round(args.lateral_offset_px / args.lateral_step_px)))
        lateral_offsets_px = tuple(
            -args.lateral_offset_px + i * args.lateral_step_px for i in range(2 * n + 1))
    return Stage2Params(
        major_sizes=major_sizes, aspect=args.aspect, rim_fraction=args.rim_fraction,
        gray_bg=args.gray_bg, gray_rim=args.gray_rim, gray_interior=args.gray_interior,
        search_min_px=args.search_min_px, search_max_px=args.search_max_px,
        along_step_px=args.along_step_px, bearing_refine_degs=bearing_refine_degs,
        lateral_offsets_px=lateral_offsets_px, gate_threshold=args.gate_threshold,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_path", nargs="?",
                     default=f"{REPO}/scripts/cv-probes/hole-path-results/ray-template-fusion.json")
    ap.add_argument("--results", default=RESULTS,
                     help="path to a tee-recovery-summary.json (stage-1 output)")
    add_stage2_cli_args(ap)
    args = ap.parse_args()
    params = stage2_params_from_args(args)

    summary = json.load(open(args.results))
    out = {}
    for course, run in summary.items():
        if run.get('tag'):
            continue  # skip jitter runs
        truth, gray = load_fixture(FIXTURES[course])
        t0 = time.time()
        # attach truth tee to each stage-1 row so fuse_course can grade
        rows = []
        for h in run['holes']:
            h = dict(h)
            h['truthTeePx'] = (truth[h['hole']]['tee']['xPx'], truth[h['hole']]['tee']['yPx'])
            rows.append(h)
        fused = fuse_course(rows, gray, params)
        w13 = sum(1 for r in fused if r.get('distErrPx') is not None and r['distErrPx'] <= TOLERANCE_PX)
        w25 = sum(1 for r in fused if r.get('distErrPx') is not None and r['distErrPx'] <= 25.0)
        out[course] = {
            'within13': w13, 'within25': w25, 'n': len(fused),
            'wallClockS': round(time.time() - t0, 2), 'holes': fused,
            'params': params.to_dict(),
        }
        print(f"{course}: within13={w13}/{len(fused)} within25={w25}/{len(fused)} "
              f"wall={out[course]['wallClockS']}s")
        for r in fused:
            if r.get('distErrPx') is None:
                print(f"  h{r['hole']:>2}: no valid window")
                continue
            flag = ' ***' if r['distErrPx'] > 25 else ''
            print(f"  h{r['hole']:>2}: err {r['distErrPx']:>6.1f}px (ray-only was {r['rayErrWasPx']:>6.1f}) "
                  f"ncc {r['ncc']:.2f} major {r['major']:.0f} along {r['alongPx']:>5.0f}px{flag}")
    json.dump(out, open(args.out_path, 'w'), indent=1)


if __name__ == '__main__':
    main()
