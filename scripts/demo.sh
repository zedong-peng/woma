#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$demo_root" 2>/dev/null || true
  rm -rf "$demo_root"
}
trap cleanup EXIT
export WOMA_HOME="$demo_root/state"
cd "$repo_root"
npm run build >/dev/null
node dist/src/cli.js create -n performance codex@0.154.0
node dist/src/cli.js install -n performance ./examples/performance-engineering
node dist/src/cli.js list -n performance
node dist/src/cli.js doctor -n performance
node dist/src/cli.js export -n performance --explicit -f "$demo_root/woma.lock"
node dist/src/cli.js create -n reproduced -f "$demo_root/woma.lock"
node dist/src/cli.js run -n reproduced codex --version
