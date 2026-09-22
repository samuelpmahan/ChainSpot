#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-artifacts/chainspot-workspace}"
rm -rf "$OUT"
mkdir -p "$OUT"
# Fixed Gitless development checkout: copy the repository working tree, excluding
# transport/history and reproducible/ephemeral outputs. No dependency analysis.
tar   --exclude=.git   --exclude=node_modules   --exclude=artifacts   --exclude='*/dist'   --exclude='*/.svelte-kit'   --exclude='*/coverage'   --exclude='*.log'   -cf - . | tar -xf - -C "$OUT"
cat > "$OUT/WORKSPACE.json" <<EOF
{
  "schema": "chainspot-workspace@1",
  "repository": "samuelpmahan/ChainSpot",
  "branch": "${GITHUB_REF_NAME:-unknown}",
  "baseCommit": "${GITHUB_SHA:-unknown}",
  "contract": "gitless-development-checkout"
}
EOF
