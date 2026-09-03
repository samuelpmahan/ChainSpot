#!/usr/bin/env bash
#
# CHAT BOOTSTRAP
# Repository: samuelpmahan/ChainSpot
# Branch: task/lab-pxc-storybook-pcr
# Workflow: Package LAB workspace
# Artifact prefix: chainspot-lab-workspace-
# Proven packet commit: 5826e3f7753150bb8d95d1069d589ba93ec4616f
# Proven workflow run ID: 33729189138
# Proven artifact ID: 9883162465
# Proven artifact file: chainspot-lab-workspace-5826e3f.zip
#
# If the artifact ZIP is not already attached, use the GitHub plugin to
# download the newest artifact from that workflow and branch. Materialize the
# ZIP beside this script, then run:
#
#   bash chainspot-lab-init.sh <artifact.zip>
#
# Do not install dependencies. If GitHub, shell, or file access is unavailable,
# print BOOTSTRAP_BLOCKED with the missing capability and stop immediately.

set -euo pipefail

artifact="${1:-}"
workspace="${2:-./chainspot-lab-workspace}"

if [[ -z "$artifact" ]]; then
  artifact="$(find . -maxdepth 1 -type f -name 'chainspot-lab-workspace-*.zip' -print | sort | tail -n 1)"
fi

if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "BOOTSTRAP_BLOCKED: pass the downloaded chainspot-lab-workspace-*.zip as argument 1" >&2
  exit 2
fi

for command in unzip tar node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "BOOTSTRAP_BLOCKED: missing command: $command" >&2
    exit 3
  fi
done

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

unzip -q "$artifact" -d "$scratch"
payload="$scratch/chainspot-lab-workspace.tar.gz"

if [[ ! -f "$payload" ]]; then
  echo "BOOTSTRAP_BLOCKED: artifact does not contain chainspot-lab-workspace.tar.gz" >&2
  exit 4
fi

mkdir -p "$workspace"
tar --no-same-owner -xzf "$payload" -C "$workspace"

receipt="$workspace/.lab-workspace/receipt.txt"
if [[ ! -f "$receipt" ]]; then
  echo "BOOTSTRAP_BLOCKED: workspace receipt is missing" >&2
  exit 5
fi

if [[ ! -d "$workspace/node_modules" ]]; then
  echo "BOOTSTRAP_BLOCKED: root dependencies are missing" >&2
  exit 6
fi

if [[ ! -d "$workspace/scripts/chainspot-lab/node_modules" ]]; then
  echo "BOOTSTRAP_BLOCKED: LAB dependencies are missing" >&2
  exit 7
fi

echo "BOOTSTRAP_OK"
echo "workspace=$(cd "$workspace" && pwd)"
cat "$receipt"
