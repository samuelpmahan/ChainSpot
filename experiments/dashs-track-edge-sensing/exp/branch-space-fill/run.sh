#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
exec ./lab sweep matrix experiments/dashs-track-edge-sensing/matrix-review/MATRIX.json "$@"
