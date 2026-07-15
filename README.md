# harness-conda

Switch your Agent's workflow, not just its model.

`harness-conda` gives a project explicit task profiles such as `research`, `experiment`, `debug`, and `report`. A switch keeps shared base capabilities, removes the previous phase, activates the next phase's Skills/MCP/hooks, updates strong project instructions, and carries a structured handoff into a fresh Codex or Claude session.

## First value in 30 seconds

```bash
npm install
npm run build
npm link

cd /path/to/your/project
harness onboard
harness enter research
```

`onboard` detects installed Agents, repository stacks, the checked-in package manager, and standard build/test/benchmark/lint commands. It installs the built-in reproducibility, research, and experiment workflows and activates `research`. Review the generated `.harness/project.yaml`, then work normally.

When research produces a decision:

```bash
harness outcome success --artifact research-report.md
harness handoff experiment
harness enter experiment
harness outcome inconclusive --note "Need more benchmark samples"
harness stats
```

`enter` starts a clean Codex or Claude session. Use `harness enter --agent codex experiment -- --full-auto` to select an Agent and pass through its arguments.

## What a switch guarantees

| Concern | Behavior |
| --- | --- |
| Shared methods | `base` packages remain active across every profile |
| Phase isolation | Packages outside the selected profile are removed |
| Agent routing | Managed blocks in `AGENTS.md` and `CLAUDE.md` name the active phase, bindings, packages, and handoff |
| Cross-Agent config | Skills, MCP servers, and lifecycle hooks map to each target's official project format |
| Failure safety | Conflicts stop the switch; completed changes roll back if a later activation fails |
| User edits | Modified managed resources block switching until reviewed; `--repair` is explicit |
| Phase transfer | Markdown handoffs preserve evidence, hypotheses, failure cases, inputs, and acceptance criteria |
| Result evidence | Explicit outcomes connect success, failure, or uncertainty to the active profile and an optional artifact |
| Privacy | Automatic events and private notes stay in Git-excluded `.harness/local`; the CLI uploads nothing |

The project definition is committed at `.harness/project.yaml`:

```yaml
apiVersion: harness.conda/project-v1
kind: HarnessProject
metadata:
  name: agent-lab
spec:
  agent: codex
  targets: [codex, claude]
  base: [reproducibility-core]
  profiles:
    research:
      description: Find prior work and produce testable hypotheses.
      packages: [research-workflow]
      handoff: optional
    experiment:
      description: Test hypotheses with reproducible measurements.
      packages: [experiment-workflow]
      handoff: required
  bindings:
    build: make release
    test: make test
    benchmark: ./scripts/benchmark.sh
  handoffDirectory: .harness/handoffs
```

Packages hold reusable methodology. Profiles compose packages for a task phase. Bindings connect reusable methodology to the current repository's actual commands. Handoffs transfer state between phases without carrying an old chat context forward. A `required` handoff blocks the next phase until every decision, evidence, hypothesis, input, failure, and acceptance section has been completed.

## Multiple servers

Use Git sources for portable packages, then commit `.harness/project.yaml` and `.harness/lock.json`:

```bash
harness install gh:owner/research-workflow#v1.0.0 --profile research
git add .harness/project.yaml .harness/lock.json
git commit -m "Define Agent workflow environment"
```

On another server:

```bash
git pull
harness sync
harness doctor
harness enter research --agent codex
```

`sync` restores exact locked commits into the content-addressed cache and rejects source drift. Environment variable names are declared in packages, while secret values stay in the machine environment.

## Commands

| Command | Outcome |
| --- | --- |
| `harness onboard` | Detect the repository, install built-ins, bind commands, and activate research |
| `harness project init` | Create opinionated research and experiment profiles |
| `harness install <source> --profile <name>` | Lock a package and add it to one phase |
| `harness install <source> --base` | Add shared capability to every phase |
| `harness profile add <profile> <package>` | Compose an installed package into a profile |
| `harness bind <name> <command...>` | Bind build/test/benchmark behavior to this repository |
| `harness switch <profile>` | Atomically select a workflow phase |
| `harness enter <profile>` | Switch and launch a fresh Codex or Claude session |
| `harness handoff <profile>` | Create a structured artifact for the next phase |
| `harness outcome <status>` | Record local-only success, failure, or inconclusive evidence |
| `harness stats` | Summarize local transitions, sessions, handoffs, and outcomes |
| `harness current` | Show the active phase, composition, bindings, and handoff |
| `harness leave` | Remove the profile environment while preserving handoffs |
| `harness sync` | Restore locked packages on a new machine |
| `harness doctor` | Verify project composition, dependencies, integrity, routing, and drift |
| `harness capture <dir> --from codex` | Export existing Agent resources without literal secrets |
| `harness init <dir>` | Scaffold a reusable Harness package |

Low-level `activate`, `deactivate`, `use`, `list`, and `inspect` remain available for package development and compatibility.

## Why not just use plugins?

You should use native plugins. [Codex Plugins](https://developers.openai.com/codex/plugins/) and [Claude Code Plugins](https://code.claude.com/docs/en/discover-plugins) already distribute Skills, MCP servers, hooks, and connectors through marketplaces. Packaging and discovery are platform capabilities, not this product's moat.

`harness-conda` operates one layer above them: it selects the task phase, composes shared and phase-specific capabilities, binds generic workflows to this repository, starts a clean session, transfers evidence to the next phase, and measures whether the workflow produced a useful result. Its current portable package adapter bridges both Agents; native plugin dependencies are a future interoperability path, not a reason to rebuild their marketplaces.

## Package format

Every package contains a strict `harness.yaml` and one or more Agent Skills. It may also declare MCP servers, lifecycle hooks, required commands, and environment variable names. Sources may be built-ins, local directories, `gh:owner/repo#ref`, HTTPS Git URLs, or SSH Git URLs.

See [the package manifest reference](docs/manifest.md) and the included [research](examples/research-workflow), [experiment](examples/experiment-workflow), [reproducibility](examples/reproducibility-core), and [performance engineering](examples/performance-engineering) packages.

## Safety and compatibility

Activation refuses conflicting Skills and MCP entries. Deactivation removes only unchanged resources owned by the package. `capture` refuses literal MCP environment or header values, and Skill symlinks are rejected. Project-scoped MCP servers still use the target Agent's trust flow. Automatic workflow evidence contains metadata only; outcome notes are explicit, local, and never uploaded.

The adapters follow the official [Codex Skills](https://developers.openai.com/codex/skills/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Codex Hooks](https://developers.openai.com/codex/hooks/), [Claude Code Skills](https://code.claude.com/docs/en/skills), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Claude Code Hooks](https://code.claude.com/docs/en/hooks) contracts. Read [SECURITY.md](SECURITY.md) before activating third-party packages.

## Development

```bash
npm run check
npm test
bash scripts/demo-workflow.sh
```

The [Chinese product brief](docs/product-brief.zh-CN.md) covers positioning and commercialization. The [user journeys](docs/user-journeys.zh-CN.md) define the workflows this product must earn the right to serve.
