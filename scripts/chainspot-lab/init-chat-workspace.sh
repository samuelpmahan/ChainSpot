#!/usr/bin/env bash

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
