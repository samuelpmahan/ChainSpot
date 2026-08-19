#!/usr/bin/env python3
"""Deterministic synthetic digit-sample generator for NuThing P2.

Renders digits 0-9 with locally available BOLD sans TrueType fonts, applies a
range of classical-image-processing variations (subpixel translation,
binarization threshold jitter, morphological erosion/dilation, gaussian
blur, JPEG round-trip degradation, small rotation, partial obstruction),
thresholds to a binary mask, tight-crops to the digit's bounding box, and
writes:

  - one PNG per sample under OUT_DIR (binary mask, 0/255, matching the
    glyphMask convention used for real badge crops: 255 = bright digit pixel)
  - one JSON index (OUT_DIR/index.json) listing every sample and the exact
    parameters used to generate it.

Determinism: all randomness is drawn from a single numpy.random.RandomState
seeded with a fixed constant (SEED below). No wall-clock time, OS entropy,
or unordered-container iteration feeds into sample generation, so running
this script twice produces byte-identical PNGs and an identical index.json.

This script does NOT do the canonical DIGIT_W x DIGIT_H normalization -- that
step lives in src/lib/nuthing/digits/normalize.ts and is applied afterwards
by scripts/nuthing/normalize-synthetic.ts so every sample (real or
synthetic) goes through the same normalization code path.

Usage:
    python3 scripts/nuthing/synthesize-digits.py
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------------------
# Configuration (calibrated from measured real-badge glyph stats -- see
# docs/nuthing-p2/synthetic-augmentation.md for the full measurement writeup)
# ---------------------------------------------------------------------------

SEED = 20260819  # fixed constant; do not derive from wall-clock time
SAMPLES_PER_DIGIT = 250
DIGITS = [str(d) for d in range(10)]

OUT_DIR = Path("/workspace/nuthing-work/digits/synthetic-raw")

# Supersample factor: render/scale digits at this multiple of the target
# physical pixel height before downsampling, for realistic antialiasing.
SS = 4

# Reference point size used to render each font's tight glyph bitmap before
# it gets rescaled to the per-sample target height. Large so the initial
# render is high fidelity; the actual final size is controlled entirely by
# the later resize step, not by re-rendering the font at different sizes.
REF_PT = 200

# Measured real-badge glyph height (cv2 connectedComponentsWithStats over 188
# badges / 283 digit components): height is essentially fixed at 21px in
# every sample (min=p10=median=mean=p90=max=21.0). We still sample a small
# spread around that fixed value so the synthetic set covers plausible
# scale jitter a classifier might see from crop/scale-pipeline drift,
# without drifting far from what was actually measured.
HEIGHT_PX_RANGE = (18.0, 24.0)

ROTATION_DEG_RANGE = (-2.0, 2.0)  # real badges are screen-aligned
SUBPIXEL_RANGE = (-0.5, 0.5)  # translation in *final* low-res pixel units
BLUR_SIGMA_RANGE = (0.0, 0.8)
# Grayscale (0-255) binarization threshold range, centered near the AA
# midpoint (128) to sample the boundary the way JPEG/blur artifacts would
# shift it in real captures.
THRESHOLD_RANGE = (90.0, 165.0)

JPEG_PROB = 0.35
JPEG_QUALITY_RANGE = (40, 90)  # inclusive

MORPH_PROBS = {"none": 0.60, "erode": 0.20, "dilate": 0.20}

OBSTRUCTION_PROB = 0.15
OBSTRUCTION_MAX_COVERAGE = 0.20  # up to 20% of glyph pixels

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]


# ---------------------------------------------------------------------------
# Font glyph rendering
# ---------------------------------------------------------------------------


def render_ref_glyph(font: ImageFont.FreeTypeFont, digit: str) -> Image.Image:
    """Render `digit` at REF_PT and tight-crop to its ink bounding box.

    Returns a grayscale ("L") image: 255 = ink, 0 = background.
    """
    # Generous canvas so nothing clips at REF_PT.
    canvas_size = int(REF_PT * 2.2)
    img = Image.new("L", (canvas_size, canvas_size), 0)
    draw = ImageDraw.Draw(img)
    draw.text((canvas_size * 0.1, canvas_size * 0.1), digit, fill=255, font=font)
    bbox = img.getbbox()
    if bbox is None:
        raise RuntimeError(f"font produced empty glyph for digit {digit!r}")
    return img.crop(bbox)


def build_font_cache() -> list[tuple[str, dict[str, Image.Image]]]:
    cache: list[tuple[str, dict[str, Image.Image]]] = []
    for path in FONT_PATHS:
        font = ImageFont.truetype(path, REF_PT)
        per_digit = {d: render_ref_glyph(font, d) for d in DIGITS}
        cache.append((Path(path).name, per_digit))
    return cache


# ---------------------------------------------------------------------------
# Per-sample synthesis pipeline
# ---------------------------------------------------------------------------


def synthesize_one(
    rs: np.random.RandomState,
    digit: str,
    font_cache: list[tuple[str, dict[str, Image.Image]]],
) -> tuple[np.ndarray, dict]:
    """Produce one binary mask (0/255 uint8, 2D) plus its param log."""

    # --- draw all params up front, in a fixed order, from the single RNG ---
    font_idx = int(rs.randint(0, len(font_cache)))
    font_name, per_digit = font_cache[font_idx]
    ref_glyph = per_digit[digit]

    height_px = float(rs.uniform(*HEIGHT_PX_RANGE))
    dx = float(rs.uniform(*SUBPIXEL_RANGE))
    dy = float(rs.uniform(*SUBPIXEL_RANGE))
    rotation_deg = float(rs.uniform(*ROTATION_DEG_RANGE))
    blur_sigma = float(rs.uniform(*BLUR_SIGMA_RANGE))
    threshold = float(rs.uniform(*THRESHOLD_RANGE))
    morph_choice = str(
        rs.choice(list(MORPH_PROBS.keys()), p=list(MORPH_PROBS.values()))
    )
    do_jpeg = bool(rs.random_sample() < JPEG_PROB)
    jpeg_quality = (
        int(rs.randint(JPEG_QUALITY_RANGE[0], JPEG_QUALITY_RANGE[1] + 1))
        if do_jpeg
        else None
    )
    do_obstruction = bool(rs.random_sample() < OBSTRUCTION_PROB)
    # Obstruction geometry params (drawn even if unused, to keep the RNG
    # draw sequence identical across runs regardless of branch taken).
    obstruction_kind = str(rs.choice(["line", "rect"]))
    obstruction_t = float(rs.uniform(0.0, 1.0))  # position along glyph, 0..1
    obstruction_angle = float(rs.uniform(0, 180))  # degrees, for line
    obstruction_thickness = float(rs.uniform(1.0, 3.0))

    # --- scale reference glyph to target supersampled size ---
    scale_factor = (height_px * SS) / ref_glyph.height
    new_w = max(1, round(ref_glyph.width * scale_factor))
    new_h = max(1, round(ref_glyph.height * scale_factor))
    hi = ref_glyph.resize((new_w, new_h), Image.LANCZOS)

    # --- rotation (screen-aligned badges -> small angle only) ---
    if abs(rotation_deg) > 1e-6:
        hi = hi.rotate(
            rotation_deg,
            resample=Image.BICUBIC,
            expand=True,
            fillcolor=0,
        )

    # --- subpixel translation: shift by a fractional low-res pixel, which
    # becomes an integer offset once expressed in supersampled pixels ---
    pad = SS * 2
    canvas_w = hi.width + pad * 2
    canvas_h = hi.height + pad * 2
    canvas = Image.new("L", (canvas_w, canvas_h), 0)
    off_x = pad + int(round(dx * SS))
    off_y = pad + int(round(dy * SS))
    canvas.paste(hi, (off_x, off_y))

    # --- downsample to final physical scale ---
    final_w = max(1, round(canvas_w / SS))
    final_h = max(1, round(canvas_h / SS))
    low = canvas.resize((final_w, final_h), Image.LANCZOS)

    # --- gaussian blur ---
    if blur_sigma > 1e-6:
        low = low.filter(ImageFilter.GaussianBlur(radius=blur_sigma))

    # --- JPEG round-trip degradation ---
    if do_jpeg:
        buf = io.BytesIO()
        low.save(buf, format="JPEG", quality=jpeg_quality)
        buf.seek(0)
        low = Image.open(buf).convert("L")
        low.load()

    gray = np.array(low, dtype=np.uint8)

    # --- binarize ---
    binary = (gray >= threshold).astype(np.uint8)

    # --- morphology ---
    if morph_choice != "none" and binary.any():
        kernel = np.ones((3, 3), np.uint8)
        if morph_choice == "erode":
            eroded = cv2.erode(binary, kernel, iterations=1)
            # never erode a glyph down to nothing
            if eroded.any():
                binary = eroded
        elif morph_choice == "dilate":
            binary = cv2.dilate(binary, kernel, iterations=1)

    # --- partial obstruction (minority of samples): zero out up to
    # OBSTRUCTION_MAX_COVERAGE of the currently-set glyph pixels with a
    # line or rectangle, simulating a rendered course path crossing the
    # badge ---
    applied_obstruction = None
    if do_obstruction and binary.any():
        binary, applied_obstruction = apply_obstruction(
            binary,
            kind=obstruction_kind,
            t=obstruction_t,
            angle_deg=obstruction_angle,
            thickness=obstruction_thickness,
        )

    # --- safety net: never emit a fully empty mask. Fall back to the
    # pre-morph/pre-obstruction binarization at the sampled threshold. ---
    if not binary.any():
        binary = (gray >= threshold).astype(np.uint8)

    params = {
        "font": font_name,
        "heightPx": round(height_px, 4),
        "translation": {"dx": round(dx, 4), "dy": round(dy, 4)},
        "threshold": round(threshold, 4),
        "morph": morph_choice,
        "blurSigma": round(blur_sigma, 4),
        "jpegQuality": jpeg_quality,
        "rotationDeg": round(rotation_deg, 4),
        "obstruction": applied_obstruction,
    }
    return binary, params


def apply_obstruction(
    binary: np.ndarray,
    kind: str,
    t: float,
    angle_deg: float,
    thickness: float,
) -> tuple[np.ndarray, dict]:
    """Overlay a background-colored line/rect over <=OBSTRUCTION_MAX_COVERAGE
    of the glyph's foreground pixels, deterministically (no extra RNG draws;
    geometry only backs off via a fixed shrink schedule, not resampling)."""
    h, w = binary.shape
    original_count = int(binary.sum())
    ys, xs = np.nonzero(binary)
    cy = float(ys.mean())
    cx = float(xs.mean())

    # Shrink schedule: try decreasing extents until under the coverage cap.
    for shrink in (1.0, 0.75, 0.5, 0.35, 0.2, 0.1, 0.05):
        overlay = np.zeros_like(binary)
        if kind == "line":
            length = max(w, h) * 1.4 * shrink
            ang = np.deg2rad(angle_deg)
            dx_ = np.cos(ang) * length / 2
            dy_ = np.sin(ang) * length / 2
            # position the line's midpoint near the glyph center, offset by t
            mid_x = cx + (t - 0.5) * w * 0.6
            mid_y = cy + (t - 0.5) * h * 0.6
            p1 = (int(round(mid_x - dx_)), int(round(mid_y - dy_)))
            p2 = (int(round(mid_x + dx_)), int(round(mid_y + dy_)))
            cv2.line(overlay, p1, p2, 1, thickness=max(1, int(round(thickness))))
        else:  # rect
            rw = max(1, int(round(w * 0.5 * shrink)))
            rh = max(1, int(round(h * 0.3 * shrink)))
            x0 = int(round(cx - rw / 2 + (t - 0.5) * w * 0.3))
            y0 = int(round(cy - rh / 2 + (t - 0.5) * h * 0.3))
            cv2.rectangle(overlay, (x0, y0), (x0 + rw, y0 + rh), 1, thickness=-1)

        candidate = binary & (1 - overlay)
        removed = original_count - int(candidate.sum())
        coverage = removed / original_count if original_count else 0.0
        if coverage <= OBSTRUCTION_MAX_COVERAGE and candidate.any():
            return candidate, {
                "kind": kind,
                "coverage": round(coverage, 4),
                "angleDeg": round(angle_deg, 2) if kind == "line" else None,
                "thickness": round(thickness, 2),
            }
    # If even the smallest shrink still exceeds the cap (very small glyph),
    # skip obstruction rather than risk erasing the glyph.
    return binary, None


def tight_crop(binary: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(binary)
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    return binary[y0 : y1 + 1, x0 : x1 + 1]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Clear any stale PNGs from a prior run so the directory exactly
    # reflects this run's output (index.json is fully rewritten below).
    for existing in OUT_DIR.glob("*.png"):
        existing.unlink()

    font_cache = build_font_cache()
    print(f"Loaded {len(font_cache)} fonts: {[n for n, _ in font_cache]}")

    rs = np.random.RandomState(SEED)

    index: list[dict] = []
    sample_num = 0
    for digit in DIGITS:
        for i in range(SAMPLES_PER_DIGIT):
            binary, params = synthesize_one(rs, digit, font_cache)
            cropped = tight_crop(binary)
            mask_255 = (cropped * 255).astype(np.uint8)

            fname = f"d{digit}_{i:04d}.png"
            out_path = OUT_DIR / fname
            Image.fromarray(mask_255, mode="L").save(out_path)

            entry = {
                "file": fname,
                "digit": digit,
                "sampleIndex": i,
                "width": int(mask_255.shape[1]),
                "height": int(mask_255.shape[0]),
                **params,
            }
            index.append(entry)
            sample_num += 1

    index_path = OUT_DIR / "index.json"
    with open(index_path, "w") as f:
        json.dump(
            {
                "generator": "scripts/nuthing/synthesize-digits.py",
                "seed": SEED,
                "samplesPerDigit": SAMPLES_PER_DIGIT,
                "totalSamples": len(index),
                "fonts": [n for n, _ in font_cache],
                "samples": index,
            },
            f,
            indent=1,
        )
        f.write("\n")

    print(f"Wrote {sample_num} samples + index to {OUT_DIR}")


if __name__ == "__main__":
    main()
