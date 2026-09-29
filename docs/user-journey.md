# Woma 用户流程推演

本文以一位同时用 Claude Code 和 Codex 的研究者为例，推演 Woma 1.0 的使用流程、收益和仍然存在的限制，供产品设计和入门参考。

推演基于 2026-09-29 的 1.0 实现。文中命令都在 Linux x64 上用官方 Claude Code 2.1.284 和 Codex 0.158.0 实际跑过，包括：
- 从 skills.sh、`anthropics/skills`、`openai/skills`、`anthropics/claude-plugins-official` 按名字安装
- 导出后重建
- 确认两个 agent 都能看到同一套 skill 和 MCP

未实际完成登录和模型对话。后续能力变化应同步更新本文。

## 用户与目标

这位研究者希望：

- 把"写论文"和"写代码"两套配置分开。
- 同一套研究 skill 在 Claude Code 和 Codex 里都能用。
- 把调好的配置交给同事，对方拿到就能原样重建。

## 1. 安装，建立第一个环境

先按常规方式装好 Claude Code 和 Codex（例如 `npm install -g @anthropic-ai/claude-code @openai/codex`）。Woma 直接用它们，不下载、也不管理它们的版本。

```bash
npm install -g @x19-507/woma
woma init            # 然后新开一个终端
woma create -n research claude codex pdf@anthropics/skills
```

Woma 为两个 agent 各建一个独立的配置目录，再把 `pdf` skill 锁定到 `anthropics/skills` 当时的 commit。如果某个 agent 还没装，会提示安装命令。创建完成后会提示下一步，以及每个 agent 的登录状态：

```text
Created environment research at ~/.woma/environments/research
  agents:   claude, codex
  packages: pdf
Sign-in:
  claude   not signed in: run claude and use /login, or export CLAUDE_CODE_OAUTH_TOKEN ...
  codex    not signed in: run codex login (once per environment) ...
```

## 2. 装 skill：像装包一样

```bash
woma search pdf                                        # 搜索 skills.sh
woma install -n research yeet@openai/skills            # Codex 官方 skill，按名字装
woma install -n research skill-creator@anthropics/claude-plugins-official   # Claude 插件市场
woma install -n research https://github.com/anthropics/skills/tree/main/skills/docx   # 直接贴链接
woma install -n research ./my-lab-skills               # 本地文件夹，可以是一整个 skill 目录
woma mcp add -n research github --env-var GITHUB_TOKEN -- npx -y @modelcontextprotocol/server-github
woma list -n research
```

`woma list` 会列出每个包的来源和 commit、它装给了哪个 agent，以及 MCP 配置。普通 skill 两个 agent 都能用；`skill-creator` 是 Claude 插件，只装给 Claude，并且装完就已启用。

## 3. 登录

每个环境的登录状态是独立的，这是隔离的代价。想只登录一次，就在 shell 配置里设置 `ANTHROPIC_API_KEY`，或用 `claude setup-token` 生成的 `CLAUDE_CODE_OAUTH_TOKEN`，这样所有环境里的 Claude 都能直接用。Codex 目前不读取环境变量里的 key，每个环境需要执行一次 `codex login`，也可以用 `printenv OPENAI_API_KEY | codex login --with-api-key` 一行完成。

MCP 的令牌同理：`--env-var GITHUB_TOKEN` 只记录变量名，server 启动时从 shell 读取值。

## 4. 日常使用

```bash
cd ~/projects/my-paper
woma activate research
claude          # 或 codex
```

写代码时换另一个环境，两个环境互不影响：

```bash
woma create -n dev claude ./team-skills
woma activate dev
```

也可以不激活，直接跑一条命令：`woma run -n research codex`。

## 5. 升级与回退

```bash
woma export -n research --explicit -f research.lock   # 先存一份精确记录
woma update -n research                               # 升级所有包（agent 用你自己的方式升级）
```

如果升级后效果变差，用 `woma create -n research-old -f research.lock` 原样重建升级前的环境。重建恢复的是 skill、插件和 MCP 配置，不恢复 agent 版本、登录、会话，也不保证模型行为完全相同。

## 6. 交给同事

```bash
woma export -n research -f environment.yaml
```

`environment.yaml` 里写的是可移植的来源：`pdf@anthropics/skills`、`gh:...#commit`，以及相对路径的本地包。同事执行 `woma create -n research -f environment.yaml` 即可。

- **要逐字节一致**：发 `woma export --explicit` 导出的 lock。
- **本地 skill**：如果它所在的 git 仓库已经 push，导出时会自动写成 GitHub 来源；只存在于本机的 skill，用 `woma export --pack research.tgz` 打成一个文件一起发。

## 仍然存在的限制

- 精确 lock 只能在相同平台（操作系统 + 架构）上重建。
- 外部命令（如 MCP 用到的 `npx`、`uvx`）、远程服务和凭据需要对方自己准备。
- 模型、权限等原生设置不在环境管理范围内。
- 目前只支持 Claude Code 和 Codex。
- 还不能一键导入现有的 `~/.claude` 或 `~/.codex`。
- Harbor 评测对接在路线图中。

## 设计哲学

Woma 借鉴 conda：给 harness 一个名字，让它可以独立演进、显式更新、原样重建。

- **能力由原生工具实现。** skill、插件、MCP 仍然由 agent 自己加载，Woma 只负责装到对的位置并锁定 skill 的版本；agent 本身用你自己装的。
- **只在显式指令时变化。** 激活只选择环境，更新由用户显式触发。
- **密钥不落盘。** 密钥永远只以变量名的形式出现。

具体命令和边界见 [命令参考](commands.md)、[环境文件与包格式](manifest.md)、[Woma 管理哪些东西](agent-harness-behavior.md) 和 [设计文档](design.md)。
