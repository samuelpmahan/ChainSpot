#!/usr/bin/env python3
"""GRayT (ribbon-ray fit + pad-template fusion) leave-one-course-out tuning.

Searches Stage1Params (hole_path_tee_recovery.py) x Stage2Params
(ray_template_fusion.py) x NCC gate threshold, coarse grid, evaluated under
strict leave-one-course-out cross-validation over the labeled ("tunable")
courses found in an input folder (plus the two repo fixtures). Overlay-only
(unlabeled) captures are never used to fit parameters -- the final tuned
chain is simply run on them for human review + two consistency checks.

Objective (strict priority, per course-tuning task spec):
  (a) ZERO false accepts above the gate (gate-passed farther than
      TOLERANCE_PX from truth) -- one disqualifies a parameter set.
  (b) maximize gate-passed recoveries.
  (c) minimize mean error of passes.

Usage:
  python3 scripts/cv-probes/grayt_tune.py \
      --input-dir resources/held-out \
      --out-dir scripts/cv-probes/hole-path-results/tuning \
      --report scripts/cv-probes/grayt-tuning-report.md \
      --best-params scripts/cv-probes/best-params.json
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grayt_common as gc          # noqa: E402
import hole_path_tee_recovery as s1  # noqa: E402
import ray_template_fusion as s2     # noqa: E402

REPO = Path(__file__).resolve().parents[2]
TOLERANCE_PX = s1.TOLERANCE_PX

# ---------------------------------------------------------------------------
# Search space. Coarse-to-fine: stage-1 grid on the two knobs the findings
# doc's own prior search flagged as most consequential (evidence threshold,
# closing window); bearing sweep width and everything else held at default
# to keep total runtime sane (still exposed as CLI flags on the probes
# themselves, see Stage1Params/Stage2Params). Stage-2 geometry grid on rim
# fraction only (bearing refine / lateral offsets / major bank held at
# default -- findings already showed clean gate separation with them).
# Gate threshold is swept finely and near-for-free (NCC scores don't depend
# on it) over every stage1 x stage2-geometry combo.
# ---------------------------------------------------------------------------

STAGE1_GRID = dict(
    evidence_thresh=(0.15, 0.20, 0.25),
    closing_window_px=(12.0, 18.0, 24.0),
)
STAGE2_GRID = dict(
    rim_fraction=(0.09, 0.11, 0.13),
)
THRESHOLD_SWEEP = [round(0.25 + 0.01 * i, 2) for i in range(66)]  # 0.25 .. 0.90


def stage1_variants():
    for et, cw in itertools.product(STAGE1_GRID["evidence_thresh"], STAGE1_GRID["closing_window_px"]):
        yield s1.Stage1Params(evidence_thresh=et, closing_window_px=cw)


def stage2_variants():
    for rf in STAGE2_GRID["rim_fraction"]:
        yield s2.Stage2Params(rim_fraction=rf)


# ---------------------------------------------------------------------------
# Per-course data prep (image, badges, baskets, truth) -- badges/baskets
# always come from the production detector (scripts/detect-course.ts,
# cached), never from truth, mirroring what's available at inference time.
# ---------------------------------------------------------------------------

def prepare_course_data(course: gc.Course, cache_dir: Path) -> dict:
    image = gc.load_course_image(course)
    detection = gc.run_detect_course(course.path, cache_dir)
    badges, det_baskets = gc.badges_and_baskets_from_detection(detection)

    if course.kind == "tunable":
        baskets_by_n = {n: t["basket"] for n, t in course.truth.items() if t["basket"] is not None}
        truth_by_n = {n: t["tee"] for n, t in course.truth.items() if t["tee"] is not None}
        badges = [(n, x, y) for n, x, y in badges if n in baskets_by_n and n in truth_by_n]
    else:
        baskets_by_n = det_baskets
        truth_by_n = {}
        badges = [(n, x, y) for n, x, y in badges if n in baskets_by_n]

    gray = np.asarray(image.convert("L"), dtype=np.float64)
    return dict(course=course, image=image, gray=gray, badges=badges,
                baskets_by_n=baskets_by_n, truth_by_n=truth_by_n,
                nHolesWithBasket=len(badges), nHolesDetected=len(gc.badges_and_baskets_from_detection(detection)[0]))


def run_stage1_for(d: dict, params: s1.Stage1Params):
    return s1.run_stage1(d["image"], d["badges"], d["baskets_by_n"], d["truth_by_n"], params)


def fuse_for(d: dict, stage1_rows, params: s2.Stage2Params):
    return s2.fuse_course(stage1_rows, d["gray"], params)


# ---------------------------------------------------------------------------
# Threshold sweep + objective
# ---------------------------------------------------------------------------

def sweep_threshold(fused_rows, thresholds=THRESHOLD_SWEEP):
    """Best threshold (by objective a>b>c) over rows that carry ground
    truth. Returns dict(threshold, nPass, nFalseAccept, meanErr, maxErr)."""
    graded = [r for r in fused_rows if r.get("ncc") is not None]
    best = None
    for th in thresholds:
        passes = [r for r in graded if r["ncc"] >= th]
        graded_passes = [r for r in passes if r.get("distErrPx") is not None]
        false_accepts = [r for r in graded_passes if r["distErrPx"] > TOLERANCE_PX]
        if false_accepts:
            continue
        n_pass = len(passes)
        errs = [r["distErrPx"] for r in graded_passes]
        mean_err = sum(errs) / len(errs) if errs else 0.0
        key = (n_pass, -mean_err)
        if best is None or key > best[0]:
            best = (key, th, n_pass, errs)
    if best is None:
        return dict(threshold=1.01, nPass=0, nFalseAccept=0, meanErr=None, maxErr=None)
    _, th, n_pass, errs = best
    return dict(threshold=th, nPass=n_pass, nFalseAccept=0,
                meanErr=round(sum(errs) / len(errs), 2) if errs else None,
                maxErr=round(max(errs), 2) if errs else None)


def grid_search(course_data_by_name: dict, train_names: list, log=print):
    results = []
    t0 = time.time()
    for s1p in stage1_variants():
        rows_by_course = {name: run_stage1_for(course_data_by_name[name], s1p) for name in train_names}
        for s2p in stage2_variants():
            fused_all = []
            for name in train_names:
                fused_all.extend(fuse_for(course_data_by_name[name], rows_by_course[name], s2p))
            sweep = sweep_threshold(fused_all)
            results.append(dict(stage1=s1p, stage2=s2p, **sweep))
    results.sort(key=lambda r: (-r["nPass"], r["meanErr"] if r["meanErr"] is not None else 1e9))
    log(f"  grid search over {len(results)} combos, {time.time() - t0:.1f}s, "
        f"trained on {train_names}")
    return results[0], results


def evaluate_on_course(d: dict, stage1_params: s1.Stage1Params, stage2_params: s2.Stage2Params, threshold: float):
    rows = run_stage1_for(d, stage1_params)
    fused = fuse_for(d, rows, stage2_params)
    graded = [r for r in fused if r.get("ncc") is not None]
    passes = [r for r in graded if r["ncc"] >= threshold]
    graded_passes = [r for r in passes if r.get("distErrPx") is not None]
    false_accepts = [r for r in graded_passes if r["distErrPx"] > TOLERANCE_PX]
    errs = [r["distErrPx"] for r in graded_passes]
    return dict(
        nHoles=len(fused), nPass=len(passes), nFalseAccept=len(false_accepts),
        meanErr=round(sum(errs) / len(errs), 2) if errs else None,
        maxErr=round(max(errs), 2) if errs else None,
        stage1Rows=rows, fusedRows=fused,
    )


# ---------------------------------------------------------------------------
# Overlay-only handling
# ---------------------------------------------------------------------------

def consistency_checks(d: dict, stage1_params: s1.Stage1Params, stage2_params: s2.Stage2Params,
                        stage1_rows, fused_rows):
    full = d["image"]
    d_l = s1.lightness_delta(full, stage1_params)
    badge_boxes = [s1.badge_mask_box(*s1.evidence_from_dl(d_l, stage1_params.ray_evidence_dl).shape,
                                      bx, by, stage1_params) for _, bx, by in d["badges"]]
    ray_ev = s1.opened_evidence(s1.evidence_from_dl(d_l, stage1_params.ray_evidence_dl), badge_boxes, stage1_params)
    h, w = ray_ev.shape
    stage1_by_hole = {r["hole"]: r for r in stage1_rows}
    max_bearing_refine = max(abs(x) for x in stage2_params.bearing_refine_degs)

    out = []
    for r in fused_rows:
        if not r.get("gatePass"):
            continue
        cx, cy = r["recovered"]
        xi, yi = int(cx / stage1_params.scale), int(cy / stage1_params.scale)
        ev_val = float(ray_ev[yi, xi]) if 0 <= yi < h and 0 <= xi < w else 0.0
        ribbon_ok = ev_val >= stage1_params.evidence_thresh
        s1row = stage1_by_hole.get(r["hole"], {})
        deg_off = s1row.get("degOffFromCenter", 0.0)
        bearing_adj = r.get("bearingAdjDeg", 0.0)
        badge_aim_ok = (abs(deg_off) < 0.9 * stage1_params.bearing_sweep_deg
                         and abs(bearing_adj) < max_bearing_refine + 1e-9)
        out.append(dict(hole=r["hole"], ribbonEvidence=round(ev_val, 3), ribbonOk=ribbon_ok,
                         degOffFromCenter=deg_off, bearingAdjDeg=bearing_adj, badgeAimOk=badge_aim_ok,
                         anyViolation=not (ribbon_ok and badge_aim_ok)))
    return out


def render_overlay_only(d: dict, fused_rows, out_dir: Path, name: str):
    full = d["image"].copy()
    draw = ImageDraw.Draw(full)
    badges_by_n = {n: (x, y) for n, x, y in d["badges"]}
    fused_by_n = {r["hole"]: r for r in fused_rows}

    # Main overlay: ONLY what the system would actually claim (gate-passed).
    main = full.copy()
    dm = ImageDraw.Draw(main)
    n_pass = 0
    for n, (bx, by) in badges_by_n.items():
        r = fused_by_n.get(n)
        if r is None or not r.get("gatePass"):
            continue
        n_pass += 1
        cx, cy = r["recovered"]
        dm.rectangle([bx - 40, by - 30, bx + 40, by + 30], outline=(0, 200, 255), width=2)
        dm.line([(bx, by), (cx, cy)], fill=(0, 200, 0), width=3)
        dm.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], outline=(0, 220, 0), width=4)
        dm.text((cx + 12, cy - 6), f"{n} ncc={r['ncc']:.2f}", fill=(0, 255, 0))
    main.save(out_dir / f"{name}-overlay.png")

    # Diagnostic overlay: everything, including rejected candidates.
    diag = full.copy()
    dd = ImageDraw.Draw(diag)
    for n, (bx, by) in badges_by_n.items():
        r = fused_by_n.get(n)
        dd.rectangle([bx - 40, by - 30, bx + 40, by + 30], outline=(0, 200, 255), width=2)
        if r is None or r.get("recovered") is None:
            dd.text((bx + 12, by - 6), f"{n} no-window", fill=(255, 0, 255))
            continue
        cx, cy = r["recovered"]
        passed = r.get("gatePass", False)
        color = (0, 220, 0) if passed else (220, 0, 0)
        dd.line([(bx, by), (cx, cy)], fill=color, width=2)
        dd.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], outline=color, width=3)
        tag = "PASS" if passed else "reject"
        dd.text((cx + 10, cy - 6), f"{n} {tag} ncc={r['ncc']:.2f}", fill=color)
    diag.save(out_dir / f"{name}-diagnostic-overlay.png")
    return n_pass, len(badges_by_n)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", default="resources/held-out")
    ap.add_argument("--out-dir", default="scripts/cv-probes/hole-path-results/tuning")
    ap.add_argument("--cache-dir", default="scripts/cv-probes/hole-path-results/tuning/badge-cache")
    ap.add_argument("--report", default="scripts/cv-probes/grayt-tuning-report.md")
    ap.add_argument("--best-params", default="scripts/cv-probes/best-params.json")
    ap.add_argument("--extra-overlay", nargs="*",
                     default=["resources/ThrownRounds/ReferenceStitch.png"],
                     help="explicit overlay-only capture(s) to include if --input-dir has none")
    args = ap.parse_args()

    input_dir = REPO / args.input_dir
    out_dir = REPO / args.out_dir
    cache_dir = REPO / args.cache_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    courses = gc.discover_courses(input_dir, extra_paths=[])
    overlay_found_in_input = any(c.kind == "overlay" for c in courses.values())
    if not overlay_found_in_input:
        for p in args.extra_overlay:
            for name, c in gc.discover_courses(None, extra_paths=[p]).items():
                if c.kind == "overlay":
                    courses[name] = c

    tunable = {n: c for n, c in courses.items() if c.kind == "tunable"}
    overlay = {n: c for n, c in courses.items() if c.kind == "overlay"}

    print(f"Discovered {len(tunable)} tunable course(s): {list(tunable)}")
    print(f"Discovered {len(overlay)} overlay-only course(s): {list(overlay)}")
    if len(tunable) < 4:
        print(f"NOTE: only {len(tunable)} labeled course(s) available -- LOOCV results below are "
              f"indicative, not proof (see hard rule in task spec).")

    print("Preparing course data (loading images, running/loading cached detect-course.ts)...")
    course_data = {}
    for name, c in {**tunable, **overlay}.items():
        t0 = time.time()
        course_data[name] = prepare_course_data(c, cache_dir)
        print(f"  {name} ({c.kind}): {course_data[name]['nHolesWithBasket']}/"
              f"{course_data[name]['nHolesDetected']} holes usable, {time.time() - t0:.1f}s")

    # ------------------------------------------------------------------
    # LOOCV over tunable courses
    # ------------------------------------------------------------------
    tunable_names = list(tunable)
    folds = []
    for held_out in tunable_names:
        train_names = [n for n in tunable_names if n != held_out]
        if not train_names:
            print(f"Skipping fold for {held_out}: no other labeled course to train on.")
            continue
        print(f"\n=== LOOCV fold: train={train_names} test={held_out} ===")
        best, all_results = grid_search(course_data, train_names)
        test_eval = evaluate_on_course(course_data[held_out], best["stage1"], best["stage2"], best["threshold"])
        default_eval = evaluate_on_course(course_data[held_out], s1.DEFAULT_STAGE1, s2.DEFAULT_STAGE2, 0.55)
        print(f"  chosen: evidence_thresh={best['stage1'].evidence_thresh} "
              f"closing_window_px={best['stage1'].closing_window_px} "
              f"rim_fraction={best['stage2'].rim_fraction} gate={best['threshold']}")
        print(f"  train-set objective: nPass={best['nPass']} nFalseAccept={best['nFalseAccept']} "
              f"meanErr={best['meanErr']}")
        print(f"  TEST ({held_out}): nPass={test_eval['nPass']}/{test_eval['nHoles']} "
              f"nFalseAccept={test_eval['nFalseAccept']} meanErr={test_eval['meanErr']} "
              f"maxErr={test_eval['maxErr']}")
        print(f"  TEST ({held_out}) at CURRENT DEFAULTS: nPass={default_eval['nPass']}/{default_eval['nHoles']} "
              f"nFalseAccept={default_eval['nFalseAccept']} meanErr={default_eval['meanErr']}")
        folds.append(dict(heldOut=held_out, trainedOn=train_names, chosenStage1=best["stage1"].to_dict(),
                           chosenStage2=best["stage2"].to_dict(), chosenThreshold=best["threshold"],
                           trainObjective=dict(nPass=best["nPass"], nFalseAccept=best["nFalseAccept"],
                                                meanErr=best["meanErr"]),
                           testEval={k: v for k, v in test_eval.items() if k not in ("stage1Rows", "fusedRows")},
                           testEvalFusedRows=test_eval["fusedRows"],
                           defaultEval={k: v for k, v in default_eval.items() if k not in ("stage1Rows", "fusedRows")}))

    # ------------------------------------------------------------------
    # Final recommended (in-sample) fit using ALL labeled courses combined
    # ------------------------------------------------------------------
    final_best = None
    final_in_sample = {}
    if tunable_names:
        print(f"\n=== Final in-sample fit: train={tunable_names} (NOT cross-validated) ===")
        final_best, _ = grid_search(course_data, tunable_names)
        for name in tunable_names:
            final_in_sample[name] = evaluate_on_course(course_data[name], final_best["stage1"],
                                                         final_best["stage2"], final_best["threshold"])
            print(f"  in-sample {name}: nPass={final_in_sample[name]['nPass']}/{final_in_sample[name]['nHoles']} "
                  f"nFalseAccept={final_in_sample[name]['nFalseAccept']} meanErr={final_in_sample[name]['meanErr']}")

    # ------------------------------------------------------------------
    # Overlay-only courses: run tuned chain, render overlays, consistency checks
    # ------------------------------------------------------------------
    overlay_results = {}
    if final_best is not None:
        for name in overlay:
            d = course_data[name]
            print(f"\n=== Overlay-only: {name} ===")
            rows = run_stage1_for(d, final_best["stage1"])
            fused = fuse_for(d, rows, final_best["stage2"])
            for r in fused:
                r["gatePass"] = r.get("ncc") is not None and r["ncc"] >= final_best["threshold"]
            n_pass, n_total = render_overlay_only(d, fused, out_dir, name)
            checks = consistency_checks(d, final_best["stage1"], final_best["stage2"], rows, fused)
            violations = [c for c in checks if c["anyViolation"]]
            print(f"  gate-passed {n_pass}/{n_total}; consistency violations on "
                  f"{len(violations)}/{len(checks)} gate-passed holes")
            overlay_results[name] = dict(nPass=n_pass, nTotal=n_total, checks=checks,
                                          violations=[c["hole"] for c in violations])

    # ------------------------------------------------------------------
    # Persist raw results + overlays for the tunable courses too (using the
    # final in-sample params, for visual inspection; LOOCV numbers above are
    # the honest generalization estimate, not these overlays).
    # ------------------------------------------------------------------
    if final_best is not None:
        for name in tunable_names:
            d = course_data[name]
            fused = final_in_sample[name]["fusedRows"]
            for r in fused:
                r["gatePass"] = r.get("ncc") is not None and r["ncc"] >= final_best["threshold"]
            full = d["image"].copy()
            draw = ImageDraw.Draw(full)
            badges_by_n = {n: (x, y) for n, x, y in d["badges"]}
            truth = d["course"].truth or {}
            for n, t in truth.items():
                if t.get("tee"):
                    tx, ty = t["tee"]
                    draw.ellipse([tx - 10, ty - 10, tx + 10, ty + 10], outline=(0, 255, 0), width=4)
            for r in fused:
                bx, by = badges_by_n.get(r["hole"], (None, None))
                if bx is None or r.get("recovered") is None:
                    continue
                cx, cy = r["recovered"]
                color = (0, 220, 0) if r["gatePass"] else (220, 0, 0)
                draw.line([(bx, by), (cx, cy)], fill=color, width=2)
                draw.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], outline=color, width=3)
                draw.text((cx + 10, cy - 6), f"{r['hole']} ncc={r['ncc']:.2f}" if r.get('ncc') is not None
                           else f"{r['hole']} none", fill=color)
            full.save(out_dir / f"{name}-tuned-overlay.png")

    # ------------------------------------------------------------------
    # best-params.json
    # ------------------------------------------------------------------
    if final_best is not None:
        best_params_doc = dict(
            note=("Fit in-sample on ALL labeled courses available in this repo snapshot "
                  f"({tunable_names}). See grayt-tuning-report.md for the cross-validated "
                  "(honest generalization) numbers from the leave-one-course-out folds -- "
                  "do not read the in-sample numbers below as generalization evidence."),
            stage1=final_best["stage1"].to_dict(),
            stage2=final_best["stage2"].to_dict(),
            gateThreshold=final_best["threshold"],
            inSampleTrainObjective=dict(nPass=final_best["nPass"], nFalseAccept=final_best["nFalseAccept"],
                                         meanErr=final_best["meanErr"]),
        )
        (REPO / args.best_params).write_text(json.dumps(best_params_doc, indent=2) + "\n")
        print(f"\nWrote {args.best_params}")

    # ------------------------------------------------------------------
    # Dump full raw results for report-writing
    # ------------------------------------------------------------------
    raw = dict(
        tunableCourses=tunable_names, overlayCourses=list(overlay),
        folds=folds,
        finalBest=(dict(stage1=final_best["stage1"].to_dict(), stage2=final_best["stage2"].to_dict(),
                         threshold=final_best["threshold"]) if final_best else None),
        finalInSample={k: {kk: vv for kk, vv in v.items() if kk not in ("stage1Rows", "fusedRows")}
                       for k, v in final_in_sample.items()},
        overlayResults=overlay_results,
        courseHoleCounts={k: dict(nHolesWithBasket=v["nHolesWithBasket"], nHolesDetected=v["nHolesDetected"])
                           for k, v in course_data.items()},
        searchSpace=dict(stage1Grid=STAGE1_GRID, stage2Grid=STAGE2_GRID,
                          thresholdSweep=[THRESHOLD_SWEEP[0], THRESHOLD_SWEEP[-1], len(THRESHOLD_SWEEP)]),
    )
    (out_dir / "grayt-tune-raw-results.json").write_text(json.dumps(raw, indent=1) + "\n")
    print(f"Wrote {out_dir}/grayt-tune-raw-results.json")


if __name__ == "__main__":
    main()
