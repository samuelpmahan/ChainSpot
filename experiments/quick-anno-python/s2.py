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
OUT = Path(__file__).with_name("generated") / "DashsTrack-S2"
SNAPSHOT = OUT / "snapshot.json"
NEON_MATERIALIZER = Path(__file__).with_name("materialize_s2_neon.py")


def export_real_s2(image: Path) -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["node", str(Path(__file__).with_name("export_s2_snapshot.cjs")), str(image), str(OUT)],
        cwd=ROOT,
        check=True,
    )
    return json.loads(SNAPSHOT.read_text())


def build_investigation(snapshot: dict) -> tuple[PxC, PCR]:
    pxc = PxC()

    family = Part("px.baskets.family")
    shell_family = Part("px.baskets.shellFamily")
    baskets = Part("px.baskets")
    basket_px = Part("px.baskets.px")
    summary = Part("scratch.s2.basketSummary")

    pxc.set(family, snapshot["family"])
    pxc.set(shell_family, snapshot["shellMembers"])
    pxc.set(baskets, snapshot["baskets"])
    pxc.set(basket_px, snapshot["basketPixels"])

    summarize = Calculation(
        "fn.quickAnno.s2.summarizeBaskets",
        lambda args: {
            "family": len(args["family"]),
            "shellMembers": len(args["shellFamily"]),
            "baskets": len(args["baskets"]),
            "basketPx": len(args["basketPx"]),
            "shellMargins": snapshot["shellMargins"],
        },
    )

    pcr = PCR("S2.quick-anno")
    pcr.calc(
        "InspectBasketFamily",
        summarize,
        id="summarizeBaskets",
        family=family,
        shellFamily=shell_family,
        baskets=baskets,
        basketPx=basket_px,
        into=summary,
    )
    pcr.run(pxc)
    return pxc, pcr


def main() -> None:
    image = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_IMAGE.resolve()
    snapshot = export_real_s2(image)
    pxc, pcr = build_investigation(snapshot)

    summary = PQL.part("scratch.s2.basketSummary").one(pxc)
    (OUT / "python-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUT / "python-S2.mmd").write_text(pcr.mermaid())

    subprocess.run([sys.executable, str(NEON_MATERIALIZER), str(SNAPSHOT)], check=True, cwd=ROOT)

    print(json.dumps(summary, indent=2))
    print(f"\nNeon correctness: {OUT / 's2-neon-correctness-sheet.png'}")
    print(f"Python PCR view: {OUT / 'python-S2.mmd'}")
    print(f"Snapshot: {SNAPSHOT}")


if __name__ == "__main__":
    main()
