"""The bounded transfer pattern, once instead of once per Stage.

Every quick_anno Stage investigation runs the same spine:

    real production Stage  ->  smallest useful snapshot  ->  first-class Python
    PxC Parts  ->  bounded PCR Calculation  ->  published scratch Part  ->  PQL
    query  ->  Mermaid view  ->  neon-first correctness materialization

Only the middle (which Parts, which Calculation) is Stage-specific, so only that
stays in `experiments/quick-anno-python/s<N>.py`. This module owns the rest.

Promoted after S3 made it the third identical copy.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .pcr import PCR


class StageInvestigation:
    """Paths, the Node snapshot bridge, and the emit/materialize steps for one Stage."""

    def __init__(self, stage: str, script_dir: Path | str, course: str = 'DashsTrack') -> None:
        self.stage = stage
        self.course = course
        self.script_dir = Path(script_dir).resolve()
        self.repo_root = self.script_dir.parents[1]
        self.out_dir = self.script_dir / 'generated' / f'{course}-{stage}'
        self.snapshot_path = self.out_dir / 'snapshot.json'
        self.bridge = self.script_dir / f'export_{stage.lower()}_snapshot.cjs'
        self.materializer = self.script_dir / f'materialize_{stage.lower()}_neon.py'

    def default_image(self) -> Path:
        """The corpus checkout is a sibling of the repository."""
        return (
            self.repo_root.parent / 'chainspot-corpus' / 'dev' / self.course / f'{self.course}-full.jpg'
        ).resolve()

    def image_from_argv(self, argv: list[str]) -> Path:
        return Path(argv[1]).resolve() if len(argv) > 1 else self.default_image()

    def export(self, image: Path) -> dict[str, Any]:
        """Execute the real production Stages in Node and read back the snapshot."""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ['node', str(self.bridge), str(image), str(self.out_dir)],
            cwd=self.repo_root,
            check=True,
        )
        return json.loads(self.snapshot_path.read_text())

    def emit(self, summary: Any, pcr: PCR) -> tuple[Path, Path]:
        """Write the PQL answer and the Mermaid view of the same composition."""
        summary_path = self.out_dir / 'python-summary.json'
        mermaid_path = self.out_dir / f'python-{self.stage}.mmd'
        summary_path.write_text(json.dumps(summary, indent=2) + '\n')
        mermaid_path.write_text(pcr.mermaid())
        return summary_path, mermaid_path

    def materialize(self) -> None:
        subprocess.run(
            [sys.executable, str(self.materializer), str(self.snapshot_path)],
            cwd=self.repo_root,
            check=True,
        )
