#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PYTHONPATH=lib:. python3 - <<'PY'
import tempfile
import test_tracker, test_render
for name in sorted(n for n in dir(test_tracker) if n.startswith('test_')):
    getattr(test_tracker,name)()
with tempfile.TemporaryDirectory() as d:
    from pathlib import Path
    test_render.test_views(Path(d))
print('unit-like checks: PASS')
PY
PYTHONPATH=lib python3 tests_run.py
