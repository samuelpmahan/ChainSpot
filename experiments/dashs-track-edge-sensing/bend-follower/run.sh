#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node run_gateway.cjs "${1:-$PWD/output/gateway}"
