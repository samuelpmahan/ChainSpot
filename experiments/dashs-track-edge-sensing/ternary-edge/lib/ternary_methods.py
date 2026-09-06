"""Small, dependency free ternary edge reading methods.

The methods operate on an RGB profile sampled along a ray.  Method A is a
reference comparison: a reader pair is ribbon when both samples are closer to
the middle (live) colour than to terrain, terrain when both favour terrain,
and an edge when the two decisions differ.  Method B fits three constant RGB
regions (left flank, ribbon, right flank) while trying every pair of integer
transition offsets; its residual is the uncalibrated goodness of fit.  These
scores are deliberately raw so a caller can calibrate thresholds for its
camera and terrain.
"""

from math import isfinite


def _rgb(value):
    if isinstance(value, dict):
        for key in ("rgb", "color", "colour", "value"):
            if key in value:
                return _rgb(value[key])
        if all(k in value for k in ("r", "g", "b")):
            return (float(value["r"]), float(value["g"]), float(value["b"]))
    if hasattr(value, "rgb"):
        return _rgb(value.rgb)
    try:
        out = tuple(float(x) for x in value[:3])
    except (TypeError, IndexError, ValueError):
        return None
    if len(out) != 3 or not all(isfinite(x) for x in out):
        return None
    return out


def rgb_distance(a, b):
    """Euclidean distance between two RGB records (or ``None`` if invalid)."""
    a, b = _rgb(a), _rgb(b)
    if a is None or b is None:
        return None
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def rgb_variance(samples):
    """Mean per-channel population variance of RGB samples."""
    values = [_rgb(x) for x in samples]
    values = [x for x in values if x is not None]
    if not values:
        return None
    means = tuple(sum(x[i] for x in values) / len(values) for i in range(3))
    return sum(sum((x[i] - means[i]) ** 2 for i in range(3)) for x in values) / (3 * len(values))


def _mean(values):
    values = [_rgb(x) for x in values]
    values = [x for x in values if x is not None]
    if not values:
        return None
    return tuple(sum(x[i] for x in values) / len(values) for i in range(3))


def _median(values):
    values = [x for x in (_rgb(v) for v in values) if x is not None]
    if not values:
        return None
    # Median is taken independently for R, G and B.  Sorting RGB tuples as
    # tuples would select lexicographic records and is not an RGB median.
    return tuple(_channel_median([x[i] for x in values]) for i in range(3))


def _channel_median(values):
    values = sorted(values)
    n = len(values)
    return (values[(n - 1) // 2] + values[n // 2]) / 2


def _valid(values):
    return [x for x in values if _rgb(x) is not None]


def _margin(sample, reference, terrain):
    dr, dt = rgb_distance(sample, reference), rgb_distance(sample, terrain)
    if dr is None or dt is None:
        return None
    return dt - dr  # positive means reference is closer


def method_a(samples, center=None, expected_offsets=(-3, 3), transverse_samples=None,
             predrop_samples=None, terrain_samples=None, occluded=None, margin=0.0,
             reference_selector="auto", reference=None):
    """Classify one expected reader pair using live and pre-drop references.

    ``transverse_samples`` supplies the live cross-section; when omitted the
    valid samples within five indices of ``center`` are used.  ``predrop`` is
    the running median of prior valid samples from the ray.  Both references
    and the selected source are returned for inspection.
    """
    values = list(samples or [])
    if center is None:
        center = len(values) // 2
    lo, hi = min(expected_offsets), max(expected_offsets)
    pair = []
    for offset in expected_offsets:
        index = center + int(offset)
        pair.append(values[index] if 0 <= index < len(values) else None)
    cross = transverse_samples
    if cross is None:
        cross = values[max(0, center - 5):min(len(values), center + 6)]
    live = _median(cross)
    prior = predrop_samples if predrop_samples is not None else values[:center]
    predrop = _median(_valid(prior))
    if terrain_samples is None:
        terrain_samples = values[:max(0, center + lo)] + values[min(len(values), center + hi + 1):]
    terrain = _median(_valid(terrain_samples))
    refs = (live, predrop)
    selector = reference if reference is not None else reference_selector
    if selector not in ("auto", "live", "predrop"):
        raise ValueError("reference_selector must be auto, live, or predrop")
    if selector == "live":
        chosen = live
        source = "live"
    elif selector == "predrop":
        chosen = predrop
        source = "predrop"
    else:
        chosen = live or predrop
        source = "live" if live is not None else "predrop"
    if chosen is None or terrain is None or any(_rgb(x) is None for x in pair):
        return {"method": "A", "classification": "UNKNOWN", "quality": "invalid",
                "live_reference": live, "predrop_reference": predrop, "terrain_reference": terrain,
                "margins": [], "source": source, "pair": pair}
    margins = [_margin(x, chosen, terrain) for x in pair]
    if any(x is None for x in margins) or max(rgb_distance(chosen, terrain), 0) <= 0:
        label = "UNKNOWN"
    elif all(x > margin for x in margins):
        label = "RIBBON"
    elif all(x < -margin for x in margins):
        label = "TERRAIN"
    elif any(abs(x) <= margin for x in margins):
        label = "UNKNOWN"
    else:
        label = "EDGE"
    return {"method": "A", "classification": label, "quality": "ok" if label != "UNKNOWN" else "ambiguous",
            "live_reference": live, "predrop_reference": predrop, "terrain_reference": terrain,
            "margins": margins, "source": source, "pair": pair}


def _prefix_stats(values):
    sums = [[0.0, 0.0, 0.0]]
    squares = [0.0]
    for x in values:
        sums.append([sums[-1][i] + x[i] for i in range(3)])
        squares.append(squares[-1] + sum(v * v for v in x))
    return sums, squares


def _segment_stats(sums, squares, start, end):
    count = end - start
    if count <= 0:
        return None
    total = [sums[end][i] - sums[start][i] for i in range(3)]
    mean = tuple(v / count for v in total)
    sse = squares[end] - squares[start] - sum(v * v for v in total) / count
    return mean, max(0.0, sse)


def method_b(samples, window=None, min_width=1, contrast=1.0, expand=True):
    """Fit two unconstrained integer transitions and classify the profile."""
    all_values = [_rgb(x) for x in samples or []]
    if any(x is None for x in all_values):
        return {"method": "B", "classification": "UNKNOWN", "quality": "invalid", "edges": None}
    n = len(all_values)
    if n < 3:
        return {"method": "B", "classification": "UNKNOWN", "quality": "invalid", "edges": None}
    if window is None:
        start, stop = 0, n
    else:
        start, stop = max(0, int(window[0])), min(n, int(window[1]))
    sums, squares = _prefix_stats(all_values)
    def search(s, e):
        best = None
        for a in range(s + 1, e - 1):
            for b in range(a + min_width, e):
                left = _segment_stats(sums, squares, s, a)
                inside = _segment_stats(sums, squares, a, b)
                right = _segment_stats(sums, squares, b, e)
                if left is not None and inside is not None and right is not None:
                    sse = left[1] + inside[1] + right[1]
                    if best is None or sse < best[0]:
                        best = (sse, a, b, (left[0], inside[0], right[0]))
        return best
    best = search(start, stop)
    touched = best is None or best[1] == start + 1 or best[2] == stop - 1
    if touched and expand and (start != 0 or stop != n):
        best = search(0, n)
        start, stop = 0, n
        touched = best is None or best[1] == 1 or best[2] == n - 1
    if best is None or touched:
        return {"method": "B", "classification": "UNKNOWN", "quality": "window_failure", "edges": None}
    sse, a, b, means = best
    separation = min(rgb_distance(means[1], means[0]), rgb_distance(means[1], means[2]))
    if separation < contrast:
        return {"method": "B", "classification": "UNKNOWN", "quality": "contrast_failure",
                "edges": (a, b), "residual_sse": sse, "separation": separation, "means": means}
    left_delta = tuple(means[1][i] - means[0][i] for i in range(3))
    right_delta = tuple(means[1][i] - means[2][i] for i in range(3))
    polarity = sum(left_delta[i] * right_delta[i] for i in range(3))
    if polarity <= 0:
        return {"method": "B", "classification": "UNKNOWN", "quality": "gradient_failure",
                "edges": (a, b), "residual_sse": sse, "separation": separation, "means": means}
    return {"method": "B", "classification": "RIBBON", "quality": "ok", "edges": (a, b),
            "residual_sse": sse, "separation": separation, "means": means,
            "left_flank": means[0], "interior": means[1], "right_flank": means[2]}


classify_method_a = method_a
classify_method_b = method_b
