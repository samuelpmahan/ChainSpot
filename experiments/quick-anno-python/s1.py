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
OUT = Path(__file__).with_name("generated") / "DashsTrack-S1"
SNAPSHOT = OUT / "snapshot.json"


def export_real_s1(image: Path) -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["node", str(Path(__file__).with_name("export_s1_snapshot.cjs")), str(image), str(OUT)],
        cwd=ROOT,
        check=True,
    )
    return json.loads(SNAPSHOT.read_text())


def build_investigation(snapshot: dict) -> tuple[PxC, PCR]:
    pxc = PxC()

    badges = Part("px.badges.objects")
    owned = Part("px.badges.px")
    muted = Part("px.badges.muted")
    summary = Part("scratch.s1.ownershipSummary")

    pxc.set(badges, snapshot["badges"])
    pxc.set(owned, snapshot["ownedPixels"])
    pxc.set(muted, snapshot["mutedPixels"])

    summarize = Calculation(
        "fn.quickAnno.s1.summarizeOwnership",
        lambda args: {
            "badges": len(args["badges"]),
            "ownedPx": len(args["owned"]),
            "mutedPx": len(args["muted"]),
            "addedMutePx": len(set(args["muted"]) - set(args["owned"])),
        },
    )

    pcr = PCR("S1.quick-anno")
    pcr.calc(
        "InspectOwnership",
        summarize,
        id="summarizeOwnership",
        badges=badges,
        owned=owned,
        muted=muted,
        into=summary,
    )
    pcr.run(pxc)
    return pxc, pcr


def main() -> None:
    image = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_IMAGE.resolve()
    snapshot = export_real_s1(image)
    pxc, pcr = build_investigation(snapshot)

    summary = PQL.part("scratch.s1.ownershipSummary").one(pxc)
    (OUT / "python-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUT / "python-S1.mmd").write_text(pcr.mermaid())

    print(json.dumps(summary, indent=2))
    print("\nCorrectness renders:")
    for key, file in snapshot["panels"].items():
        print(f"  {key}: {OUT / file}")
    print(f"\nPython PCR view: {OUT / 'python-S1.mmd'}")
    print(f"Snapshot: {SNAPSHOT}")


if __name__ == "__main__":
    main()
