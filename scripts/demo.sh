#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
trap 'rm -rf "$demo_root"' EXIT

mkdir -p "$demo_root/project"
cd "$repo_root"
npm run build >/dev/null
node dist/src/cli.js --project "$demo_root/project" use ./examples/performance-engineering --target both
node dist/src/cli.js --project "$demo_root/project" list
node dist/src/cli.js --project "$demo_root/project" doctor performance-engineering
node dist/src/cli.js --project "$demo_root/project" deactivate performance-engineering

echo "Demo completed in $demo_root/project"
