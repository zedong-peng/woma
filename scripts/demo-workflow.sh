#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
trap 'rm -rf "$demo_root"' EXIT

project="$demo_root/project"
mkdir -p "$project"
git -C "$project" init -q

cd "$repo_root"
npm run build >/dev/null
cli=(node "$repo_root/dist/src/cli.js" --project "$project")

"${cli[@]}" project init --target both
"${cli[@]}" install ./examples/reproducibility-core --base
"${cli[@]}" install ./examples/research-workflow --profile research
"${cli[@]}" install ./examples/experiment-workflow --profile experiment
"${cli[@]}" bind test npm test
"${cli[@]}" bind benchmark npm run benchmark

"${cli[@]}" switch research
"${cli[@]}" current
"${cli[@]}" handoff experiment
"${cli[@]}" switch experiment
"${cli[@]}" current
"${cli[@]}" leave

test ! -e "$project/.agents/skills/research-loop"
test ! -e "$project/.agents/skills/experiment-loop"
grep -qv "harness-conda:active-profile" "$project/AGENTS.md" 2>/dev/null || test ! -e "$project/AGENTS.md"

echo "Workflow demo completed in $project"
