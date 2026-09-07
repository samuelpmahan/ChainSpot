"""S2 investigation: the Basket family / shell / objects, as first-class Python PxC / PCR / PQL.

Production executes S2. Python consumes the resulting material and performs a
bounded experimental Calculation over it. See S2_VALIDATION.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages' / 'quick_anno_py'))

from chainspot_quick_anno import Calculation, Part, PCR, PQL, PxC
from chainspot_quick_anno.investigation import StageInvestigation

INV = StageInvestigation('S2', Path(__file__).parent)


def build_investigation(snapshot: dict) -> tuple[PxC, PCR]:
    pxc = PxC()

    family = Part('px.baskets.family')
    shell_family = Part('px.baskets.shellFamily')
    baskets = Part('px.baskets')
    basket_px = Part('px.baskets.px')
    summary = Part('scratch.s2.basketSummary')

    pxc.set(family, snapshot['family'])
    pxc.set(shell_family, snapshot['shellMembers'])
    pxc.set(baskets, snapshot['baskets'])
    pxc.set(basket_px, snapshot['basketPixels'])

    summarize = Calculation(
        'fn.quickAnno.s2.summarizeBaskets',
        lambda args: {
            'family': len(args['family']),
            'shellMembers': len(args['shellFamily']),
            'baskets': len(args['baskets']),
            'basketPx': len(args['basketPx']),
            'shellMargins': snapshot['shellMargins'],
        },
    )

    pcr = PCR('S2.quick-anno')
    pcr.calc(
        'InspectBasketFamily',
        summarize,
        id='summarizeBaskets',
        family=family,
        shellFamily=shell_family,
        baskets=baskets,
        basketPx=basket_px,
        into=summary,
    )
    pcr.run(pxc)
    return pxc, pcr


def main() -> None:
    snapshot = INV.export(INV.image_from_argv(sys.argv))
    pxc, pcr = build_investigation(snapshot)

    summary = PQL.part('scratch.s2.basketSummary').one(pxc)
    INV.emit(summary, pcr)
    INV.materialize()

    print(json.dumps(summary, indent=2))
    print(f"\nNeon correctness: {INV.out_dir / 's2-neon-correctness-sheet.png'}")
    print(f"Python PCR view: {INV.out_dir / 'python-S2.mmd'}")
    print(f'Snapshot: {INV.snapshot_path}')


if __name__ == '__main__':
    main()
