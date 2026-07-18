#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
trap 'rm -rf "$demo_root"' EXIT

mkdir -p "$demo_root/project"
export HARNESS_HOME="$demo_root/home"
cd "$repo_root"
npm run build >/dev/null
node dist/src/cli.js --project "$demo_root/project" env create performance --target both
node dist/src/cli.js --project "$demo_root/project" install -n performance ./examples/performance-engineering
node dist/src/cli.js --project "$demo_root/project" activate performance
node dist/src/cli.js --project "$demo_root/project" info
node dist/src/cli.js --project "$demo_root/project" doctor -n performance
node dist/src/cli.js --project "$demo_root/project" deactivate

echo "Demo completed in $demo_root/project"
