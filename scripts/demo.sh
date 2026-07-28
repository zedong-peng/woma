#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$demo_root" 2>/dev/null || true
  rm -rf "$demo_root"
}
trap cleanup EXIT

mkdir -p "$demo_root/project"
export WOMA_HOME="$demo_root/home"
cd "$repo_root"
npm run build >/dev/null
node dist/src/cli.js --project "$demo_root/project" env create performance --target both
node dist/src/cli.js --project "$demo_root/project" install -n performance ./examples/performance-engineering
node dist/src/cli.js --project "$demo_root/project" activate performance
export WOMA_ENV=performance
node dist/src/cli.js --project "$demo_root/project" info
node dist/src/cli.js --project "$demo_root/project" doctor -n performance
node dist/src/cli.js --project "$demo_root/project" deactivate
export WOMA_ENV=base

echo "Demo completed in $demo_root/project"
