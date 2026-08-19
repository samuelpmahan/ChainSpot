"""Dump a full NuThing P1 evidence trace as JSON for Python<->TS parity checking.

Wraps scripts/nuthing-p1-canonical.py (the executable reference) without
modifying its behavior. Also dumps the decoded raster as raw RGBA so the
TypeScript port can be fed bit-identical input (removes image-decoder variance
from the parity question; TS PNG decoding is verified separately against the
dumped RGBA hash).

Usage:
    python3 scripts/nuthing/p1_trace.py IMAGE OUT_DIR [--name NAME]

Writes:
    OUT_DIR/NAME.rgba.bin   raw RGBA bytes prefixed by 16-byte header
                            (magic 'NUP1', u32le width, u32le height, u32le 0)
    OUT_DIR/NAME.trace.json full evidence trace
"""

import argparse
import hashlib
import importlib.util
import json
import os
import struct
import sys
import time

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_CANONICAL = os.path.join(_HERE, "..", "nuthing-p1-canonical.py")

spec = importlib.util.spec_from_file_location("nuthing_p1_canonical", _CANONICAL)
canonical = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canonical)


def component_row(c):
    return {
        "label": c.label,
        "cx": c.cx,
        "cy": c.cy,
        "area": c.area,
        "bbox": [c.bbox_x, c.bbox_y, c.bbox_w, c.bbox_h],
        "major": c.major,
        "minor": c.minor,
        "angle": c.angle,
        "fill": c.fill,
    }


def labels_of(components):
    return [c.label for c in components]


def mask_rows(mask):
    return ["".join("1" if v else "0" for v in row) for row in mask]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("out_dir")
    parser.add_argument("--name", default=None)
    args = parser.parse_args()

    name = args.name or os.path.splitext(os.path.basename(args.image))[0]
    os.makedirs(args.out_dir, exist_ok=True)

    t0 = time.perf_counter()
    result = canonical.run_nuthing_p1(args.image)
    elapsed = time.perf_counter() - t0

    rgb = result["image"]
    h, w = rgb.shape[:2]
    rgba = np.dstack([rgb, np.full((h, w), 255, dtype=np.uint8)])
    rgba_bytes = rgba.tobytes()

    bin_path = os.path.join(args.out_dir, f"{name}.rgba.bin")
    with open(bin_path, "wb") as f:
        f.write(b"NUP1" + struct.pack("<III", w, h, 0))
        f.write(rgba_bytes)

    trace = {
        "name": name,
        "source_image": os.path.abspath(args.image),
        "source_sha256": hashlib.sha256(open(args.image, "rb").read()).hexdigest(),
        "width": w,
        "height": h,
        "rgba_sha256": hashlib.sha256(rgba_bytes).hexdigest(),
        "runtime_seconds": elapsed,
        "bright_mask_sha256": hashlib.sha256(result["bright_mask"].tobytes()).hexdigest(),
        "dark_mask_sha256": hashlib.sha256(result["dark_mask"].tobytes()).hexdigest(),
        "bright_pixel_count": int(result["bright_mask"].sum()),
        "dark_pixel_count": int(result["dark_mask"].sum()),
        "bright_components": [component_row(c) for c in result["bright_components"]],
        "dark_components": [component_row(c) for c in result["dark_components"]],
        "badge_labels": labels_of(result["badges"]),
        "badge_count": result["badge_count"],
        "basket_labels": labels_of(result["baskets"]),
        "remaining_bright_labels": labels_of(result["remaining_bright"]),
        "tee_modal_labels": labels_of(result["tee_modal_family"]),
        "tee_modal_major": result["tee_modal_major"],
        "tee_modal_minor": result["tee_modal_minor"],
        "tee_seed_labels": labels_of(result["tee_seeds"]),
        "tee_border_template": mask_rows(result["tee_border_template"]),
        "tee_ranked": [
            {
                "label": r["component"].label,
                "score": r["score"],
                "explained": r["explained"],
                "coverage": r["coverage"],
                "dx": r["dx"],
                "dy": r["dy"],
            }
            for r in result["tee_ranked"]
        ],
        "tee_primary_labels": [r["component"].label for r in result["tee_primary"]],
        "tee_secondary_A_labels": [r["component"].label for r in result["tee_secondary_A"]],
        "tee_culled_A_labels": [r["component"].label for r in result["tee_culled_A"]],
        "tee_secondary_B_labels": [r["component"].label for r in result["tee_secondary_B"]],
        "tee_culled_B_labels": [r["component"].label for r in result["tee_culled_B"]],
    }

    trace_path = os.path.join(args.out_dir, f"{name}.trace.json")
    with open(trace_path, "w") as f:
        json.dump(trace, f)

    print(f"{name}: {w}x{h} bright={len(result['bright_components'])} "
          f"badges={result['badge_count']} ranked={len(result['tee_ranked'])} "
          f"runtime={elapsed:.2f}s -> {trace_path}")


if __name__ == "__main__":
    main()
