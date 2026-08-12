#!/usr/bin/env python3
"""Regenerate the walking-path pixel annotation for IMG_5612.png.

Produces the fixture pair consumed by walking_path_benchmark.py:

  resources/walking-path/IMG_5612-walking-path-labels.png
      Paletted PNG, same size as the source image.
      0 = background, 1 = walking-path pixel, 2 = ignore (boundary ring).
  resources/walking-path/IMG_5612-walking-path-regions.json
      Disjoint spatial region boxes (A..F) covering every labeled path
      pixel, plus the train/test split used for held-out evaluation.

Provenance / honesty note
-------------------------
The path mask was bootstrapped with a color heuristic
(min(R-G, B-G) > 25 selects the saturated purple stroke casing), then
morphologically closed to swallow the stroke's near-white core, cleaned of
tiny blobs, and small interior holes were filled. The result was verified
*visually* against the source image (full-image and zoomed crops): it covers
exactly the visible walking path and nothing else, and correctly excludes UI
glyphs (hole badge, droplet markers) that overlay the path. The ground truth
is therefore "the visible purple stroke", independent of how it was seeded --
but be aware that the benchmark's fixed purple-delta rule is, by
construction, close to the seed rule. See walking-path-findings.md.

A 3px ignore ring around the stroke (label 2) excludes anti-aliased boundary
pixels from train/eval. To add or fix labels by hand, edit the label PNG
with any editor (paint index 1/0/2) -- or adjust the heuristic here and
re-verify visually.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "resources/ThrownRounds/IMG_5612.png"
OUT_DIR = REPO / "resources/walking-path"
LABELS_PNG = OUT_DIR / "IMG_5612-walking-path-labels.png"
REGIONS_JSON = OUT_DIR / "IMG_5612-walking-path-regions.json"

# Disjoint [x0, y0, x1, y1) boxes covering every path pixel. The split keeps
# varied terrain on both sides (green putting circles, brown grass, dark
# scrub, translucent fairway ribbon, blue shot lines, white UI elements).
REGIONS = {
    "A": [60, 1110, 620, 1300],   # top-left run + droplet connector
    "B": [40, 1300, 220, 1490],   # left vertical over brown grass
    "C": [40, 1490, 600, 1640],   # bottom run (scrub, blue line, badge 2)
    "D": [620, 1020, 1290, 1180], # top loop + zigzag to tee (ribbon/gray)
    "E": [620, 1180, 1150, 1445], # mid strand + vertical over green circle
    "F": [600, 1445, 1000, 1620], # bottom strand (scrub, blue line, icons)
}
SPLIT = {"train": ["A", "B", "D"], "test": ["C", "E", "F"]}


def build_mask(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    im = rgb.astype(float)
    # Purple stroke casing: red and blue both clearly above green.
    purple = np.minimum(im[:, :, 0] - im[:, :, 1], im[:, :, 2] - im[:, :, 1]) > 25

    yy, xx = np.mgrid[-6:7, -6:7]
    disk6 = (xx * xx + yy * yy) <= 36
    mask = ndi.binary_closing(purple, structure=disk6)  # swallow white core
    mask = ndi.binary_opening(mask, np.ones((3, 3)))

    lab, _ = ndi.label(mask)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    mask = sizes[lab] >= 200  # drop tiny isolated blobs

    # Fill small interior holes (<150 px): unclosed specks of the light core.
    # Large holes are kept: they are UI glyphs drawn on top of the path.
    holes = ndi.binary_fill_holes(mask) & ~mask
    hl, _ = ndi.label(holes)
    hs = np.bincount(hl.ravel())
    hs[0] = 0
    mask |= (hs[hl] > 0) & (hs[hl] < 150)

    ignore = ndi.binary_dilation(mask, np.ones((7, 7))) & ~mask
    return mask, ignore


def main() -> None:
    rgb = np.asarray(Image.open(SOURCE).convert("RGB"))
    mask, ignore = build_mask(rgb)

    inbox = np.zeros(mask.shape, bool)
    for x0, y0, x1, y1 in REGIONS.values():
        inbox[y0:y1, x0:x1] = True
    stray = int((mask & ~inbox).sum())
    if stray:
        raise SystemExit(f"{stray} path pixels fall outside the region boxes")

    labels = np.zeros(mask.shape, np.uint8)
    labels[ignore] = 2
    labels[mask] = 1
    out = Image.fromarray(labels, mode="P")
    out.putpalette([0, 0, 0, 230, 60, 200, 128, 128, 128] + [0] * 759)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.save(LABELS_PNG, optimize=True)

    REGIONS_JSON.write_text(json.dumps({
        "schemaVersion": 1,
        "coordinateSpace": "source-image-px",
        "source": {
            "fileName": SOURCE.name,
            "widthPx": rgb.shape[1],
            "heightPx": rgb.shape[0],
        },
        "labels": {"background": 0, "walkingPath": 1, "ignore": 2},
        "regions": REGIONS,
        "split": SPLIT,
    }, indent=2) + "\n")

    print(f"wrote {LABELS_PNG} ({int(mask.sum())} path px, "
          f"{int(ignore.sum())} ignore px)")
    print(f"wrote {REGIONS_JSON}")


if __name__ == "__main__":
    main()
