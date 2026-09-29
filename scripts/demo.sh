#!/usr/bin/env bash
# Offline-friendly tour of the main workflow in a throwaway WOMA_HOME.
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
woma() { node "$repo_root/dist/src/cli.js" "$@"; }
woma create -n research claude codex ./examples/auto-research
woma mcp add -n research fetch -- uvx mcp-server-fetch
woma list -n research
woma doctor -n research
woma export -n research -f "$demo_root/environment.yaml"
woma export -n research --pack "$demo_root/research.tgz"
woma create -n colleague -f "$demo_root/research.tgz"
woma run -n colleague codex --version
woma run -n colleague claude --version
