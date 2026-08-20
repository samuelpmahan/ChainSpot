#!/usr/bin/env python3
"""Human-in-the-loop course truth annotator (see .claude/skills/annotate-course-truth).

Builds a <Course>-full.annotation.json (the DashsTrack schema: course,
imageWidthPx/imageHeightPx, holes[{number, tee{xPx,yPx}, basket{xPx,yPx},
corridorBends[{xPx,yPx}...]}]) through a render-correct-rerender loop:
seed positions from a pipeline assignments file, render an overlay plus
per-hole zoom crops with a labeled grid, collect the human's corrections
("h4 tee +12 -3" style), apply, re-render, converge, validate, commit.

ALL coordinates are FULL-CAPTURE pixels (CX-038: pipeline caches are
viewport-cropped — assignments emit files already add viewport.top back;
anything else must be converted before it enters this file).

Usage:
  manual_annotate.py init   ANNOT --image IMG --course NAME
  manual_annotate.py seed   ANNOT --assignments FILE [--geo-scale S]
  manual_annotate.py set    ANNOT HOLE {tee|basket} X Y
  manual_annotate.py nudge  ANNOT HOLE {tee|basket} DX DY
  manual_annotate.py bend   ANNOT HOLE add X Y | clear
  manual_annotate.py remove ANNOT HOLE
  manual_annotate.py render ANNOT --image IMG --out-dir DIR [--zoom N ...]
  manual_annotate.py validate ANNOT
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

GRID_PX = 50
ZOOM_HALF = 220


def load(path):
    with open(path) as f:
        return json.load(f)


def save(path, annot):
    with open(path, 'w') as f:
        json.dump(annot, f, indent=1)
    print(f'wrote {path} ({len(annot["holes"])} holes)')


def hole_of(annot, number, create=False):
    for hole in annot['holes']:
        if hole['number'] == number:
            return hole
    if not create:
        sys.exit(f'hole {number} not in annotation (use set/seed first)')
    hole = {'number': number, 'tee': None, 'basket': None, 'corridorBends': []}
    annot['holes'].append(hole)
    annot['holes'].sort(key=lambda h: h['number'])
    return hole


def cmd_init(args):
    img = cv2.imread(args.image)
    if img is None:
        sys.exit(f'could not read {args.image}')
    save(args.annot, {
        'course': args.course,
        'imageWidthPx': img.shape[1],
        'imageHeightPx': img.shape[0],
        'holes': [],
    })


def cmd_seed(args):
    annot = load(args.annot)
    assignments = load(args.assignments)
    scale = args.geo_scale
    seeded = 0
    for entry in assignments['holes']:
        hole = hole_of(annot, entry['hole'], create=True)
        for piece in ('tee', 'basket'):
            if hole[piece] is None:  # never clobber a human-set point
                hole[piece] = {
                    'xPx': entry[piece]['xPx'] / scale,
                    'yPx': entry[piece]['yPx'] / scale,
                }
                seeded += 1
    print(f'seeded {seeded} pieces from {args.assignments} (geo-scale {scale})')
    save(args.annot, annot)


def cmd_set(args):
    annot = load(args.annot)
    hole = hole_of(annot, args.hole, create=True)
    hole[args.piece] = {'xPx': args.x, 'yPx': args.y}
    save(args.annot, annot)


def cmd_nudge(args):
    annot = load(args.annot)
    hole = hole_of(annot, args.hole)
    piece = hole[args.piece]
    if piece is None:
        sys.exit(f'hole {args.hole} has no {args.piece} to nudge')
    piece['xPx'] += args.dx
    piece['yPx'] += args.dy
    print(f'h{args.hole} {args.piece} -> ({piece["xPx"]:.0f}, {piece["yPx"]:.0f})')
    save(args.annot, annot)


def cmd_bend(args):
    annot = load(args.annot)
    hole = hole_of(annot, args.hole)
    if args.action == 'clear':
        hole['corridorBends'] = []
    else:
        hole['corridorBends'].append({'xPx': args.x, 'yPx': args.y})
    save(args.annot, annot)


def cmd_remove(args):
    annot = load(args.annot)
    annot['holes'] = [h for h in annot['holes'] if h['number'] != args.hole]
    save(args.annot, annot)


def polyline_points(hole):
    pts = [hole['tee']] + hole.get('corridorBends', []) + [hole['basket']]
    return [(int(round(p['xPx'])), int(round(p['yPx']))) for p in pts if p]


def draw_hole(img, hole, thickness=3):
    pts = polyline_points(hole)
    if hole['tee'] and hole['basket']:
        cv2.polylines(img, [np.array(pts, np.int32)], False, (0, 200, 0), thickness, cv2.LINE_AA)
    if hole['tee']:
        p = pts[0]
        cv2.circle(img, p, 12, (0, 255, 255), 3)
    if hole['basket']:
        p = pts[-1]
        cv2.circle(img, p, 12, (255, 120, 0), 3)
    for bend in hole.get('corridorBends', []):
        cv2.circle(img, (int(bend['xPx']), int(bend['yPx'])), 8, (255, 0, 255), 3)
    if len(pts) >= 2:
        mx, my = (pts[0][0] + pts[-1][0]) // 2, (pts[0][1] + pts[-1][1]) // 2
        label = str(hole['number'])
        cv2.putText(img, label, (mx + 10, my - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 6)
        cv2.putText(img, label, (mx + 10, my - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 2)


def draw_grid(img, x0, y0):
    """Absolute-coordinate grid so corrections can be read straight off the crop."""
    h, w = img.shape[:2]
    for gx in range(((x0 // GRID_PX) + 1) * GRID_PX, x0 + w, GRID_PX):
        cv2.line(img, (gx - x0, 0), (gx - x0, h), (255, 255, 255), 1)
        cv2.putText(img, str(gx), (gx - x0 + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 2)
        cv2.putText(img, str(gx), (gx - x0 + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 0), 1)
    for gy in range(((y0 // GRID_PX) + 1) * GRID_PX, y0 + h, GRID_PX):
        cv2.line(img, (0, gy - y0), (w, gy - y0), (255, 255, 255), 1)
        cv2.putText(img, str(gy), (2, gy - y0 + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 2)
        cv2.putText(img, str(gy), (2, gy - y0 + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 0), 1)


def cmd_render(args):
    annot = load(args.annot)
    img = cv2.imread(args.image)
    if img is None:
        sys.exit(f'could not read {args.image}')
    if (img.shape[1], img.shape[0]) != (annot['imageWidthPx'], annot['imageHeightPx']):
        sys.exit('image dimensions do not match the annotation — wrong image or wrong frame')
    os.makedirs(args.out_dir, exist_ok=True)

    overlay = img.copy()
    for hole in annot['holes']:
        draw_hole(overlay, hole)
    full = os.path.join(args.out_dir, 'overlay.png')
    cv2.imwrite(full, overlay)
    small = cv2.resize(overlay, (overlay.shape[1] * 2 // 5, overlay.shape[0] * 2 // 5),
                       interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(args.out_dir, 'overlay-small.png'), small)
    print(f'wrote {full} (+ overlay-small.png)')

    zooms = args.zoom if args.zoom else [h['number'] for h in annot['holes']]
    for number in zooms:
        hole = hole_of(annot, number)
        pts = polyline_points(hole)
        if not pts:
            continue
        cx = sum(p[0] for p in pts) // len(pts)
        cy = sum(p[1] for p in pts) // len(pts)
        half = max(ZOOM_HALF, max(abs(p[0] - cx) for p in pts) + 60,
                   max(abs(p[1] - cy) for p in pts) + 60)
        x0, y0 = max(0, cx - half), max(0, cy - half)
        x1 = min(img.shape[1], cx + half)
        y1 = min(img.shape[0], cy + half)
        crop = img[y0:y1, x0:x1].copy()
        shifted = {**hole,
                   'tee': hole['tee'] and {'xPx': hole['tee']['xPx'] - x0, 'yPx': hole['tee']['yPx'] - y0},
                   'basket': hole['basket'] and {'xPx': hole['basket']['xPx'] - x0, 'yPx': hole['basket']['yPx'] - y0},
                   'corridorBends': [{'xPx': b['xPx'] - x0, 'yPx': b['yPx'] - y0}
                                     for b in hole.get('corridorBends', [])]}
        draw_hole(crop, shifted, thickness=2)
        draw_grid(crop, x0, y0)
        path = os.path.join(args.out_dir, f'h{number}.png')
        cv2.imwrite(path, crop)
        print(f'wrote {path} (frame origin {x0},{y0}; grid labels are absolute px)')


def cmd_validate(args):
    annot = load(args.annot)
    problems = []
    seen = set()
    for key in ('course', 'imageWidthPx', 'imageHeightPx', 'holes'):
        if key not in annot:
            problems.append(f'missing top-level key {key}')
    for hole in annot.get('holes', []):
        n = hole.get('number')
        if n in seen:
            problems.append(f'duplicate hole number {n}')
        seen.add(n)
        for piece in ('tee', 'basket'):
            p = hole.get(piece)
            if p is None:
                problems.append(f'h{n}: missing {piece}')
                continue
            if not (0 <= p['xPx'] <= annot['imageWidthPx'] and 0 <= p['yPx'] <= annot['imageHeightPx']):
                problems.append(f'h{n}: {piece} out of bounds ({p["xPx"]:.0f},{p["yPx"]:.0f})')
        for i, bend in enumerate(hole.get('corridorBends', [])):
            if not (0 <= bend['xPx'] <= annot['imageWidthPx'] and 0 <= bend['yPx'] <= annot['imageHeightPx']):
                problems.append(f'h{n}: bend {i} out of bounds')
    if problems:
        print('INVALID:')
        for p in problems:
            print(f'  {p}')
        sys.exit(1)
    print(f'valid: {len(annot["holes"])} holes, all pieces present and in bounds')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('init');     p.add_argument('annot'); p.add_argument('--image', required=True); p.add_argument('--course', required=True); p.set_defaults(fn=cmd_init)
    p = sub.add_parser('seed');     p.add_argument('annot'); p.add_argument('--assignments', required=True); p.add_argument('--geo-scale', type=float, default=1.0); p.set_defaults(fn=cmd_seed)
    p = sub.add_parser('set');      p.add_argument('annot'); p.add_argument('hole', type=int); p.add_argument('piece', choices=['tee', 'basket']); p.add_argument('x', type=float); p.add_argument('y', type=float); p.set_defaults(fn=cmd_set)
    p = sub.add_parser('nudge');    p.add_argument('annot'); p.add_argument('hole', type=int); p.add_argument('piece', choices=['tee', 'basket']); p.add_argument('dx', type=float); p.add_argument('dy', type=float); p.set_defaults(fn=cmd_nudge)
    p = sub.add_parser('bend');     p.add_argument('annot'); p.add_argument('hole', type=int); p.add_argument('action', choices=['add', 'clear']); p.add_argument('x', type=float, nargs='?'); p.add_argument('y', type=float, nargs='?'); p.set_defaults(fn=cmd_bend)
    p = sub.add_parser('remove');   p.add_argument('annot'); p.add_argument('hole', type=int); p.set_defaults(fn=cmd_remove)
    p = sub.add_parser('render');   p.add_argument('annot'); p.add_argument('--image', required=True); p.add_argument('--out-dir', required=True); p.add_argument('--zoom', type=int, action='append'); p.set_defaults(fn=cmd_render)
    p = sub.add_parser('validate'); p.add_argument('annot'); p.set_defaults(fn=cmd_validate)

    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
