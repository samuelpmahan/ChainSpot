#!/usr/bin/env python3
"""Middle-out tee recovery: recover the tee from the badge + basket only.

Every prior hole-path probe (`hole_path_lowparam_fit.py`,
`hole_path_anchor_experiments.py`, `hole_path_capsule_fit.py`) consumes
truth TEE and BASKET as fixed endpoints and fits the corridor between them.
This probe inverts the tee end: it anchors on the DETECTED number badge and
the (truth) basket, fits the badge->basket corridor exactly as the prior
"mask+anchor, --final" arm does, then walks a ray away from the badge along
the reverse of the badge's corridor-entry bearing, sweeping the bearing in a
window and reading the tee center off as the ribbon-evidence terminus.

Domain fact reused from the prior work: each hole's first corridor segment
is a straight line tee -> badge (the badge sits on the path). Inverted, that
says the badge -> tee segment is *also* a straight line, roughly opposite
the badge's corridor-entry direction, out to wherever the ribbon evidence
that was cast from the tee pad ends.

Method
------
1. Evidence map, IDENTICAL to the low-param fit's flattened arm:
   e = clip((LAB_L - boxmean(L, 41)) / 4, 0, 1) at 1/3 downscale.
2. Corridor fit badge -> basket: reuse of `hole_path_anchor_experiments.fit`
   with EVIDENCE_DL=4 / BEND_MARGIN=0.05 (the "--final" tuned arm), badge
   boxes masked. Gives the corridor's first direction leaving the badge.
3. Ray sweep: bearing0 = reverse(badge -> first corridor point). Sweep
   bearing0 +/- RAY_SWEEP_DEG in RAY_STEP_DEG steps. For each bearing, walk
   outward from just past the badge's masked box to MAX_RAY_PX, sampling
   evidence every RAY_STEP_PX. Compute a trailing-window mean (tolerates
   short dips, e.g. glyph-adjacent noise); the terminus is the first walked
   position where that trailing mean drops below EVIDENCE_THRESH and stays
   there. Best bearing = the one whose terminus is farthest out (sustains
   ribbon evidence longest) -- an off-corridor ray decays fast because nothing
   but the ribbon triggers evidence, except on the known road/parking
   confuser (see findings).
4. Tee estimate = terminus, then stepped back by STEPBACK_PX (~half a tee
   pad) toward the badge, since the ribbon is drawn from the pad and a hard
   trailing-window failure lands slightly past the true center.

Truth tee is used ONLY for grading (never as fit input). Truth basket IS
used as the far anchor (basket detection is separately near-solved; noted
as a caveat in the findings doc). Badge positions are DETECTED, via
`npx tsx scripts/detect-course.ts <zip> --out <dir>` run once per course;
the coordinates below are that detector's literal output (see
hole-path-tee-recovery-findings.md for provenance / regen instructions).

All stage-1 knobs are exposed as `Stage1Params` (see below) so an external
driver (`grayt_tune.py`) can sweep them for cross-validated tuning without
editing this file. CLI defaults are unchanged from the original hardcoded
constants -- running this file directly reproduces the findings-doc numbers.

Usage:
  python3 scripts/cv-probes/hole_path_tee_recovery.py --out scripts/cv-probes/hole-path-results
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.color import rgb2lab

REPO = Path(__file__).resolve().parents[2]

# Grading tolerance shared with ray_template_fusion.py / grayt_tune.py: a
# recovery within this many source px of truth counts as "within13" / a
# gate-passed recovery farther than this is a false accept.
TOLERANCE_PX = 12.691304347826087


# ---------------------------------------------------------------------------
# Stage-1 tunable parameters. Defaults reproduce the pre-tuning hardcoded
# constants exactly (backward compatible).
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Stage1Params:
    scale: int = 3                    # evidence-map downscale factor
    evidence_dl: float = 4.0          # saturating flatten divisor, corridor-fit evidence ("dL/4")
    ray_evidence_dl: float = 10.0     # graded (less-saturated) divisor for the terminus ray walk
    box_mean_window: int = 41         # boxmean window (1/3-scale px) subtracted from LAB L
    open_size: int = 7                # grey-opening kernel (1/3-scale px) that denoises the ray evidence
    bend_margin: float = 0.05         # corridor-fit bend-acceptance margin
    max_bends: int = 2                # corridor-fit bend budget
    badge_half_w: float = 40.0        # badge mask box half-extents, source px
    badge_half_h: float = 30.0
    bearing_sweep_deg: float = 28.0   # +/- sweep width around the reversed corridor-entry bearing
    bearing_step_deg: float = 1.5
    ray_step_px: float = 3.0          # source px per ray sample
    max_ray_px: float = 420.0         # source px search ceiling
    closing_window_px: float = 18.0   # 1-D grey-closing window applied to the ray evidence trace
    evidence_thresh: float = 0.2      # terminus-run threshold on the closed trace
    stepback_px: float = 15.0         # half a tee pad, stepped back from terminus toward the badge

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


DEFAULT_STAGE1 = Stage1Params()


# ---------------------------------------------------------------------------
# Fixtures. Truth tee is grading-only. Truth basket is the far fit anchor.
# Badge centers are DETECTED (npx tsx scripts/detect-course.ts output),
# not truth-derived -- this mirrors what production has available.
# ---------------------------------------------------------------------------

GOLDEN_TEE_SET = REPO / "resources/GoldenTeeSet.chainspot.zip"
ALEX_CLARK_SET = REPO / "resources/AlexClarkSet.chainspot.zip"

# number, teeX, teeY, basketX, basketY (truth; mirrors courseGroundTruth.ts IMG_5641_GROUND_TRUTH)
GOLDEN_TRUTH = [
    (1, 884.8377444109449, 431.9287297485859, 520.909799907873, 426.51990558136015),
    (2, 458.1890699314583, 572.3708514226876, 764.8909697077348, 561.3106463391507),
    (3, 736.6058148380408, 714.6225977184242, 495.14541111301537, 627.099586019013),
    (4, 430.7483576493411, 644.5234235908367, 432.3184616324048, 863.8527701115761),
    (5, 491.56578024851615, 853.0390314516907, 685.3405371507645, 796.3447522033824),
    (6, 680.3814775133769, 850.5247486359476, 438.8388685382941, 914.8063409675767),
    (7, 368.65962418131465, 982.3336860325766, 618.8090454892177, 950.4392544203181),
    (8, 514.9311375611513, 1010.8688843716736, 423.53780515507555, 1176.3405127485696),
    (9, 372.5817142119152, 1181.7862886590783, 306.87752170715316, 1413.0335179962228),
    (10, 260.3490808032921, 1463.0891774122085, 138.43612905330735, 1640.5876987977786),
    (11, 73.56806925413619, 1827.735355732454, 391.34286393147585, 1807.8273853587643),
    (12, 419.21206435573754, 1770.303751900341, 339.1160651426048, 1531.067445545252),
    (13, 446.8826273187712, 1472.9553053160814, 688.779301552193, 1590.6311067912745),
    (14, 680.1006626449425, 1506.8815001878377, 816.6160850013131, 1323.6636042303671),
    (15, 875.1573282347795, 1361.7653659724785, 1034.4051911294462, 1084.9287878265427),
    (16, 1156.1751121865675, 1179.2847661157596, 1128.1243178636212, 763.6529034629543),
    (17, 1069.9746471517396, 852.7679190008336, 872.8859719547469, 986.596640679826),
    (18, 788.5810990714863, 850.3708280038526, 1000.1876912467347, 438.4487575793592),
]

# detected via `npx tsx scripts/detect-course.ts resources/GoldenTeeSet.chainspot.zip`
GOLDEN_BADGES = [
    (1, 755.00, 449.00), (2, 578.00, 582.00), (3, 607.00, 670.00), (4, 444.00, 744.00),
    (5, 551.00, 813.00), (6, 551.00, 885.00), (7, 444.00, 983.00), (8, 461.00, 1068.00),
    (9, 338.00, 1304.00), (10, 195.00, 1555.00), (11, 241.00, 1818.00), (12, 375.00, 1644.00),
    (13, 572.00, 1535.00), (14, 704.00, 1426.00), (15, 906.00, 1277.00), (16, 1140.50, 966.00),
    (17, 965.00, 922.00), (18, 862.50, 778.00),
]

# number, teeX, teeY, basketX, basketY (truth; from AlexClarkSet.chainspot.zip project.json)
ALEX_TRUTH = [
    (1, 621.0, 1601.0, 773.0, 1327.0), (2, 636.0, 1289.0, 495.0, 1396.0),
    (3, 366.0, 1742.0, 296.0, 2002.0), (4, 373.0, 2055.0, 607.0, 1946.0),
    (5, 486.0, 1888.0, 763.0, 1896.0), (6, 677.0, 1847.0, 433.0, 1583.0),
    (7, 460.0, 1410.0, 512.0, 1167.0), (8, 449.0, 867.0, 526.0, 572.0),
    (9, 431.0, 665.0, 355.0, 371.0), (10, 384.0, 306.0, 439.0, 566.0),
    (11, 543.0, 510.0, 456.0, 275.0), (12, 459.0, 234.0, 607.0, 94.0),
    (13, 735.0, 74.0, 1018.0, 286.0), (14, 914.0, 311.0, 751.0, 110.0),
    (15, 706.0, 114.0, 674.0, 335.0), (16, 605.0, 445.0, 864.0, 795.0),
    (17, 681.0, 706.0, 491.0, 873.0), (18, 514.0, 1025.0, 582.0, 1199.0),
]

# detected via `npx tsx scripts/detect-course.ts resources/AlexClarkSet.chainspot.zip`
ALEX_BADGES = [
    (1, 696.00, 1455.00), (2, 559.00, 1346.00), (3, 327.00, 1883.00), (4, 493.00, 2005.00),
    (5, 621.00, 1899.00), (6, 580.00, 1780.00), (7, 485.00, 1283.00), (8, 490.00, 716.00),
    (9, 390.00, 511.00), (10, 412.00, 438.00), (11, 497.00, 389.00), (12, 536.00, 161.00),
    (13, 821.00, 107.00), (14, 827.00, 203.00), (15, 686.00, 229.00), (16, 649.50, 574.00),
    (17, 576.00, 790.00), (18, 547.50, 1113.00),
]

COURSES = {
    "GoldenTeeSet": dict(zip_path=GOLDEN_TEE_SET, truth=GOLDEN_TRUTH, badges=GOLDEN_BADGES,
                          image_name="images/source-original.jpg"),
    "AlexClarkSet": dict(zip_path=ALEX_CLARK_SET, truth=ALEX_TRUTH, badges=ALEX_BADGES,
                          image_name="images/source-original.jpg"),
}


# ---------------------------------------------------------------------------
# Evidence map
# ---------------------------------------------------------------------------

def load_source_image(zip_path: Path, image_name: str) -> Image.Image:
    import zipfile
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open(image_name) as f:
            return Image.open(f).convert("RGB").copy()


def lightness_delta(full: Image.Image, params: Stage1Params = DEFAULT_STAGE1) -> np.ndarray:
    im = np.asarray(full.resize((full.width // params.scale, full.height // params.scale),
                                 Image.LANCZOS)).astype(np.float32) / 255
    lightness = rgb2lab(im)[..., 0]
    return lightness - ndi.uniform_filter(lightness, params.box_mean_window)


def evidence_from_dl(d_l: np.ndarray, dl_scale: float) -> np.ndarray:
    return np.clip(d_l / dl_scale, 0, 1)


def evidence_map(full: Image.Image, params: Stage1Params = DEFAULT_STAGE1) -> np.ndarray:
    return evidence_from_dl(lightness_delta(full, params), params.evidence_dl)


def opened_evidence(ev: np.ndarray, fill_boxes=(), params: Stage1Params = DEFAULT_STAGE1) -> np.ndarray:
    """Grey-opening with badge boxes pre-filled to 1.0 before opening.

    The badge glyph/background reads as low evidence (dark text on a light
    disc, disc edges); left as-is, opening's erosion step drags that low
    value outward and kills the true ribbon signal for ~open_size/2 px on
    either side of the badge box -- exactly the region the ray walk starts
    in. Since the badge sits ON the ribbon (the anchor domain fact this
    whole probe is built on), filling the box to 1.0 before opening is the
    correct prior, not a hack: it lets the true bright ribbon underneath the
    badge win the erosion instead of the glyph noise.
    """
    from scipy.ndimage import grey_opening
    ev = ev.copy()
    for x0, x1, y0, y1 in fill_boxes:
        ev[y0:y1, x0:x1] = 1.0
    return grey_opening(ev, size=params.open_size)


def badge_mask_box(h, w, bx, by, params: Stage1Params = DEFAULT_STAGE1):
    x0 = max(0, int((bx - params.badge_half_w) / params.scale))
    x1 = min(w, int((bx + params.badge_half_w) / params.scale) + 1)
    y0 = max(0, int((by - params.badge_half_h) / params.scale))
    y1 = min(h, int((by + params.badge_half_h) / params.scale) + 1)
    return x0, x1, y0, y1


def sample_line(pts, step=2.0):
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(2, int(np.hypot(x1 - x0, y1 - y0) / step))
        t = np.linspace(0, 1, n, endpoint=False)
        out.append(np.stack([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], 1))
    out.append(np.array([pts[-1]], float))
    return np.concatenate(out)


def make_masked_scorer(ev, valid):
    h, w = ev.shape

    def score(pts):
        p = sample_line(pts)
        xs = np.clip(p[:, 0].astype(int), 0, w - 1)
        ys = np.clip(p[:, 1].astype(int), 0, h - 1)
        keep = valid[ys, xs]
        v = ev[ys[keep], xs[keep]]
        if len(v) < 5:
            return -1.0
        v = np.sort(v)[int(0.2 * len(v)):]
        length = float(np.sum(np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))))
        straight = max(np.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]), 1e-6)
        return float(v.mean()) - 0.2 * max(0.0, length / straight - 1.0)

    return score


def hill_climb(score, pts, movable, steps=(8, 4, 2, 1)):
    pts = [list(p) for p in pts]
    for st in steps:
        improved = True
        while improved:
            improved = False
            for i in movable:
                best, bp = score(pts), tuple(pts[i])
                for dx, dy in ((st, 0), (-st, 0), (0, st), (0, -st),
                               (st, st), (st, -st), (-st, st), (-st, -st)):
                    pts[i] = [bp[0] + dx, bp[1] + dy]
                    s = score(pts)
                    if s > best:
                        best, bp, improved = s, tuple(pts[i]), True
                pts[i] = list(bp)
    return pts, score(pts)


def split_longest(pts):
    segs = [np.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    i = int(np.argmax(segs))
    mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
    return pts[:i + 1] + [mid] + pts[i + 1:]


def fit_corridor(score, badge_scaled, basket_scaled, params: Stage1Params = DEFAULT_STAGE1):
    """badge -> basket corridor fit, 0..max_bends bends, badge boxes masked."""
    cands = {0: ([list(badge_scaled), list(basket_scaled)], score([badge_scaled, basket_scaled]))}
    d = np.array([basket_scaled[0] - badge_scaled[0], basket_scaled[1] - badge_scaled[1]])
    length = max(np.hypot(*d), 1e-6)
    unit = d / length
    perp = np.array([-unit[1], unit[0]])
    best1 = None
    for t in np.linspace(0.25, 0.75, 7):
        for o in np.linspace(-0.45, 0.45, 15):
            mid = (np.array(badge_scaled) + d * t + perp * o * length).tolist()
            s = score([badge_scaled, mid, basket_scaled])
            if best1 is None or s > best1[1]:
                best1 = ([list(badge_scaled), mid, list(basket_scaled)], s)
    cands[1] = hill_climb(score, best1[0], [1])
    for k in range(2, params.max_bends + 1):
        cands[k] = hill_climb(score, split_longest(cands[k - 1][0]), list(range(1, k + 1)))

    k = 0
    for kk in range(1, params.max_bends + 1):
        if cands[kk][1] > cands[k][1] + params.bend_margin:
            k = kk
    return cands[k][0], k, cands[k][1]


# ---------------------------------------------------------------------------
# Ray sweep / terminus search
# ---------------------------------------------------------------------------

def sample_evidence_at(ev, x_src, y_src, badge_mask_box_full, params: Stage1Params = DEFAULT_STAGE1):
    """Evidence at a source-px coordinate; returns (value, is_masked)."""
    h, w = ev.shape
    xi, yi = int(x_src / params.scale), int(y_src / params.scale)
    if not (0 <= xi < w and 0 <= yi < h):
        return 0.0, True
    bx0, bx1, by0, by1 = badge_mask_box_full
    masked = bx0 <= xi < bx1 and by0 <= yi < by1
    return float(ev[yi, xi]), masked


def walk_ray(ev, origin, bearing_rad, badge_box, params: Stage1Params = DEFAULT_STAGE1):
    """Walk outward from origin along bearing_rad. Returns (positions_px,
    evidence[], masked[])."""
    n = int(params.max_ray_px / params.ray_step_px)
    dx, dy = math.cos(bearing_rad), math.sin(bearing_rad)
    ds = np.arange(1, n + 1) * params.ray_step_px
    xs = origin[0] + dx * ds
    ys = origin[1] + dy * ds
    vals = np.empty(n)
    masked = np.empty(n, bool)
    for i in range(n):
        v, m = sample_evidence_at(ev, xs[i], ys[i], badge_box, params)
        vals[i] = v
        masked[i] = m
    return ds, xs, ys, vals, masked


def trailing_terminus(ds, vals, masked, window_px, thresh):
    """Terminus = the far end of the FIRST run of sustained evidence walking
    outward from the badge.

    This replaced a naive trailing-window-average approach (first window
    whose mean evidence drops below threshold). That failed badly: the true
    ribbon profile along the badge->tee ray is not monotone-decaying, it is
    badge-bright -> a real, often 60-120px-wide dip (the fairway strip
    between the badge and the tee pad reads dimmer than either -- possibly a
    genuine terrain/rendering effect, not noise) -> a second bright bump at
    the tee PAD itself -> a sharp, sustained drop to true zero beyond it.
    A trailing-window-average threshold latches onto the FIRST dip and
    reports a terminus far short of the real tee (median error ~90px on the
    18+18 hole set).

    Fix: apply a small 1-D grey closing (`window_px`, tuned to ~24px --
    enough to bridge glyph/JPEG-noise gaps but NOT the ~60-120px genuine
    mid-corridor dip) to denoise, then walk outward and take the far edge of
    the first *closed* run that stays >= thresh. Small denoise closing does
    not bridge the semantic dip, so the first run correctly ends at the
    real corridor gap's start... except that gap IS the mid-corridor dip on
    several holes, not the true end. Empirically (grid search over both
    courses' 36 holes) small closing + a low threshold (~0.15-0.2) is the
    best available compromise: it lets short real dips coexist inside one
    run via the surrounding evidence staying just above threshold, while a
    genuine corridor end (courses have this reading exactly 0 for 100+px)
    still terminates the run. See findings for the accuracy this achieves
    and where it still fails (holes whose true dip reads fully to ~0).
    """
    from scipy.ndimage import grey_closing
    step = ds[1] - ds[0] if len(ds) > 1 else 1.0
    win_n = max(1, int(round(window_px / step)))
    valid = ~masked
    v = np.where(valid, vals, 1.0)  # masked (badge-adjacent) treated as "in run"
    closed = grey_closing(v, size=win_n)

    below = np.where(closed < thresh)[0]
    idx = int(below[0]) if len(below) else len(ds)
    terminus_px = ds[idx - 1] if idx > 0 else 0.0
    run_vals = vals[:idx][~masked[:idx]] if idx > 0 else np.array([])
    return terminus_px, run_vals


def recover_tee(ray_ev, badge_src, corridor_first_pt_src, params: Stage1Params = DEFAULT_STAGE1,
                 bearing_center_override=None):
    """Sweep bearings around reverse(badge->first corridor point); return
    dict with recovered tee, chosen bearing, terminus, score, all-bearing
    trace for diagnostics."""
    bx, by = badge_src
    if bearing_center_override is not None:
        center_bearing = bearing_center_override
    else:
        fx, fy = corridor_first_pt_src
        into = math.atan2(fy - by, fx - bx)
        center_bearing = into + math.pi  # reverse

    h, w = ray_ev.shape
    badge_box = badge_mask_box(h, w, bx, by, params)

    best = None
    trace = []
    n_steps = int(round(2 * params.bearing_sweep_deg / params.bearing_step_deg)) + 1
    for i in range(n_steps):
        deg_off = -params.bearing_sweep_deg + i * params.bearing_step_deg
        bearing = center_bearing + math.radians(deg_off)
        ds, xs, ys, vals, masked = walk_ray(ray_ev, (bx, by), bearing, badge_box, params)
        terminus_px, run_vals = trailing_terminus(ds, vals, masked, params.closing_window_px,
                                                   params.evidence_thresh)
        mean_ev = float(run_vals.mean()) if len(run_vals) else 0.0
        # Rank primarily by how far sustained evidence reaches (a wrong
        # bearing decays fast off the ribbon), tie-broken by mean evidence.
        rank = (terminus_px, mean_ev)
        trace.append(dict(degOff=round(deg_off, 2), terminusPx=round(terminus_px, 1),
                           meanEvidence=round(mean_ev, 3)))
        if best is None or rank > best[0]:
            best = (rank, bearing, deg_off, terminus_px, mean_ev)

    _, bearing, deg_off, terminus_px, mean_ev = best
    stepback = min(params.stepback_px, terminus_px)
    tee_px = terminus_px - stepback
    tee_x = bx + math.cos(bearing) * tee_px
    tee_y = by + math.sin(bearing) * tee_px
    return dict(
        teePx=(tee_x, tee_y),
        bearingRad=bearing,
        bearingDeg=math.degrees(bearing),
        degOffFromCenter=round(deg_off, 2),
        terminusPx=round(terminus_px, 1),
        recoveredDistFromBadgePx=round(tee_px, 1),
        meanEvidence=round(mean_ev, 3),
        centerBearingDeg=math.degrees(center_bearing),
        trace=trace,
    )


# ---------------------------------------------------------------------------
# Generic per-course stage-1 run, usable on arbitrary courses (not just the
# two hardcoded fixtures) -- badges and basket are passed in, truth is
# optional (None entries mean "grading unavailable", used for overlay-only
# captures).
# ---------------------------------------------------------------------------

def run_stage1(full: Image.Image, badges, baskets_by_n, truth_by_n, params: Stage1Params = DEFAULT_STAGE1,
               badge_jitter=(0.0, 0.0)):
    """badges: list of (number, bx, by). baskets_by_n: {number: (bx, by)}.
    truth_by_n: {number: (tx, ty)} or {} if truth is unavailable (overlay-only).
    Returns list of per-hole result dicts (JSON-safe)."""
    d_l = lightness_delta(full, params)
    ev = evidence_from_dl(d_l, params.evidence_dl)             # flat, for corridor structure
    h, w = ev.shape
    badge_boxes = [badge_mask_box(h, w, bx, by, params) for _, bx, by in badges]
    ray_ev = opened_evidence(evidence_from_dl(d_l, params.ray_evidence_dl), badge_boxes, params)

    valid_all = np.ones((h, w), bool)
    for x0, x1, y0, y1 in badge_boxes:
        valid_all[y0:y1, x0:x1] = False
    scorer = make_masked_scorer(ev, valid_all)

    rows = []
    for n, bx0, by0 in badges:
        jx, jy = badge_jitter
        bx, by = bx0 + jx, by0 + jy
        xbask, ybask = baskets_by_n[n]

        badge_scaled = (bx / params.scale, by / params.scale)
        basket_scaled = (xbask / params.scale, ybask / params.scale)
        corridor_pts, bends, corridor_score = fit_corridor(scorer, badge_scaled, basket_scaled, params)
        first_pt_src = (corridor_pts[1][0] * params.scale, corridor_pts[1][1] * params.scale)

        t0 = time.time()
        rec = recover_tee(ray_ev, (bx, by), first_pt_src, params)
        elapsed = time.time() - t0

        rec_x, rec_y = rec["teePx"]
        row = dict(
            hole=n, badgePx=(round(bx, 1), round(by, 1)),
            basketPx=(round(xbask, 1), round(ybask, 1)),
            recoveredTeePx=(round(rec_x, 1), round(rec_y, 1)),
            bearingDeg=round(rec["bearingDeg"], 1),
            degOffFromCenter=rec["degOffFromCenter"],
            terminusPx=rec["terminusPx"],
            meanEvidence=rec["meanEvidence"],
            corridorBends=bends,
            corridorScore=round(corridor_score, 3),
            runtimeMs=round(elapsed * 1000, 1),
        )
        if n in truth_by_n:
            tx_truth, ty_truth = truth_by_n[n]
            dist_err = math.hypot(rec_x - tx_truth, rec_y - ty_truth)
            truth_bearing = math.degrees(math.atan2(ty_truth - by, tx_truth - bx))
            bearing_err = abs(((rec["bearingDeg"] - truth_bearing) + 180) % 360 - 180)
            row.update(
                truthTeePx=(round(tx_truth, 1), round(ty_truth, 1)),
                distErrPx=round(dist_err, 1),
                truthBearingDeg=round(truth_bearing, 1),
                bearingErrDeg=round(bearing_err, 1),
            )
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Per-course run (fixture-CLI compatible wrapper around run_stage1)
# ---------------------------------------------------------------------------

def run_course(name, cfg, out_dir, params: Stage1Params = DEFAULT_STAGE1, badge_jitter=(0.0, 0.0), tag=""):
    t_start = time.time()
    full = load_source_image(cfg["zip_path"], cfg["image_name"])

    truth_by_n = {n: (tx, ty) for n, tx, ty, bx, by in cfg["truth"]}
    baskets_by_n = {n: (bx, by) for n, tx, ty, bx, by in cfg["truth"]}

    rows = run_stage1(full, cfg["badges"], baskets_by_n, truth_by_n, params, badge_jitter)
    total_elapsed = time.time() - t_start
    within13 = sum(1 for r in rows if r["distErrPx"] <= TOLERANCE_PX)
    within25 = sum(1 for r in rows if r["distErrPx"] <= 25.0)

    print(f"\n=== {name}{tag} ===  total wall-clock {total_elapsed:.2f}s "
          f"({total_elapsed / len(rows) * 1000:.0f} ms/hole)")
    print(f"within 13px: {within13}/{len(rows)}   within 25px: {within25}/{len(rows)}")
    for r in sorted(rows, key=lambda r: r["hole"]):
        print(f"  hole {r['hole']:2d}: dist={r['distErrPx']:6.1f}px  "
              f"bearingErr={r['bearingErrDeg']:5.1f}deg  "
              f"terminus={r['terminusPx']:5.1f}px  ev={r['meanEvidence']:.3f}  "
              f"bends={r['corridorBends']}  {r['runtimeMs']:.0f}ms")

    result = dict(course=name, tag=tag, params=params.to_dict(), totalWallClockS=round(total_elapsed, 3),
                  within13=within13, within25=within25, nHoles=len(rows), holes=rows)
    (out_dir / f"{name}{tag}-tee-recovery.json").write_text(json.dumps(result, indent=1) + "\n")

    # overlay
    overlay = full.copy()
    d = ImageDraw.Draw(overlay)
    for _, bx, by in cfg["badges"]:
        d.rectangle([bx - params.badge_half_w, by - params.badge_half_h,
                     bx + params.badge_half_w, by + params.badge_half_h],
                    outline=(0, 200, 255), width=2)
    for n, tx, ty, xbask, ybask in cfg["truth"]:
        d.ellipse([xbask - 10, ybask - 10, xbask + 10, ybask + 10], outline=(0, 140, 255), width=3)
        d.ellipse([tx - 10, ty - 10, tx + 10, ty + 10], outline=(0, 255, 0), width=4)  # truth tee
    for r in rows:
        bx, by = r["badgePx"]
        rx, ry = r["recoveredTeePx"]
        d.line([(bx, by), (rx, ry)], fill=(255, 140, 0), width=3)
        d.ellipse([rx - 9, ry - 9, rx + 9, ry + 9], outline=(255, 60, 0), width=4)
        d.text((rx + 12, ry - 6), f"{r['hole']}", fill=(255, 255, 0))
    overlay.save(out_dir / f"{name}{tag}-overlay.png")
    print(f"wrote {out_dir}/{name}{tag}-tee-recovery.json, {name}{tag}-overlay.png")
    return result


def add_stage1_cli_args(ap: argparse.ArgumentParser) -> None:
    d = DEFAULT_STAGE1
    ap.add_argument("--scale", type=int, default=d.scale)
    ap.add_argument("--evidence-dl", type=float, default=d.evidence_dl)
    ap.add_argument("--ray-evidence-dl", type=float, default=d.ray_evidence_dl)
    ap.add_argument("--box-mean-window", type=int, default=d.box_mean_window)
    ap.add_argument("--open-size", type=int, default=d.open_size)
    ap.add_argument("--bend-margin", type=float, default=d.bend_margin)
    ap.add_argument("--max-bends", type=int, default=d.max_bends)
    ap.add_argument("--badge-half-w", type=float, default=d.badge_half_w)
    ap.add_argument("--badge-half-h", type=float, default=d.badge_half_h)
    ap.add_argument("--bearing-sweep-deg", type=float, default=d.bearing_sweep_deg)
    ap.add_argument("--bearing-step-deg", type=float, default=d.bearing_step_deg)
    ap.add_argument("--ray-step-px", type=float, default=d.ray_step_px)
    ap.add_argument("--max-ray-px", type=float, default=d.max_ray_px)
    ap.add_argument("--closing-window-px", type=float, default=d.closing_window_px)
    ap.add_argument("--evidence-thresh", type=float, default=d.evidence_thresh)
    ap.add_argument("--stepback-px", type=float, default=d.stepback_px)


def stage1_params_from_args(args) -> Stage1Params:
    return Stage1Params(
        scale=args.scale, evidence_dl=args.evidence_dl, ray_evidence_dl=args.ray_evidence_dl,
        box_mean_window=args.box_mean_window, open_size=args.open_size, bend_margin=args.bend_margin,
        max_bends=args.max_bends, badge_half_w=args.badge_half_w, badge_half_h=args.badge_half_h,
        bearing_sweep_deg=args.bearing_sweep_deg, bearing_step_deg=args.bearing_step_deg,
        ray_step_px=args.ray_step_px, max_ray_px=args.max_ray_px,
        closing_window_px=args.closing_window_px, evidence_thresh=args.evidence_thresh,
        stepback_px=args.stepback_px,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/cv-probes/hole-path-results")
    ap.add_argument("--jitter", type=float, default=0.0,
                     help="badge-position jitter magnitude (px) for the robustness control")
    add_stage1_cli_args(ap)
    args = ap.parse_args()
    out_dir = REPO / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    params = stage1_params_from_args(args)

    summary = {}
    for name, cfg in COURSES.items():
        summary[name] = run_course(name, cfg, out_dir, params)

    if args.jitter > 0:
        rng = np.random.default_rng(777)
        for name, cfg in COURSES.items():
            angle = rng.uniform(0, 2 * math.pi, size=len(cfg["badges"]))
            # apply a fixed +-3px style jitter per hole (deterministic per hole index)
            jittered_cfg = dict(cfg)
            jittered_badges = []
            for i, (n, bx, by) in enumerate(cfg["badges"]):
                jx = args.jitter * math.cos(angle[i])
                jy = args.jitter * math.sin(angle[i])
                jittered_badges.append((n, bx + jx, by + jy))
            jittered_cfg["badges"] = jittered_badges
            summary[f"{name}-jitter"] = run_course(name, jittered_cfg, out_dir, params, tag="-jitter")

    (out_dir / "tee-recovery-summary.json").write_text(json.dumps(summary, indent=1) + "\n")


if __name__ == "__main__":
    main()
