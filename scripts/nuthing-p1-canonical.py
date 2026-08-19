"""NuThing P1 canonical broad candidate pipeline.

Published from the working Colab prototype as the baseline to port to TypeScript
before Part 2 badge-identity experiments.

Input contract:
    IMAGE = path to a clean cropped + stitched raster

Output:
    NUTHING_P1

Philosophy:
  - discover repeated rendered families
  - rank tee-likeness using projected border agreement
  - PRIMARY = first badge_count tee candidates
  - SECONDARY = everything else
  - optional A/B culling applies only to SECONDARY
  - nothing is discarded from the trace/evidence ledger
"""

import cv2
import numpy as np
from dataclasses import dataclass

# -----------------------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------------------
BRIGHT_V_MIN = 210
BRIGHT_S_MAX = 45
DARK_V_MAX = 45

BADGE_ASPECT_MIN = 1.15
BADGE_ASPECT_MAX = 1.80
BADGE_DARK_INTERIOR_MIN = 0.45
BADGE_SIZE_TOL = np.log(1.15)

FAMILY_SIZE_TOL = np.log(1.20)
MAX_OBJECT_ASPECT = 3.0

TEE_SEED_COUNT = 10
CANON_SIZE = 96
CANON_MAJOR_SPAN = 60.0
MATCH_SIGMA = 1.75
SHIFT_VALUES = [-4, -2, 0, 2, 4]
F_BETA = 0.5
OBSERVED_CORE_FRACTION = 0.60

# Broad default: preserve all secondary candidates. The B gate is an ablation.
ACTIVE_SECONDARY_GATE = "A"
B_CULL_IF_SCORE_BELOW = 0.40


@dataclass
class Component:
    label: int
    cx: float
    cy: float
    area: int
    bbox_x: int
    bbox_y: int
    bbox_w: int
    bbox_h: int
    major: float
    minor: float
    angle: float
    fill: float


def extract_components(mask):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    components = []

    for label in range(1, count):
        x, y, w, h, area = stats[label]
        roi = labels[y:y+h, x:x+w]
        yy, xx = np.where(roi == label)
        if len(xx) < 2:
            continue

        xs = xx + x
        ys = yy + y
        pts = np.column_stack([xs, ys]).astype(np.float64)
        center = pts.mean(axis=0)
        rel = pts - center
        cov = np.cov(rel, rowvar=False, bias=True)
        eigvals, eigvecs = np.linalg.eigh(cov)
        major_axis = eigvecs[:, np.argmax(eigvals)]

        if major_axis[0] < 0 or (abs(major_axis[0]) < 1e-9 and major_axis[1] < 0):
            major_axis = -major_axis

        minor_axis = np.array([-major_axis[1], major_axis[0]])
        u = rel @ major_axis
        v = rel @ minor_axis
        major = float(u.max() - u.min() + 1)
        minor = float(v.max() - v.min() + 1)

        if minor > major:
            major, minor = minor, major

        fill = float(area) / max(major * minor, 1.0)
        angle = float(np.arctan2(major_axis[1], major_axis[0]))

        components.append(Component(
            label=int(label),
            cx=float(center[0]),
            cy=float(center[1]),
            area=int(area),
            bbox_x=int(x),
            bbox_y=int(y),
            bbox_w=int(w),
            bbox_h=int(h),
            major=major,
            minor=minor,
            angle=angle,
            fill=fill,
        ))

    return labels, components


def log_size_distance(a_major, a_minor, b_major, b_minor):
    return max(abs(np.log(a_major / b_major)), abs(np.log(a_minor / b_minor)))


def component_size_distance(a, b):
    return log_size_distance(a.major, a.minor, b.major, b.minor)


def bbox_size_distance(a, b):
    return max(abs(np.log(a.bbox_w / b.bbox_w)), abs(np.log(a.bbox_h / b.bbox_h)))


def anchored_families(components, tolerance, distance_fn=component_size_distance):
    families = []
    seen = set()

    for anchor in components:
        family = [c for c in components if distance_fn(anchor, c) <= tolerance]
        labels_key = tuple(sorted(c.label for c in family))
        if labels_key in seen:
            continue
        seen.add(labels_key)
        families.append(family)

    families.sort(key=len, reverse=True)
    return families


def family_spread(family):
    if not family:
        return float("inf")
    major = np.median([c.major for c in family])
    minor = np.median([c.minor for c in family])
    return np.median([
        log_size_distance(c.major, c.minor, major, minor)
        for c in family
    ])


def distance_to_foreground(mask):
    return cv2.distanceTransform((mask == 0).astype(np.uint8), cv2.DIST_L2, 3)


def fuzzy_support(distance):
    return np.exp(-(distance ** 2) / (2 * MATCH_SIGMA ** 2))


def shift_mask(mask, dx, dy):
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(
        mask, m, (CANON_SIZE, CANON_SIZE),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )


def inner_core(mask, keep_fraction):
    if keep_fraction >= 0.999:
        return mask.copy()
    fg = mask.astype(bool)
    if not fg.any():
        return mask.copy()

    inside_distance = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
    values = inside_distance[fg]
    cutoff = np.quantile(values, 1.0 - keep_fraction)
    return (fg & (inside_distance >= cutoff)).astype(np.uint8)


def fbeta(precision, recall, beta=F_BETA):
    if precision <= 0 or recall <= 0:
        return 0.0
    b2 = beta * beta
    return (1 + b2) * precision * recall / (b2 * precision + recall)


def run_nuthing_p1(image_path, active_secondary_gate=ACTIVE_SECONDARY_GATE):
    bgr = cv2.imread(image_path)
    if bgr is None:
        raise RuntimeError(f"Could not read image: {image_path}")

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]

    bright_mask = ((v >= BRIGHT_V_MIN) & (s <= BRIGHT_S_MAX)).astype(np.uint8)
    dark_mask = (v <= DARK_V_MAX).astype(np.uint8)

    bright_labels, bright_components = extract_components(bright_mask)
    _, dark_components = extract_components(dark_mask)

    # Badge family: white screen-aligned frame + dark interior + repeated bbox size.
    badge_candidates = []
    for c in bright_components:
        if c.bbox_h <= 0:
            continue
        aspect = c.bbox_w / c.bbox_h
        if not (BADGE_ASPECT_MIN <= aspect <= BADGE_ASPECT_MAX):
            continue

        x, y, w, h = c.bbox_x, c.bbox_y, c.bbox_w, c.bbox_h
        dark_fraction = float(dark_mask[y:y+h, x:x+w].mean())
        if dark_fraction >= BADGE_DARK_INTERIOR_MIN:
            badge_candidates.append(c)

    badge_families = anchored_families(badge_candidates, BADGE_SIZE_TOL, bbox_size_distance)
    if not badge_families:
        raise RuntimeError("No repeated white badge-frame family found")

    badges = badge_families[0]
    badge_count = len(badges)
    badge_labels = {c.label for c in badges}
    bright_without_badges = [c for c in bright_components if c.label not in badge_labels]

    # Basket family: repeated bright family whose cardinality is closest to badges.
    basket_pool = [
        c for c in bright_without_badges
        if c.minor > 0 and c.major / c.minor <= MAX_OBJECT_ASPECT
    ]
    basket_families = anchored_families(basket_pool, FAMILY_SIZE_TOL)
    if not basket_families:
        raise RuntimeError("No repeated bright family available for basket discovery")

    def basket_family_key(family):
        return abs(len(family) - badge_count), family_spread(family)

    baskets = min(basket_families, key=basket_family_key)
    basket_labels = {c.label for c in baskets}
    remaining_bright = [
        c for c in bright_without_badges
        if c.label not in basket_labels
    ]

    # Tee mode discovery: geometry discovers the normal population and scale only.
    tee_family_candidates = anchored_families(
        [
            c for c in remaining_bright
            if c.minor > 0 and c.major / c.minor <= MAX_OBJECT_ASPECT
        ],
        FAMILY_SIZE_TOL,
    )
    if not tee_family_candidates:
        raise RuntimeError("No repeated tee-scale bright family found")

    modal_family = max(tee_family_candidates, key=len)
    modal_major = np.median([c.major for c in modal_family])
    modal_minor = np.median([c.minor for c in modal_family])

    def distance_to_tee_mode(c):
        return log_size_distance(c.major, c.minor, modal_major, modal_minor)

    seed_order = sorted(modal_family, key=distance_to_tee_mode)
    seed_count = min(TEE_SEED_COUNT, len(seed_order))
    tee_seeds = seed_order[:seed_count]
    canon_scale = CANON_MAJOR_SPAN / modal_major

    def component_pixels(c):
        x, y, w, h = c.bbox_x, c.bbox_y, c.bbox_w, c.bbox_h
        roi = bright_labels[y:y+h, x:x+w]
        yy, xx = np.where(roi == c.label)
        return xx + x, yy + y

    def canonical_component_mask(c):
        xs, ys = component_pixels(c)
        out = np.zeros((CANON_SIZE, CANON_SIZE), dtype=np.uint8)
        if len(xs) < 2:
            return out

        pts = np.column_stack([xs, ys]).astype(np.float64)
        center = pts.mean(axis=0)
        rel = pts - center
        cov = np.cov(rel, rowvar=False, bias=True)
        eigvals, eigvecs = np.linalg.eigh(cov)
        major_axis = eigvecs[:, np.argmax(eigvals)]

        if major_axis[0] < 0 or (abs(major_axis[0]) < 1e-9 and major_axis[1] < 0):
            major_axis = -major_axis

        minor_axis = np.array([-major_axis[1], major_axis[0]])
        u = rel @ major_axis
        vv = rel @ minor_axis
        center_canon = (CANON_SIZE - 1) / 2
        px = np.rint(center_canon + u * canon_scale).astype(int)
        py = np.rint(center_canon + vv * canon_scale).astype(int)
        valid = (px >= 0) & (px < CANON_SIZE) & (py >= 0) & (py < CANON_SIZE)
        out[py[valid], px[valid]] = 1
        return out

    seed_masks = [canonical_component_mask(c) for c in tee_seeds]
    seed_likelihoods = [fuzzy_support(distance_to_foreground(mask)) for mask in seed_masks]
    tee_border_likelihood = np.mean(seed_likelihoods, axis=0)
    tee_border_template = (tee_border_likelihood >= 0.50).astype(np.uint8)
    tee_template_distance = distance_to_foreground(tee_border_template)
    tee_template_pixels = tee_border_template.astype(bool)

    def score_tee_component(c):
        raw = canonical_component_mask(c)
        best = None

        for dy in SHIFT_VALUES:
            for dx in SHIFT_VALUES:
                candidate = shift_mask(raw, dx, dy)
                observed_core = inner_core(candidate, OBSERVED_CORE_FRACTION)
                observed = observed_core.astype(bool)
                if not observed.any():
                    continue

                explained = float(np.mean(fuzzy_support(tee_template_distance[observed])))
                candidate_distance = distance_to_foreground(candidate)
                coverage = float(np.mean(fuzzy_support(candidate_distance[tee_template_pixels])))
                score = float(fbeta(explained, coverage))

                row = {
                    "component": c,
                    "score": score,
                    "explained": explained,
                    "coverage": coverage,
                    "dx": dx,
                    "dy": dy,
                    "canonical": candidate,
                    "observed_core": observed_core,
                }

                if best is None or row["score"] > best["score"]:
                    best = row

        return best

    tee_ranked = []
    for c in remaining_bright:
        row = score_tee_component(c)
        if row is not None:
            tee_ranked.append(row)
    tee_ranked.sort(key=lambda r: r["score"], reverse=True)

    # Primary is priority/ranking status, not a truth claim.
    primary_count = min(badge_count, len(tee_ranked))
    tee_primary = tee_ranked[:primary_count]
    tee_leftovers = tee_ranked[primary_count:]

    tee_secondary_a = list(tee_leftovers)
    tee_culled_a = []

    # Temporary conservative forwarding floor. Lossless tee_ranked remains intact.
    tee_secondary_b = [r for r in tee_leftovers if r["score"] >= B_CULL_IF_SCORE_BELOW]
    tee_culled_b = [r for r in tee_leftovers if r["score"] < B_CULL_IF_SCORE_BELOW]

    if active_secondary_gate == "A":
        tee_secondary, tee_culled = tee_secondary_a, tee_culled_a
    elif active_secondary_gate == "B":
        tee_secondary, tee_culled = tee_secondary_b, tee_culled_b
    else:
        raise ValueError('active_secondary_gate must be "A" or "B"')

    return {
        "image": rgb,
        "bright_mask": bright_mask,
        "dark_mask": dark_mask,
        "bright_components": bright_components,
        "dark_components": dark_components,
        "badges": badges,
        "badge_count": badge_count,
        "baskets": baskets,
        "remaining_bright": remaining_bright,
        "tee_modal_family": modal_family,
        "tee_modal_major": float(modal_major),
        "tee_modal_minor": float(modal_minor),
        "tee_seeds": tee_seeds,
        "tee_border_template": tee_border_template,
        "tee_ranked": tee_ranked,
        "tee_primary": tee_primary,
        "tee_secondary_A": tee_secondary_a,
        "tee_culled_A": tee_culled_a,
        "tee_secondary_B": tee_secondary_b,
        "tee_culled_B": tee_culled_b,
        "active_secondary_gate": active_secondary_gate,
        "tee_secondary": tee_secondary,
        "tee_culled": tee_culled,
    }


def summarize(result):
    print("NuThing P1")
    print("===========")
    print(f"bright components : {len(result['bright_components'])}")
    print(f"badges            : {len(result['badges'])}")
    print(f"baskets           : {len(result['baskets'])}")
    print(f"tee modal family  : {len(result['tee_modal_family'])}")
    print(f"tee modal size    : {result['tee_modal_major']:.2f} x {result['tee_modal_minor']:.2f}")
    print(f"tee seeds         : {len(result['tee_seeds'])}")
    print(f"PRIMARY tees      : {len(result['tee_primary'])}")
    print(f"active secondary  : {len(result['tee_secondary'])}")
    print(f"active culled     : {len(result['tee_culled'])}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--secondary-gate", choices=["A", "B"], default=ACTIVE_SECONDARY_GATE)
    args = parser.parse_args()

    NUTHING_P1 = run_nuthing_p1(args.image, active_secondary_gate=args.secondary_gate)
    summarize(NUTHING_P1)
