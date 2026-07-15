# harness-conda

Switch your Agent's workflow, not just its model.

`harness-conda` gives a project explicit task profiles such as `research`, `experiment`, `debug`, and `report`. A switch keeps shared base capabilities, removes the previous phase, activates the next phase's Skills/MCP/hooks, updates strong project instructions, and carries a structured handoff into a fresh Codex or Claude session.

## Research to experiment

```bash
npm install
npm run build
npm link

mkdir /tmp/agent-lab
harness --project /tmp/agent-lab project init --target both

harness --project /tmp/agent-lab install ./examples/reproducibility-core --base
harness --project /tmp/agent-lab install ./examples/research-workflow --profile research
harness --project /tmp/agent-lab install ./examples/experiment-workflow --profile experiment

harness --project /tmp/agent-lab bind test npm test
harness --project /tmp/agent-lab bind benchmark npm run benchmark

harness --project /tmp/agent-lab switch research
harness --project /tmp/agent-lab handoff experiment
harness --project /tmp/agent-lab switch experiment
```

Use `harness current` to inspect the selected phase. Use `harness enter --agent codex research` to switch and launch a clean Agent session in one command. Arguments after `--` are passed to the Agent:

```bash
harness enter --agent codex experiment -- --full-auto
```

## What a switch guarantees

| Concern | Behavior |
| --- | --- |
| Shared methods | `base` packages remain active across every profile |
| Phase isolation | Packages outside the selected profile are removed |
| Agent routing | Managed blocks in `AGENTS.md` and `CLAUDE.md` name the active phase, bindings, packages, and handoff |
| Cross-Agent config | Skills, MCP servers, and Claude hooks map to each target's official project format |
| Failure safety | Conflicts stop the switch; completed changes roll back if a later activation fails |
| User edits | Modified managed resources block switching until reviewed; `--repair` is explicit |
| Phase transfer | Markdown handoffs preserve evidence, hypotheses, failure cases, inputs, and acceptance criteria |

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
    experiment:
      description: Test hypotheses with reproducible measurements.
      packages: [experiment-workflow]
  bindings:
    build: make release
    test: make test
    benchmark: ./scripts/benchmark.sh
  handoffDirectory: .harness/handoffs
```

Packages hold reusable methodology. Profiles compose packages for a task phase. Bindings connect reusable methodology to the current repository's actual commands. Handoffs transfer state between phases without carrying an old chat context forward.

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
| `harness project init` | Create opinionated research and experiment profiles |
| `harness install <source> --profile <name>` | Lock a package and add it to one phase |
| `harness install <source> --base` | Add shared capability to every phase |
| `harness profile add <profile> <package>` | Compose an installed package into a profile |
| `harness bind <name> <command...>` | Bind build/test/benchmark behavior to this repository |
| `harness switch <profile>` | Atomically select a workflow phase |
| `harness enter <profile>` | Switch and launch a fresh Codex or Claude session |
| `harness handoff <profile>` | Create a structured artifact for the next phase |
| `harness current` | Show the active phase, composition, bindings, and handoff |
| `harness leave` | Remove the profile environment while preserving handoffs |
| `harness sync` | Restore locked packages on a new machine |
| `harness doctor` | Verify project composition, dependencies, integrity, routing, and drift |
| `harness capture <dir> --from codex` | Export existing Agent resources without literal secrets |
| `harness init <dir>` | Scaffold a reusable Harness package |

Low-level `activate`, `deactivate`, `use`, `list`, and `inspect` remain available for package development and compatibility.

## Package format

Every package contains a strict `harness.yaml` and one or more Agent Skills. It may also declare MCP servers, Claude hooks, required commands, and environment variable names. Sources may be local directories, `gh:owner/repo#ref`, HTTPS Git URLs, or SSH Git URLs.

See [the package manifest reference](docs/manifest.md) and the included [research](examples/research-workflow), [experiment](examples/experiment-workflow), [reproducibility](examples/reproducibility-core), and [performance engineering](examples/performance-engineering) packages.

## Safety and compatibility

Activation refuses conflicting Skills and MCP entries. Deactivation removes only unchanged resources owned by the package. `capture` refuses literal MCP environment or header values, and Skill symlinks are rejected. Project-scoped MCP servers still use the target Agent's trust flow.

The adapters follow the official [Codex Skills](https://developers.openai.com/codex/skills/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code Skills](https://code.claude.com/docs/en/skills), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Claude Code Hooks](https://code.claude.com/docs/en/hooks) contracts. Read [SECURITY.md](SECURITY.md) before activating third-party packages.

## Development

```bash
npm run check
npm test
bash scripts/demo-workflow.sh
```

The [Chinese product brief](docs/product-brief.zh-CN.md) covers positioning and commercialization. The [user journeys](docs/user-journeys.zh-CN.md) define the workflows this product must earn the right to serve.
