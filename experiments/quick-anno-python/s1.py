"""S1 investigation: Badge ownership and mute, as first-class Python PxC / PCR / PQL.

Production executes S1. Python consumes the resulting material and performs a
bounded experimental Calculation over it. See S1_CHECKPOINT.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages' / 'quick_anno_py'))

from chainspot_quick_anno import Calculation, Part, PCR, PQL, PxC
from chainspot_quick_anno.investigation import StageInvestigation

INV = StageInvestigation('S1', Path(__file__).parent)


def build_investigation(snapshot: dict) -> tuple[PxC, PCR]:
    pxc = PxC()

    badges = Part('px.badges.objects')
    owned = Part('px.badges.px')
    muted = Part('px.badges.muted')
    summary = Part('scratch.s1.ownershipSummary')

    pxc.set(badges, snapshot['badges'])
    pxc.set(owned, snapshot['ownedPixels'])
    pxc.set(muted, snapshot['mutedPixels'])

    summarize = Calculation(
        'fn.quickAnno.s1.summarizeOwnership',
        lambda args: {
            'badges': len(args['badges']),
            'ownedPx': len(args['owned']),
            'mutedPx': len(args['muted']),
            'addedMutePx': len(set(args['muted']) - set(args['owned'])),
        },
    )

    pcr = PCR('S1.quick-anno')
    pcr.calc(
        'InspectOwnership',
        summarize,
        id='summarizeOwnership',
        badges=badges,
        owned=owned,
        muted=muted,
        into=summary,
    )
    pcr.run(pxc)
    return pxc, pcr


def main() -> None:
    snapshot = INV.export(INV.image_from_argv(sys.argv))
    pxc, pcr = build_investigation(snapshot)

    summary = PQL.part('scratch.s1.ownershipSummary').one(pxc)
    INV.emit(summary, pcr)
    INV.materialize()

    print(json.dumps(summary, indent=2))
    print('\nCorrectness renders:')
    for key, file in snapshot['panels'].items():
        print(f'  {key}: {INV.out_dir / file}')
    print(f"  neon: {INV.out_dir / 's1-neon-correctness-sheet.png'}")
    print(f"\nPython PCR view: {INV.out_dir / 'python-S1.mmd'}")
    print(f'Snapshot: {INV.snapshot_path}')


if __name__ == '__main__':
    main()
