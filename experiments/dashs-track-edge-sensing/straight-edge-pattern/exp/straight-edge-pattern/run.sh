#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node ../restored/edge-diagnostic/edge-readings-work/exp/edge-support-readings/run.mjs
node exp/straight-edge-pattern/sample.mjs
python3 exp/straight-edge-pattern/search.py
python3 exp/straight-edge-pattern/verify.py
python3 exp/straight-edge-pattern/render.py
