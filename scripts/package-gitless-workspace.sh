#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-artifacts/chainspot-workspace}"
rm -rf "$OUT"
mkdir -p "$OUT"

# Fixed Gitless development checkout. Exclusions are anchored to directory
# names at any depth; GNU tar's plain --exclude=node_modules did not reliably
# exclude nested workspace node_modules from the artifact.
tar \
  --exclude-vcs \
  --exclude='node_modules' \
  --exclude='*/node_modules' \
  --exclude='artifacts' \
  --exclude='*/artifacts' \
  --exclude='dist' \
  --exclude='*/dist' \
  --exclude='.svelte-kit' \
  --exclude='*/.svelte-kit' \
  --exclude='coverage' \
  --exclude='*/coverage' \
  --exclude='*.log' \
  -cf - . | tar -xf - -C "$OUT"

# Packaging contract: fail before upload if disposable dependency/build state leaked.
if find "$OUT" -type d \( -name node_modules -o -name .git -o -name dist -o -name .svelte-kit -o -name coverage \) -print -quit | grep -q .; then
  echo "gitless workspace packaging leaked an excluded directory" >&2
  find "$OUT" -type d \( -name node_modules -o -name .git -o -name dist -o -name .svelte-kit -o -name coverage \) -print >&2
  exit 1
fi

cat > "$OUT/WORKSPACE.json" <<EOF
{
  "schema": "chainspot-workspace@1",
  "repository": "samuelpmahan/ChainSpot",
  "branch": "${GITHUB_REF_NAME:-unknown}",
  "baseCommit": "${GITHUB_SHA:-unknown}",
  "contract": "gitless-development-checkout"
}
EOF
