from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = ROOT / "packages" / "quick_anno_py"
sys.path.insert(0, str(PKG))

from chainspot_quick_anno import Calculation, Part, PCR, PQL, PxC

DEFAULT_IMAGE = ROOT.parent / "chainspot-corpus" / "dev" / "DashsTrack" / "DashsTrack-full.jpg"
OUT = Path(__file__).with_name("generated") / "DashsTrack-S3"
SNAPSHOT = OUT / "snapshot.json"
NEON_MATERIALIZER = Path(__file__).with_name("materialize_s3_neon.py")


def export_real_s3(image: Path) -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["node", str(Path(__file__).with_name("export_s3_snapshot.cjs")), str(image), str(OUT)],
        cwd=ROOT,
        check=True,
    )
    return json.loads(SNAPSHOT.read_text())


def build_investigation(snapshot: dict) -> tuple[PxC, PCR]:
    pxc = PxC()

    ring_candidates = Part("px.tees.rings.candidates")
    measured_frames = Part("px.tees.family.measured")
    visible_family = Part("px.tees.family")
    tees = Part("px.tees")
    tee_px = Part("px.tees.px")
    rejected = Part("scratch.s3.rejectedCandidates")
    summary = Part("scratch.s3.visibleTeeSummary")

    pxc.set(ring_candidates, snapshot["rings"]["candidates"])
    pxc.set(measured_frames, snapshot["measured"])
    pxc.set(visible_family, snapshot["family"])
    pxc.set(tees, snapshot["tees"])
    pxc.set(tee_px, snapshot["teePixels"])
    pxc.set(
        rejected,
        {
            "excludedByBadge": snapshot["rings"]["excludedByBadge"],
            "unframed": snapshot["unframed"],
            "framedOutsideFamily": snapshot["rejectedFramed"],
        },
    )

    summarize = Calculation(
        "fn.quickAnno.s3.summarizeVisibleTees",
        lambda args: {
            "ringCandidates": len(args["ringCandidates"]),
            "measuredFrames": len(args["measuredFrames"]),
            "family": len(args["family"]),
            "tees": len(args["tees"]),
            "teePx": len(args["teePx"]),
            "excludedByBadge": len(snapshot["rings"]["excludedByBadge"]),
            "unframed": len(snapshot["unframed"]),
            "framedOutsideFamily": len(snapshot["rejectedFramed"]),
        },
    )

    pcr = PCR("S3.quick-anno")
    pcr.calc(
        "InspectVisibleTeeFamily",
        summarize,
        id="summarizeVisibleTees",
        ringCandidates=ring_candidates,
        measuredFrames=measured_frames,
        family=visible_family,
        tees=tees,
        teePx=tee_px,
        into=summary,
    )
    pcr.run(pxc)
    return pxc, pcr


def main() -> None:
    image = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_IMAGE.resolve()
    snapshot = export_real_s3(image)
    pxc, pcr = build_investigation(snapshot)

    summary = PQL.part("scratch.s3.visibleTeeSummary").one(pxc)
    rejected = PQL.part("scratch.s3.rejectedCandidates").one(pxc)
    (OUT / "python-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUT / "python-rejected.json").write_text(json.dumps(rejected, indent=2) + "\n")
    (OUT / "python-S3.mmd").write_text(pcr.mermaid())

    subprocess.run([sys.executable, str(NEON_MATERIALIZER), str(SNAPSHOT)], check=True, cwd=ROOT)

    print(json.dumps(summary, indent=2))
    print(f"\nNeon correctness: {OUT / 's3-neon-correctness-sheet.png'}")
    print(f"Python PCR view: {OUT / 'python-S3.mmd'}")
    print(f"Snapshot: {SNAPSHOT}")


if __name__ == "__main__":
    main()
