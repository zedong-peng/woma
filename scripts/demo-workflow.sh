#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_root="$(mktemp -d)"
trap 'rm -rf "$demo_root"' EXIT

project="$demo_root/project"
mkdir -p "$project"
git -C "$project" init -q
printf '%s\n' '{"scripts":{"build":"tsc","test":"node --test","benchmark":"node benchmark.js"}}' > "$project/package.json"

cd "$repo_root"
npm run build >/dev/null
cli=(node "$repo_root/dist/src/cli.js" --project "$project")

"${cli[@]}" onboard --target both
"${cli[@]}" current
printf '%s\n' '# Research result' 'The baseline and hypotheses are ready.' > "$project/research-report.md"
"${cli[@]}" outcome success --artifact research-report.md
"${cli[@]}" handoff experiment
handoff_file="$(find "$project/.harness/handoffs" -type f -name '*-research-to-experiment.md' | head -n 1)"
node "$repo_root/scripts/complete-demo-handoff.mjs" "$handoff_file"
"${cli[@]}" switch experiment
"${cli[@]}" current
"${cli[@]}" outcome inconclusive --note "Need repeated benchmark samples"
"${cli[@]}" stats
"${cli[@]}" doctor
"${cli[@]}" leave

test ! -e "$project/.agents/skills/research-loop"
test ! -e "$project/.agents/skills/experiment-loop"
grep -qv "harness-conda:active-profile" "$project/AGENTS.md" 2>/dev/null || test ! -e "$project/AGENTS.md"

echo "Workflow demo completed in $project"
