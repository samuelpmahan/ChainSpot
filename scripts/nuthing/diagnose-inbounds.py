#!/usr/bin/env python3
"""Gated diagnosis of the 7 in-bounds violations (65/72 baseline).

Pre-registered mechanisms (see conversation, frozen before measurement):
  M1 false ridge   : route span support >= truth support, non-paint RGB on span
  M2 starved truth : truth segment has sub-tau dips at an occluder
  M3 length shortcut: supports comparable, truth longer
  M4 adjacent corridor: span within W/2 of another hole's polyline
  M5 truth wrong   : escalated bar; route on paint, truth off paint

Frames: field cells *3 -> source px (viewport-cropped); +viewport.top ->
full-capture px. Registered truth is already full-capture. Field values are
raw f32 support in [0,1], sampled point-wise (no normalization).
"""
import json, math, struct
import numpy as np
from PIL import Image

CACHE = '/workspace/nuthing-work/pair-matrix-v5'
IMG = {'DashsTrack-full': '/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg',
       'HeritagePark-full': '/workspace/chainspot-corpus/dev/Heritage/HeritagePark-full.png',
       'Lenard-full': '/workspace/chainspot-corpus/dev/Lenard/Lenard-full.PNG',
       'TowneLake-full': '/workspace/chainspot-corpus/dev/TowneLake/TowneLake-full.png'}
W = {'DashsTrack-full': 40, 'HeritagePark-full': 30, 'Lenard-full': 37, 'TowneLake-full': 37}
TAU = 0.30  # SUPPORT_TAU
REG = json.load(open('/home/user/ChainSpot/resources/nuthing-p2/registered-annotations.json'))

def truth_holes(nm):
    if nm in REG:
        return {h['number']: {'tee': h['tee'], 'basket': h['basket'], 'bends': h.get('corridorBends', [])}
                for h in REG[nm]['registeredHoles']}
    t = json.load(open('/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'))
    return {h['number']: {'tee': [h['tee']['xPx'], h['tee']['yPx']],
                          'basket': [h['basket']['xPx'], h['basket']['yPx']],
                          'bends': [[b['xPx'], b['yPx']] for b in h.get('corridorBends', [])]}
            for h in t['holes']}

def load_field(nm, cache):
    w, h = cache['field']['width'], cache['field']['height']
    buf = open(f'{CACHE}/{nm}-field.bin', 'rb').read()
    # try raw w*h f32; some dumps carry a small header
    n = w * h
    off = len(buf) - n * 4
    assert off in (0, 8, 16), (len(buf), n * 4)
    return np.frombuffer(buf, dtype=np.float32, offset=off).reshape(h, w)

def routed(cache, badge, teeId, basketId):
    legs = {l['endpointId']: l for l in badge['legs']}
    def pts(l):
        p = l['path']; return [(p[i], p[i + 1]) for i in range(0, len(p), 2)]
    return list(reversed(pts(legs[teeId]))) + pts(legs[basketId])[1:]

def pt_seg(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy or 1e-9
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy), (qx, qy)

def poly_dist(p, poly):
    return min(pt_seg(p, poly[i], poly[i + 1])[0] for i in range(len(poly) - 1))

def densify(poly, step=2.0):
    out = []
    for i in range(len(poly) - 1):
        a, b = poly[i], poly[i + 1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(L / step))
        for k in range(n):
            t = k / n
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    out.append(tuple(poly[-1]))
    return out

def sample_field(field, pts_full, vtop, scale=3.0):
    vals = []
    for x, y in pts_full:
        fx, fy = x / scale, (y - vtop) / scale
        ix, iy = int(round(fx)), int(round(fy))
        if 0 <= iy < field.shape[0] and 0 <= ix < field.shape[1]:
            vals.append(float(field[iy, ix]))
    return np.array(vals)

def sample_rgb(im, pts):
    vals = []
    h, w, _ = im.shape
    for x, y in pts:
        ix, iy = int(round(x)), int(round(y))
        if 0 <= iy < h and 0 <= ix < w:
            vals.append(im[iy, ix])
    return np.array(vals)

def arclen(pts):
    return sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]) for i in range(len(pts)-1))

CASES = [('DashsTrack-full', 14, 'VIOL'), ('DashsTrack-full', 6, 'VIOL'),
         ('HeritagePark-full', 7, 'VIOL'), ('HeritagePark-full', 14, 'VIOL'),
         ('Lenard-full', 14, 'VIOL'), ('TowneLake-full', 11, 'VIOL'), ('TowneLake-full', 16, 'VIOL'),
         # controls: passing holes WITH bends (picked as same-course siblings)
         ('TowneLake-full', 7, 'CTRL'), ('HeritagePark-full', 4, 'CTRL'),
         ('DashsTrack-full', 3, 'CTRL'), ('Lenard-full', 13, 'CTRL')]

loaded = {}
for nm, hole, kind in CASES:
    if nm not in loaded:
        cache = json.load(open(f'{CACHE}/{nm}.json'))
        loaded[nm] = (cache,
                      json.load(open(f'{CACHE}/{nm}-assignments.json')),
                      load_field(nm, cache),
                      np.asarray(Image.open(IMG[nm]).convert('RGB')).astype(int),
                      truth_holes(nm))
    cache, assign, field, im, truths = loaded[nm]
    vtop = cache['viewport']['top']; sc = cache['field']['scale']
    bmap = {b['label']: b for b in cache['badges'] if b['label']}
    t = truths.get(hole)
    if not t:
        print(f'{nm} h{hole}: no truth'); continue
    h = [x for x in assign['holes'] if x['hole'] == hole][0]
    path = [(x * sc, y * sc + vtop) for x, y in routed(cache, bmap[str(hole)], h['teeId'], h['basketId'])]
    poly = [tuple(t['tee'])] + [tuple(b) for b in t['bends']] + [tuple(t['basket'])]
    bound = W[nm] / 2 + 8

    devs = [poly_dist(p, poly) for p in path]
    mx = max(devs); imax = devs.index(mx)
    # deviating span: contiguous run around imax where dev > W/2 (softer than bound to capture span)
    lo = imax
    while lo > 0 and devs[lo - 1] > W[nm] / 2: lo -= 1
    hi = imax
    while hi < len(devs) - 1 and devs[hi + 1] > W[nm] / 2: hi += 1
    span = path[lo:hi + 1]
    if len(span) < 2:
        span = path[max(0, imax - 3):imax + 4]

    # bypassed truth segment: project span endpoints onto truth polyline arc
    dense_truth = densify(poly)
    def nearest_idx(p):
        return min(range(len(dense_truth)), key=lambda i: (dense_truth[i][0]-p[0])**2 + (dense_truth[i][1]-p[1])**2)
    ia, ib = nearest_idx(span[0]), nearest_idx(span[-1])
    if ia > ib: ia, ib = ib, ia
    bypass = dense_truth[ia:ib + 1]
    if len(bypass) < 2: bypass = dense_truth[max(0, ia - 2):ia + 3]

    s_route = sample_field(field, densify(span), vtop)
    s_truth = sample_field(field, bypass, vtop)
    rgb_route = sample_rgb(im, densify(span))
    rgb_truth = sample_rgb(im, bypass)

    # M4: distance of span midpoint region to OTHER holes' polylines
    others = []
    for on, ot in truths.items():
        if on == hole: continue
        opoly = [tuple(ot['tee'])] + [tuple(b) for b in ot['bends']] + [tuple(ot['basket'])]
        d = min(poly_dist(p, opoly) for p in span[::max(1, len(span)//8)])
        others.append((d, on))
    others.sort()

    # M2: badge proximity to truth low-support points
    weak = [bypass[i] for i, v in enumerate(s_truth) if v < TAU] if len(s_truth) else []
    badge_near_weak = None
    if weak:
        for b in cache['badges']:
            bx, by = b['cx'], b['cy'] + vtop
            d = min(math.hypot(px - bx, py - by) for px, py in weak)
            if badge_near_weak is None or d < badge_near_weak[0]:
                badge_near_weak = (d, b['label'])

    def rgbstat(a):
        if not len(a): return '-'
        v = a.mean(axis=0)
        return f'({v[0]:.0f},{v[1]:.0f},{v[2]:.0f})'

    print(f'\n[{kind}] {nm} h{hole}: maxDev={mx:.1f}px (bound {bound:.0f}) span={arclen(span):.0f}px'
          f' | truth bypass={arclen(bypass):.0f}px')
    print(f'  support route-span: mean={s_route.mean():.2f} min={s_route.min():.2f} p10={np.percentile(s_route,10):.2f}'
          f' | truth-span: mean={s_truth.mean():.2f} min={s_truth.min():.2f} p10={np.percentile(s_truth,10):.2f}'
          f' subTau={int((s_truth<TAU).sum())}/{len(s_truth)}')
    print(f'  RGB route-span mean={rgbstat(rgb_route)} truth-span mean={rgbstat(rgb_truth)}')
    print(f'  nearest other-hole corridor to span: {others[0][0]:.0f}px (h{others[0][1]})'
          + (f' | badge nearest truth-weak-point: {badge_near_weak[0]:.0f}px (badge {badge_near_weak[1]})' if badge_near_weak else ' | truth has no sub-tau points'))
