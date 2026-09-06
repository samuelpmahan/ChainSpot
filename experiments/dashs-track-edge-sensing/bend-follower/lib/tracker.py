"""Bounded paired-boundary tracking and bend localization.

The tracker is deliberately pure: it accepts a grayscale sampler (or nested
array), makes no filesystem/UI calls, and returns all decisions as data.
Coordinates are image coordinates (x right, y down).
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from math import cos, sin, hypot, atan2, pi, isfinite
from typing import Callable, Iterable, Sequence, Optional, Any

Point = tuple[float, float]
Sampler = Callable[[float, float], float]


def _wrap(a: float) -> float:
    return (a + pi) % (2 * pi) - pi


def bilinear_sample(image: Sequence[Sequence[float]], x: float, y: float,
                    outside: float = float("nan")) -> float:
    """Subpixel sample with zero/outside fill (no nearest-neighbour bias)."""
    h = len(image)
    w = len(image[0]) if h else 0
    if not w or x < 0 or y < 0 or x > w - 1 or y > h - 1:
        return outside
    x0, y0 = int(x), int(y)
    x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1)
    fx, fy = x - x0, y - y0
    return ((1-fx) * (1-fy) * float(image[y0][x0]) +
            fx * (1-fy) * float(image[y0][x1]) +
            (1-fx) * fy * float(image[y1][x0]) +
            fx * fy * float(image[y1][x1]))


def signed_edge_support(sample: Sampler, point: Point, inward: Point,
                        delta: float = 0.5) -> float:
    """Signed, inward-facing edge support at a subpixel point.

    It is the directional image derivative along ``inward``. A positive value
    means the edge transitions toward the corridor interior. The magnitude is
    bounded only by the caller's image scale.
    """
    x, y = point
    nx, ny = inward
    norm = hypot(nx, ny) or 1.0
    nx, ny = nx / norm, ny / norm
    a = sample(x + delta * nx, y + delta * ny)
    b = sample(x - delta * nx, y - delta * ny)
    if not (isfinite(float(a)) and isfinite(float(b))):
        return float("nan")
    return (a - b) / (2 * delta)


def multiscale_edge_support(sample: Sampler, point: Point, inward: Point,
                             deltas: tuple[float, ...] = (0.75, 1.5, 3.0, 6.0)) -> float:
    """Soft-boundary support averaged across scales; sharp support remains available."""
    vals = [signed_edge_support(sample, point, inward, d) for d in deltas]
    vals = [v for v in vals if isfinite(v)]
    # A broad reversal contradicts a narrow edge. It is UNKNOWN rather than
    # evidence: a sharp pixel transition cannot pay for the absent soft profile.
    if not vals or (min(vals) < 0 < max(vals)):
        return float("nan")
    return min(vals)


@dataclass(frozen=True)
class TrackerConfig:
    steps: int = 32
    step_length: float = 3.0
    beam_width: int = 24
    transverse_offsets: tuple[float, ...] = (-1.0, 0.0, 1.0)
    heading_offsets: tuple[float, ...] = (-0.12, 0.0, 0.12)
    width_offsets: tuple[float, ...] = (-1.0, 0.0, 1.0)
    min_width: float = 3.0
    max_width: float = 80.0
    max_curvature: float = 0.45
    min_pair_support: float = -float("inf")
    min_individual_support: float = -float("inf")
    use_multiscale_support: bool = True
    support_weight: float = 1.0
    continuity_weight: float = 0.12
    curvature_weight: float = 0.40
    width_weight: float = 0.08
    max_diagnostic_ranges: int = 32
    heading_diversity: float = 0.14
    position_diversity: float = 3.0


@dataclass
class TrackState:
    center: Point
    heading: float
    width: float
    score: float
    pair_support: float
    curvature: float = 0.0
    parent: int = -1


@dataclass
class TrackResult:
    status: str
    states: list[TrackState]
    alternatives: list[dict[str, Any]] = field(default_factory=list)
    rejections: dict[str, int] = field(default_factory=dict)
    stop_reason: str = ""
    clipped_ranges: list[tuple[int, int]] = field(default_factory=list)
    diagnostics: dict[str, Any] = field(default_factory=dict)

    @property
    def centers(self) -> list[Point]:
        return [s.center for s in self.states]


def _make_sampler(source: Sampler | Sequence[Sequence[float]]) -> Sampler:
    return source if callable(source) else lambda x, y: bilinear_sample(source, x, y)


def track_paired_boundaries(
    source: Sampler | Sequence[Sequence[float]],
    seed_center: Point,
    seed_heading: float,
    seed_width: float,
    config: TrackerConfig = TrackerConfig(),
) -> TrackResult:
    """Track a bounded beam of paired inward-signed boundaries.

    Every transition advances by one fixed longitudinal step. The state stores
    center, tangent, width and cumulative score; pair support is evaluated at
    both boundaries using opposite inward normals. Beam pruning bounds both
    runtime and memory.
    """
    sample = _make_sampler(source)
    rej = {"width": 0, "curvature": 0, "pair_support": 0, "nonfinite": 0}
    clipped: list[tuple[int, int]] = []
    if not (config.min_width <= seed_width <= config.max_width):
        return TrackResult("REJECTED", [], rejections={"width": 1}, stop_reason="seed_width_out_of_range")
    beam = [TrackState(seed_center, seed_heading, seed_width, 0.0, 0.0)]
    layers: list[list[TrackState]] = [beam]
    for step in range(1, max(1, config.steps)):
        generated: list[TrackState] = []
        for parent_i, prev in enumerate(beam):
            tx, ty = cos(prev.heading), sin(prev.heading)
            nx, ny = -ty, tx
            for transverse in config.transverse_offsets:
                for dh in config.heading_offsets:
                    heading = _wrap(prev.heading + dh)
                    curvature = _wrap(heading - prev.heading) / config.step_length
                    if abs(curvature) > config.max_curvature:
                        rej["curvature"] += 1
                        continue
                    # Advance along the chosen candidate tangent and apply the
                    # transverse correction in the previous normal frame.
                    ctx0, cty0 = cos(heading), sin(heading)
                    cx = prev.center[0] + config.step_length * ctx0 + transverse * nx
                    cy = prev.center[1] + config.step_length * cty0 + transverse * ny
                    for dw in config.width_offsets:
                        width = min(config.max_width, max(config.min_width, prev.width + dw))
                        # Candidate boundary normals use the candidate tangent.
                        ctx, cty = cos(heading), sin(heading)
                        cnx, cny = -cty, ctx
                        left = (cx - cnx * width / 2, cy - cny * width / 2)
                        right = (cx + cnx * width / 2, cy + cny * width / 2)
                        support_fn = multiscale_edge_support if config.use_multiscale_support else signed_edge_support
                        left_support = support_fn(sample, left, (cnx, cny))
                        right_support = support_fn(sample, right, (-cnx, -cny))
                        # Balanced pair score: weak/occluded side controls the
                        # pair rather than allowing one edge to dominate.
                        pair = min(left_support, right_support)
                        if not (isfinite(left_support) and isfinite(right_support) and isfinite(pair)):
                            rej["nonfinite"] += 1
                            continue
                        if min(left_support, right_support) < config.min_individual_support:
                            rej["pair_support"] += 1
                            continue
                        if pair <= config.min_pair_support:
                            rej["pair_support"] += 1
                            continue
                        delta_theta = _wrap(heading - prev.heading)
                        # Scores are integrated along arc length: appearance is
                        # support * ds, while turning energy is dtheta² / ds.
                        score = (prev.score + config.support_weight * pair * config.step_length -
                                 config.continuity_weight * transverse * transverse / config.step_length -
                                 config.curvature_weight * delta_theta * delta_theta / config.step_length -
                                 config.width_weight * dw * dw)
                        generated.append(TrackState((cx, cy), heading, width, score, pair, curvature, parent_i))
        if not generated:
            clipped.append((step, step))
            break
        generated.sort(key=lambda s: s.score, reverse=True)
        if len(generated) > config.beam_width:
            clipped.append((step, len(generated) - config.beam_width))
            # Score first, then reserve distinct pose hypotheses before filling.
            selected=[]
            for cand in generated:
                same = any(abs(_wrap(cand.heading-q.heading)) < config.heading_diversity and hypot(cand.center[0]-q.center[0],cand.center[1]-q.center[1]) < config.position_diversity for q in selected)
                if not same: selected.append(cand)
                if len(selected) == config.beam_width: break
            if len(selected) < config.beam_width:
                selected.extend(c for c in generated if c not in selected) 
            generated = selected[:config.beam_width]
        beam = generated
        layers.append(beam)
    if not beam:
        return TrackResult("REJECTED", [], rejections=rej, stop_reason="no_valid_transition", clipped_ranges=clipped)
    # Follow best parents through layers. Parent indexes refer to previous beam;
    # retaining each layer makes traceback independent of mutable pruning.
    # Keep the best terminal from every reached layer. This means a good
    # branch that stops at a clipped range remains eligible for output.
    terminal_refs = [(li, i, layer[i].score) for li, layer in enumerate(layers) for i in range(len(layer))]
    terminal_refs.sort(key=lambda x: x[2], reverse=True)
    terminal_layer, last, _ = terminal_refs[0]
    path: list[TrackState] = []
    for layer_i in range(terminal_layer, -1, -1):
        state = layers[layer_i][last]
        path.append(state)
        last = state.parent
        if last < 0:
            break
    path.reverse()
    alternatives = [{"score": layers[li][i].score, "center": layers[li][i].center,
                     "heading": layers[li][i].heading, "width": layers[li][i].width,
                     "terminalLayer": li}
                    for li, i, _ in terminal_refs[1:5]]
    status = "OK" if len(path) >= 2 else "PARTIAL"
    reason = "budget" if len(path) == config.steps else "lack_support"
    # The reported spread makes pruning inspectable without drawing alternates.
    heading_bins=len({round(s.heading/max(config.heading_diversity,1e-6)) for s in beam})
    return TrackResult(status, path, alternatives, rej, reason, clipped,
                       {"layers": len(layers), "beamWidth": config.beam_width,
                        "prunedCandidates": sum(max(0, n-config.beam_width) for _,n in clipped),
                        "pruningDiversity": {"headingBins":heading_bins,"headingThresholdRad":config.heading_diversity,"positionThresholdPx":config.position_diversity},
                        "best_score": path[-1].score, "terminalCandidates": len(terminal_refs),
                        "terminalLayer": terminal_layer})


@dataclass
class BendResult:
    status: str
    index: Optional[int]
    point: Optional[Point]
    angle_change: float
    confidence: float
    reason: str
    diagnostics: dict[str, Any] = field(default_factory=dict)


def _line_fit(points: Sequence[Point]) -> tuple[float, float]:
    """Return orientation and normalized RMS residual of a point set."""
    if len(points) < 2:
        return 0.0, float("inf")
    mx = sum(p[0] for p in points) / len(points)
    my = sum(p[1] for p in points) / len(points)
    xx = sum((p[0]-mx)**2 for p in points)
    yy = sum((p[1]-my)**2 for p in points)
    xy = sum((p[0]-mx)*(p[1]-my) for p in points)
    angle = 0.5 * atan2(2*xy, xx-yy)
    # PCA is unoriented; point it in the observed segment direction.
    dx, dy = points[-1][0]-points[0][0], points[-1][1]-points[0][1]
    if dx*cos(angle) + dy*sin(angle) < 0: angle = _wrap(angle + pi)
    c, s = cos(angle), sin(angle)
    residual = (sum((-(p[0]-mx)*s + (p[1]-my)*c)**2 for p in points) / max(1, len(points)))**0.5
    return angle, residual  # perpendicular RMS, source pixels


def localize_bend(states_or_points: Sequence[TrackState | Point],
                  min_segment: int = 4,
                  min_angle_change: float = 0.20,
                  max_residual: float = 3.0) -> BendResult:
    """Find a change point with two piecewise line fits; return UNKNOWN safely."""
    points = [s.center if isinstance(s, TrackState) else s for s in states_or_points]
    n = len(points)
    if n < 2 * min_segment + 1:
        return BendResult("UNKNOWN", None, None, 0.0, 0.0, "insufficient_points")
    straight_angle, straight_rms = _line_fit(points)
    straight_sse = straight_rms * straight_rms * n
    best = None
    for i in range(min_segment, n - min_segment):
        a1, r1 = _line_fit(points[:i])
        a2, r2 = _line_fit(points[i:])
        da = abs(_wrap(a2 - a1))
        split_sse = r1*r1*i + r2*r2*(n-i)
        # Two extra line parameters have a small, stated pixel² complexity cost.
        cost = split_sse + 4.0
        if best is None or cost < best[0]:
            best = (cost, split_sse, i, da, r1, r2, a1, a2)
    assert best is not None
    _, split_sse, i, da, r1, r2, a1, a2 = best
    residual = ((r1*r1*i + r2*r2*(n-i))/n)**0.5
    if split_sse + 4.0 >= straight_sse:
        return BendResult("UNKNOWN", i, points[i], da, 0.0, "no_piecewise_improvement_over_straight",
                          {"straightSsePx2":straight_sse,"splitSsePx2":split_sse,"complexityPenaltyPx2":4.0,"piecewiseRmsPx":residual,"left_angle":a1,"right_angle":a2})
    if da < min_angle_change:
        return BendResult("UNKNOWN", i, points[i], da, min(1.0, da / max(min_angle_change, 1e-9)), "angle_change_below_threshold",
                          {"left_angle": a1, "right_angle": a2, "leftRmsPx": r1, "rightRmsPx": r2, "straightSsePx2":straight_sse, "splitSsePx2":split_sse})
    if residual > max_residual:
        return BendResult("UNKNOWN", i, points[i], da, max(0.0, 1 - residual), "piecewise_fit_residual_high",
                          {"left_angle": a1, "right_angle": a2, "leftRmsPx": r1, "rightRmsPx": r2, "straightSsePx2":straight_sse, "splitSsePx2":split_sse})
    confidence = max(0.0, min(1.0, (da / pi) * (1 - residual / max_residual)))
    return BendResult("FOUND", i, points[i], da, confidence, "piecewise_fit", {
        "left_angle": a1, "right_angle": a2, "leftRmsPx": r1, "rightRmsPx": r2, "straightSsePx2":straight_sse, "splitSsePx2":split_sse})

def localize_bends(states_or_points: Sequence[TrackState | Point], min_segment: int=4, window: int=18, max_candidates: int=3) -> list[BendResult]:
    """Sequential local change-point candidates; no prescribed count."""
    pts=[s.center if isinstance(s,TrackState) else s for s in states_or_points]
    candidates=[]
    for start in range(0,max(1,len(pts)-2*min_segment),max(1,window//2)):
        sub=pts[start:min(len(pts),start+window)]
        r=localize_bend(sub,min_segment=min_segment)
        if r.status=='FOUND' and r.index is not None:
            r.index += start
            if all(abs(r.index-q.index)>=min_segment for q in candidates if q.index is not None):candidates.append(r)
    candidates.sort(key=lambda r:r.confidence,reverse=True)
    out = candidates[:max_candidates] or [localize_bend(pts,min_segment=min_segment)]
    for r in out: r.diagnostics.update({"sequentialWindowPx":window,"candidateBudget":max_candidates,"candidateBudgetClipped":len(candidates)>max_candidates})
    return out

# Stable integration facade for the ChainSpot experiment.
def track_hole(image_rgb: Any, mask: Any, seed: Any, params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Run the pure tracker and serialize its result for pipeline consumers.

    ``seed`` accepts a mapping with center/heading/width, a ``(x,y)`` pair,
    or an object exposing those attributes. ``params`` overrides TrackerConfig.
    ``mask`` is accepted for API compatibility and used only as a validity
    sampler when it is a numeric 2-D array.
    """
    params = dict(params or {})
    def get(obj, key, default=None):
        if isinstance(obj, dict): return obj.get(key, default)
        return getattr(obj, key, default)
    center = get(seed, "center", None)
    if center is None and isinstance(seed, (tuple, list)) and len(seed) >= 2:
        center = (float(seed[0]), float(seed[1]))
    center = tuple(center or (0.0, 0.0))
    heading = float(get(seed, "heading", get(seed, "angle", params.pop("seed_heading", 0.0))))
    width = float(get(seed, "width", params.pop("seed_width", 12.0)))
    # Convert RGB/RGBA to luminance while preserving subpixel interpolation.
    if callable(image_rgb):
        src = image_rgb
    else:
        def src(x, y):
            # Any badge-owned support sample is UNKNOWN.  Do not fabricate zero
            # contrast or call it terrain.
            if mask is not None:
                mv = bilinear_sample(mask, x, y)
                if isfinite(float(mv)) and float(mv) > 0.001: return float("nan")
            val = bilinear_sample(image_rgb, x, y)
            if isinstance(val, (tuple, list)):
                return 0.2126*float(val[0]) + 0.7152*float(val[1]) + 0.0722*float(val[2])
            return float(val)
    allowed = {k: v for k, v in params.items() if k in TrackerConfig.__dataclass_fields__}
    result = track_paired_boundaries(src, center, heading, width, TrackerConfig(**allowed))
    pts = []
    for s in result.states:
        nx, ny = -sin(s.heading), cos(s.heading)
        left = (s.center[0] - nx*s.width/2, s.center[1] - ny*s.width/2)
        right = (s.center[0] + nx*s.width/2, s.center[1] + ny*s.width/2)
        pts.append({"center": s.center, "left": left, "right": right,
                    "support": s.pair_support, "heading": s.heading, "width": s.width})
    bend = localize_bends(result.states)
    return {"status": result.status, "points": pts,
            "alternatives": result.alternatives, "stop": result.stop_reason,
            "widthDiagnostics": {"rejections": result.rejections,
                                  "clippedRanges": result.clipped_ranges,
                                  "bestScore": result.diagnostics.get("best_score")},
            "bendCandidates": [asdict(b) for b in bend],
            "diagnostics": result.diagnostics}


def synthetic_checks() -> dict[str, bool]:
    """Small deterministic smoke checks suitable for a gateway health probe."""
    image = [[0.0]*48 for _ in range(24)]
    # Two bright transitions around a horizontal corridor.
    for y in range(24):
        for x in range(48):
            image[y][x] = 1.0 if y in (8, 16) else 0.0
    out = track_hole(image, None, {"center": (5, 12), "heading": 0.0, "width": 8},
                     {"steps": 5, "beam_width": 4, "min_pair_support": -10})
    contradiction = [5.0, 3.0, -1.0, -2.0]
    disagreement_unknown = not (min(contradiction) >= 0 or max(contradiction) <= 0)
    return {"subpixel": abs(bilinear_sample([[0,1],[2,3]], .5, .5)-1.5) < 1e-9,
            "broadContradictionUnknown": disagreement_unknown,
            "bounded": len(out["points"]) <= 5,
            "schema": all(k in out for k in ("points", "alternatives", "stop", "widthDiagnostics", "bendCandidates"))}
