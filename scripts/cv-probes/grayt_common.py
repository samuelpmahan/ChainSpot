#!/usr/bin/env python3
"""Shared course discovery + badge/basket detection helpers for GRayT tuning.

Courses come in two flavors:
  - TUNABLE: a `.chainspot.zip` whose `project.json` carries truth
    (`holes[]` with `number`, `tee{xPx,yPx}`, `basket{xPx,yPx}`). These may
    be used to fit parameters (subject to the LOOCV protocol in
    grayt_tune.py -- never evaluate a course with parameters its own truth
    influenced).
  - OVERLAY-ONLY: a bare `.png`/`.jpg` capture with no truth. Never tuned
    on; the chain still runs (badge + basket from the production detector)
    and produces an overlay for human review plus consistency checks.

Badge (and, for overlay-only courses, basket) positions come from the real
production detector (`scripts/detect-course.ts`, i.e. `npx tsx ... --out
<dir>`), exactly mirroring what's available at inference time -- this
probe never uses truth badge/basket positions as fit input, only for
grading. Detector output is cached to disk keyed by (path, mtime, size) so
repeated tuning runs don't pay the ~15-20s/course detector cost more than
once.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Optional

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
DETECT_SCRIPT = REPO / "scripts" / "detect-course.ts"

GOLDEN_TEE_SET = REPO / "resources/GoldenTeeSet.chainspot.zip"
GOLDEN_BASKET_SET = REPO / "resources/GoldenBasketSet.chainspot.zip"
ALEX_CLARK_SET = REPO / "resources/AlexClarkSet.chainspot.zip"

# GoldenTeeSet.chainspot.zip's project.json carries tee truth only;
# GoldenBasketSet.chainspot.zip (same source image, verified by content
# hash) carries basket truth only for the same course. Merge them so
# GoldenTeeSet has complete per-hole truth like every other labeled course.
_GOLDEN_TRUTH_MERGE = {GOLDEN_TEE_SET: GOLDEN_BASKET_SET}

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg"}


@dataclass
class Course:
    name: str
    kind: str          # "tunable" | "overlay"
    path: Path
    # tunable only:
    truth: Optional[dict] = None    # {number: {"tee": (x,y), "basket": (x,y)}}


def discover_courses(input_dir: Optional[Path], extra_paths=()) -> "dict[str, Course]":
    """Scan input_dir (if it exists) for .chainspot.zip / bare image
    courses, always also including the two repo fixtures. extra_paths are
    additional explicit file paths (used when input_dir is empty/missing
    but a specific demonstration capture should still be exercised)."""
    courses: dict[str, Course] = {}

    def add(p: Path):
        p = Path(p)
        if not p.exists():
            return
        if p.name.endswith(".chainspot.zip"):
            name = p.name[: -len(".chainspot.zip")]
            truth = load_truth(p)
            companion = _GOLDEN_TRUTH_MERGE.get(p)
            if companion is not None and companion.exists():
                companion_truth = load_truth(companion)
                for n, holes in truth.items():
                    other = companion_truth.get(n, {})
                    if holes.get("tee") is None and other.get("tee") is not None:
                        holes["tee"] = other["tee"]
                    if holes.get("basket") is None and other.get("basket") is not None:
                        holes["basket"] = other["basket"]
            courses[name] = Course(name=name, kind="tunable", path=p, truth=truth)
        elif p.suffix.lower() in IMAGE_SUFFIXES:
            name = p.stem
            courses[name] = Course(name=name, kind="overlay", path=p)

    add(GOLDEN_TEE_SET)
    add(ALEX_CLARK_SET)

    if input_dir is not None and input_dir.exists():
        for p in sorted(input_dir.iterdir()):
            if p.is_file():
                add(p)

    for p in extra_paths:
        add(Path(p))

    return courses


def load_truth(zip_path: Path) -> dict:
    """{number: {"tee": (x,y), "basket": (x,y)}} from project.json."""
    with zipfile.ZipFile(zip_path) as z:
        proj = json.load(z.open("project.json"))
    out = {}
    for h in proj["holes"]:
        tee = h.get("tee")
        basket = h.get("basket")
        out[h["number"]] = dict(
            tee=(tee["xPx"], tee["yPx"]) if tee else None,
            basket=(basket["xPx"], basket["yPx"]) if basket else None,
        )
    return out


def load_course_image(course: Course) -> Image.Image:
    if course.path.name.endswith(".chainspot.zip"):
        with zipfile.ZipFile(course.path) as z:
            names = [n for n in z.namelist() if n.startswith("images/")]
            name = next((n for n in names if "source-original" in n), names[0])
            return Image.open(BytesIO(z.read(name))).convert("RGB")
    return Image.open(course.path).convert("RGB")


# ---------------------------------------------------------------------------
# Production detector (badge + basket), cached.
# ---------------------------------------------------------------------------

def _cache_key(path: Path) -> str:
    st = path.stat()
    h = hashlib.sha1(f"{path.resolve()}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()[:16]
    return f"{path.stem.replace('.chainspot', '')}-{h}"


def run_detect_course(input_path: Path, cache_dir: Path, timeout_s: float = 240.0) -> dict:
    """Run `npx tsx scripts/detect-course.ts <input> --out <dir>` and return
    the parsed course.json, using an on-disk cache keyed by (path, mtime,
    size) so repeated tuning iterations don't re-pay detector cost."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _cache_key(input_path)
    cache_file = cache_dir / f"{key}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())

    out_dir = cache_dir / f"{key}-out"
    proc = subprocess.run(
        ["npx", "tsx", str(DETECT_SCRIPT), str(input_path), "--out", str(out_dir)],
        cwd=REPO, capture_output=True, text=True, timeout=timeout_s,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"detect-course.ts failed on {input_path}:\n{proc.stdout[-4000:]}\n{proc.stderr[-4000:]}"
        )
    course_json_path = out_dir / "course.json"
    data = json.loads(course_json_path.read_text())
    cache_file.write_text(json.dumps(data))
    return data


def badges_and_baskets_from_detection(detection: dict):
    """Returns (badges, baskets_by_n) from a detect-course.ts course.json:
    badges = [(number, xPx, yPx), ...] sorted by number.
    baskets_by_n = {number: (xPx, yPx)} for holes with a detected basket."""
    badges = []
    baskets_by_n = {}
    for hole in detection.get("grammar", {}).get("holes", []):
        n = hole["number"]
        nb = hole.get("numberBadge")
        if nb is not None:
            badges.append((n, float(nb["xPx"]), float(nb["yPx"])))
        bk = hole.get("basket")
        if bk is not None:
            baskets_by_n[n] = (float(bk["xPx"]), float(bk["yPx"]))
    badges.sort(key=lambda t: t[0])
    return badges, baskets_by_n
