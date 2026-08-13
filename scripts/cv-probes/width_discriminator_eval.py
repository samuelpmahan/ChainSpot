#!/usr/bin/env python3
"""Standalone eval: does folding perpendicular-width dropout rate into the
bearing-sweep ranking (Stage1Params.use_width_discriminator=True) improve on
the CURRENT default `recover_tee` ranking (farthest point-evidence terminus,
tie-broken by mean evidence)?

Reuses `run_stage1` unmodified -- it already returns per-hole bearingDeg /
bearingErrDeg / distErrPx / runtimeMs when truth is supplied, so this script
just runs it twice per course (default params vs. width-discriminator
params) and diffs the results. No new fitting logic here; this is a report,
not a reimplementation.

Usage:
  python3 scripts/cv-probes/width_discriminator_eval.py
"""

from __future__ import annotations

import dataclasses
import math
import time

import hole_path_tee_recovery as s1

DEFAULT = s1.DEFAULT_STAGE1
WIDTH = dataclasses.replace(DEFAULT, use_width_discriminator=True)


def run(course_name, params):
    cfg = s1.COURSES[course_name]
    full = s1.load_source_image(cfg["zip_path"], cfg["image_name"])
    truth_by_n = {n: (tx, ty) for n, tx, ty, bx, by in cfg["truth"]}
    baskets_by_n = {n: (bx, by) for n, tx, ty, bx, by in cfg["truth"]}
    t0 = time.time()
    rows = s1.run_stage1(full, cfg["badges"], baskets_by_n, truth_by_n, params)
    elapsed = time.time() - t0
    return rows, elapsed


def summarize(rows):
    dist = [r["distErrPx"] for r in rows]
    bearing = [r["bearingErrDeg"] for r in rows]
    within13 = sum(1 for r in rows if r["distErrPx"] <= s1.TOLERANCE_PX)
    within25 = sum(1 for r in rows if r["distErrPx"] <= 25.0)
    hit_dist = [r["distErrPx"] for r in rows if r["distErrPx"] <= s1.TOLERANCE_PX]
    return dict(
        meanBearingErr=sum(bearing) / len(bearing), maxBearingErr=max(bearing),
        meanDistErr=sum(dist) / len(dist), maxDistErr=max(dist),
        within13=within13, within25=within25, n=len(rows),
        meanHitDist=(sum(hit_dist) / len(hit_dist)) if hit_dist else float("nan"),
        maxHitDist=max(hit_dist) if hit_dist else float("nan"),
    )


def main():
    for course_name in s1.COURSES:
        rows_default, t_default = run(course_name, DEFAULT)
        rows_width, t_width = run(course_name, WIDTH)

        print(f"\n=== {course_name} ===")
        print(f"{'hole':>4}  {'bearingErr(default)':>20}  {'bearingErr(width)':>18}  "
              f"{'dist(default)':>14}  {'dist(width)':>12}")
        by_hole_width = {r["hole"]: r for r in rows_width}
        for r in sorted(rows_default, key=lambda r: r["hole"]):
            rw = by_hole_width[r["hole"]]
            print(f"{r['hole']:4d}  {r['bearingErrDeg']:20.1f}  {rw['bearingErrDeg']:18.1f}  "
                  f"{r['distErrPx']:14.1f}  {rw['distErrPx']:12.1f}")

        s_default = summarize(rows_default)
        s_width = summarize(rows_width)
        print(f"\n-- {course_name} summary --")
        print(f"  default:            meanBearingErr={s_default['meanBearingErr']:.1f}deg  "
              f"maxBearingErr={s_default['maxBearingErr']:.1f}deg  "
              f"within13={s_default['within13']}/{s_default['n']}  within25={s_default['within25']}/{s_default['n']}  "
              f"meanHitDist={s_default['meanHitDist']:.1f}px  maxHitDist={s_default['maxHitDist']:.1f}px  "
              f"{t_default / s_default['n'] * 1000:.1f}ms/hole")
        print(f"  width-discriminator: meanBearingErr={s_width['meanBearingErr']:.1f}deg  "
              f"maxBearingErr={s_width['maxBearingErr']:.1f}deg  "
              f"within13={s_width['within13']}/{s_width['n']}  within25={s_width['within25']}/{s_width['n']}  "
              f"meanHitDist={s_width['meanHitDist']:.1f}px  maxHitDist={s_width['maxHitDist']:.1f}px  "
              f"{t_width / s_width['n'] * 1000:.1f}ms/hole")


if __name__ == "__main__":
    main()
