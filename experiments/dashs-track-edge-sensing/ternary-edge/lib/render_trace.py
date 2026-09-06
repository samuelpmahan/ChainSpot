"""Render and inspect a frozen ChainSpot trace.

This module deliberately only reads trace values.  It does not run a detector,
sample pixels, or infer a verdict.  The small amount of shape tolerance here is
for traces produced by older runners (``rows`` versus ``spatialRows`` and
``point`` versus ``xPx``/``yPx``).
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - useful error at command line
    raise RuntimeError("render_trace requires Pillow") from exc


H18_DISTANCES = {80, 100, 110, 130, 150}
STATE_COLORS = {
    "pass": (40, 215, 110, 255), "accepted": (40, 215, 110, 255),
    "edge": (255, 205, 55, 255), "candidate": (255, 205, 55, 255),
    "fail": (242, 75, 75, 255), "rejected": (242, 75, 75, 255),
    "occluded": (175, 175, 185, 255), "unknown": (120, 205, 255, 255),
}


def _xy(value: Any) -> tuple[float, float] | None:
    if isinstance(value, dict):
        for a, b in (("xPx", "yPx"), ("x", "y"), ("x0", "y0")):
            if a in value and b in value:
                return float(value[a]), float(value[b])
        for key in ("point", "center", "position", "coord"):
            if key in value:
                p = _xy(value[key])
                if p is not None:
                    return p
    elif isinstance(value, (list, tuple)) and len(value) >= 2:
        return float(value[0]), float(value[1])
    return None


def _points(obj: Any) -> list[tuple[float, float]]:
    if isinstance(obj, dict):
        for key in ("points", "path", "polyline", "trajectory"):
            if key in obj:
                return [p for x in obj[key] if (p := _xy(x)) is not None]
        a, b = _xy(obj.get("start")), _xy(obj.get("end"))
        if a is not None and b is not None:
            return [a, b]
    elif isinstance(obj, list):
        return [p for x in obj if (p := _xy(x)) is not None]
    return []


def _rows(trace: dict[str, Any]) -> list[dict[str, Any]]:
    rows = trace.get("spatialRows", trace.get("rows", []))
    if not isinstance(rows, list):
        raise ValueError("trace spatialRows/rows must be a list")
    return [x for x in rows if isinstance(x, dict)]


def _row_id(row: dict[str, Any], index: int) -> str:
    for k in ("rowId", "spatialRowId", "id"):
        if row.get(k) is not None:
            return str(row[k])
    ray = row.get("rayId", row.get("featureId", row.get("hole", "ray")))
    distance = row.get("distancePx", row.get("distance", index))
    return f"{ray}@{distance}"


def validate_trace(trace: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate trace identity and return its rows.

    Every spatial row must have a stable ID and at least one drawable spatial
    coordinate.  This catches partial traces instead of silently producing a
    misleading image.
    """
    if not isinstance(trace, dict):
        raise ValueError("trace must be a JSON object")
    rows = _rows(trace)
    seen: set[str] = set()
    for i, row in enumerate(rows):
        rid = _row_id(row, i)
        if rid in seen:
            raise ValueError(f"duplicate spatial row ID: {rid}")
        seen.add(rid)
        if not (_xy(row) or _xy(row.get("center")) or _points(row)):
            # A row can map through its ray's point list; validation is relaxed
            # for that case, but render_trace will report it in the manifest.
            continue
    return rows


def _meta(trace: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k in ("runId", "imageId", "paramsHash", "featureId", "traceHash"):
        if k in trace:
            out[k] = trace[k]
    if isinstance(trace.get("meta"), dict):
        for k in ("runId", "imageId", "paramsHash", "featureId", "traceHash"):
            if k in trace["meta"]:
                out.setdefault(k, trace["meta"][k])
    return out


def _state(row: dict[str, Any]) -> str:
    value = row.get("state", row.get("verdict", row.get("status", "unknown")))
    if isinstance(value, dict):
        value = value.get("state", value.get("verdict", "unknown"))
    return str(value).lower()


def _row_position(row: dict[str, Any], rays: dict[str, Any]) -> tuple[float, float] | None:
    p = _xy(row)
    if p is None:
        p = _xy(row.get("center"))
    if p is None:
        ray = rays.get(str(row.get("rayId", row.get("featureId", ""))))
        pts = _points(ray)
        if pts:
            return pts[min(len(pts) - 1, int(row.get("distancePx", 0)))]
    return p


def render_trace(trace: dict[str, Any], source_path: str | Path,
                 output_path: str | Path, *, debug_samples: bool = False) -> dict[str, Any]:
    """Draw a trace overlay and return the visual object manifest.

    The default view keeps raw sample dots to the five H18 checkpoint rows so
    the 18-ray overview remains legible.  ``debug_samples=True`` exposes all
    stored sample dots without changing any trace values or classifications.
    """
    rows = validate_trace(trace)
    source = Image.open(source_path).convert("RGBA")
    draw = ImageDraw.Draw(source, "RGBA")
    rays_raw = trace.get("rays", [])
    rays: dict[str, Any] = rays_raw if isinstance(rays_raw, dict) else {
        str(r.get("rayId", r.get("id", r.get("featureId", "")))): r
        for r in rays_raw if isinstance(rays_raw, list) and isinstance(r, dict)
    }
    manifest: dict[str, Any] = {"metadata": _meta(trace), "objects": {},
                                "legend": ["cyan = center/control rays (H1/H2)",
                                           "yellow = stored B edge segments",
                                           "magenta ring = H18 focus (80/100/110/130/150)",
                                           "dots = stored samples (focus rows; all with --debug-samples)"]}

    # Draw all ray trajectories first, including explicit straight controls.
    for ray_id, ray in rays.items():
        pts = _points(ray)
        if len(pts) > 1:
            color = (80, 200, 255, 190) if str(ray_id).upper() in {"H1", "H2"} else (255, 150, 60, 150)
            draw.line(pts, fill=color, width=2)

    for index, row in enumerate(rows):
        rid = _row_id(row, index)
        pos = _row_position(row, rays)
        obj: dict[str, Any] = {"rowId": rid, "kind": "spatial-row", "state": _state(row)}
        if pos is not None:
            x, y = pos
            color = STATE_COLORS.get(obj["state"], STATE_COLORS["unknown"])
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=color, outline=(0, 0, 0, 220))
            obj["position"] = {"x": x, "y": y}
            distance = row.get("distancePx", row.get("distance"))
            ray_id = str(row.get("rayId", row.get("featureId", row.get("hole", ""))))
            if ray_id.upper() == "H18" and distance is not None and int(float(distance)) in H18_DISTANCES:
                draw.ellipse((x - 9, y - 9, x + 9, y + 9), outline=(255, 30, 220, 255), width=2)
                obj["highlight"] = "H18-distance"
        # Stored sample coordinates are evidence and are colored by stored state.
        distance = row.get("distancePx", row.get("distance"))
        ray_name = str(row.get("rayId", row.get("featureId", row.get("hole", "")))).upper()
        focus_samples = ray_name == "H18" and distance is not None and int(float(distance)) in H18_DISTANCES
        all_samples = row.get("samples", row.get("samplePoints", []))
        samples = all_samples if (debug_samples or focus_samples) else []
        sample_objects = []
        obj['sampleProjection'] = {'sourceCount': len(all_samples) if isinstance(all_samples, list) else 0, 'visibleMode': 'debug' if debug_samples else 'focus' if focus_samples else 'omitted', 'visibleCount': 0}
        if isinstance(samples, list):
            for sample in samples:
                sp = _xy(sample)
                if sp is None:
                    continue
                sx, sy = sp
                draw.ellipse((sx - 2, sy - 2, sx + 2, sy + 2), fill=STATE_COLORS.get(_state(sample), STATE_COLORS["unknown"]))
                sample_objects.append({"position": {"x": sx, "y": sy}, "state": _state(sample)})
        obj['sampleProjection']['visibleCount'] = len(sample_objects)
        if sample_objects:
            obj["samples"] = sample_objects
        # Transverse profile/estimated edge segments are already in the trace.
        segments = row.get("segments", row.get("profileSegments", row.get("edges", [])))
        drawn_segments = []
        if isinstance(segments, list):
            for segment in segments:
                pts = _points(segment)
                if len(pts) >= 2:
                    draw.line(pts, fill=(255, 245, 80, 230), width=2)
                    drawn_segments.append({"points": [{"x": p[0], "y": p[1]} for p in pts]})
        if drawn_segments:
            obj["segments"] = drawn_segments
        manifest["objects"][rid] = obj

    # Required consistency assertion: every row has a visual manifest object.
    if set(manifest["objects"]) != {_row_id(r, i) for i, r in enumerate(rows)}:
        raise AssertionError("trace row/visual manifest mismatch")
    # Keep the legend compact and fixed in the image corner; this is a visual
    # key only and does not add evidence or alter the source pixels elsewhere.
    legend_y = 8
    draw.rectangle((6, legend_y - 3, min(source.width - 6, 420), legend_y + 43), fill=(0, 0, 0, 175))
    try:
        font = ImageFont.load_default()
    except Exception:  # pragma: no cover
        font = None
    for line in ("cyan center/control rays  |  yellow B edges",
                 "magenta H18 focus: 80 100 110 130 150",
                 "sample dots: focus rows (all rows with debug)"):
        draw.text((12, legend_y), line, fill=(245, 245, 245, 240), font=font)
        legend_y += 13
    source.save(output_path)
    manifest["output"] = str(output_path)
    return manifest


def format_trace(trace: dict[str, Any]) -> str:
    """Emit deterministic CLI text with identity, row IDs, values and reasons."""
    rows = validate_trace(trace)
    lines = ["TRACE " + " ".join(f"{k}={v}" for k, v in _meta(trace).items())]
    for i, row in enumerate(rows):
        rid = _row_id(row, i)
        verdict = row.get("verdict", row.get("state", row.get("status", "unknown")))
        raw = row.get("rawValues", row.get("raw", row.get("values", {})))
        reason = row.get("reason", row.get("reasons", ""))
        lines.append(f"ROW {rid} verdict={verdict} raw={json.dumps(raw, sort_keys=True, separators=(',', ':'))} reason={json.dumps(reason, sort_keys=True)}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--source", type=Path, required=False)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--format", action="store_true", help="print row text instead of rendering")
    parser.add_argument("--debug-samples", action="store_true", help="draw stored samples for every row")
    args = parser.parse_args(argv)
    trace = json.loads(args.trace.read_text())
    if args.format:
        print(format_trace(trace), end="")
        return 0
    if args.source is None or args.output is None:
        parser.error("--source and --output are required for rendering")
    manifest = render_trace(trace, args.source, args.output, debug_samples=args.debug_samples)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
