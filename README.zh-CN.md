# Woma

**AI 编程 agent 的 conda。** Woma 给每套 agent 配置起一个名字，让多套配置互不干扰，并且能用一个文件在任何地方原样重建。

[English](README.md)

AI 编程 agent = 模型 + harness。harness 包括装了哪些 skill、插件，以及能调用的 MCP server，它决定了 agent 能做什么。可今天它散落在 `~/.claude`、`~/.codex` 这些目录里：没有名字，不能并存，也没法交给别人。Woma 像 conda 管 Python 环境那样管理 harness。

Woma 直接使用你已经装好的 Claude Code 和 Codex，不下载、也不锁定它们的版本。

```bash
npm install -g @x19-507/woma
woma init                      # 安装 activate/deactivate 所需的 shell 集成，然后新开一个终端

woma create -n research claude codex pdf@anthropics/skills
woma activate research
claude                         # 或 codex：同一套 skill、同一套 MCP
```

## 能用它做什么

### 1. 像 requirements.txt 一样分享你攒的 harness

你从 GitHub、[skills.sh](https://skills.sh)、插件市场和自己的文件夹里攒了一套 skill，别人也想用一模一样的。

```bash
woma export -n research -f environment.yaml        # 可读可改，直接提交进仓库
```

```yaml
agents: [claude, codex]
packages:
  - pdf@anthropics/skills
  - skill-creator@anthropics/claude-plugins-official
  - gh:me/lab-skills/paper-search#v1.2
mcp_servers:
  github:
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env_vars: [GITHUB_TOKEN]       # 只记录变量名，永远不记录值
```

同事执行 `woma create -n research -f environment.yaml` 即可重建。

- **要逐字节一致**（精确到 Git commit 和内容哈希）：用 `woma export --explicit -f woma.lock` 导出 lock。
- **有些 skill 只在你本地**：用 `woma export --pack research.tgz` 打成一个文件。

### 2. 不同工作用不同 harness，互相隔离

写论文和写代码需要的 skill、工具不一样。每个环境有各自的 skill、插件、MCP、登录状态和历史。

```bash
woma create -n paper claude pdf@anthropics/skills docx@anthropics/skills
woma create -n dev   claude codex ./my-team-skills
woma activate paper    # 像 conda activate 一样切换
woma run -n dev codex  # 或者不切换，直接在某个环境里跑一条命令
```

改动一个环境不会影响其他环境。所有环境都运行你 PATH 里的 `claude` 和 `codex`；升级它们用你原来的安装方式即可（例如 `claude update` 或 `npm install -g @openai/codex`）。

### 3. Claude Code 和 Codex 共用同一套 skill

一个环境可以同时装两个 agent。skill 或 MCP server 只需装一次，两边都能用。

```bash
woma create -n research claude codex
woma install -n research yeet@openai/skills ./skills-from-everywhere
woma mcp add -n research fetch -- uvx mcp-server-fetch
```

原生插件只装给对应的 agent：Claude Code 插件只给 Claude Code，Codex 插件只给 Codex。

### 4. 确切知道结果是哪套 harness 跑出来的

对比 agent 或做实验时，harness 本身就是实验条件。`woma.lock` 记录了每个 skill 和插件的 commit 与内容哈希，以及 MCP 配置。这样每个结果都能对应到确切的 harness，之后也能重跑。`woma list` 会显示环境当前用的 Claude Code 和 Codex 版本。

## 安装 skill：带版本的包

Woma 像 conda 管包一样管 skill：每个 skill 都有来源和版本，并锁定到确切的 commit 和内容哈希。

| conda | woma |
| --- | --- |
| `conda install numpy` | `woma install pdf@anthropics/skills`（按名字装 skill 或插件） |
| `conda install numpy=1.26` | `woma install pdf@anthropics/skills#v1.0`（分支、tag 或 commit） |
| 从某个 channel 装 | `woma install gh:owner/repo/path/to/skill#main` |
| | `woma install https://github.com/owner/repo/tree/main/skills/x`（直接粘贴浏览器链接） |
| 本地包 | `woma install ./my-skill` 或 `./一整个-skill-文件夹` |
| `conda search` | `woma search pdf`（搜索 [skills.sh](https://skills.sh)） |
| `conda update numpy` | `woma update pdf` |
| `conda list` | `woma list` |
| `environment.yml` | `woma export -f environment.yaml` |
| `conda list --explicit` | `woma export --explicit -f woma.lock` |
| `conda-pack` | `woma export --pack env.tgz` |

`名字@owner/repo` 按以下顺序在仓库里查找：
1. Claude Code 插件市场（`.claude-plugin/marketplace.json`，例如 [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)）
2. Codex 插件市场（`.agents/plugins/marketplace.json`）
3. 名字匹配的 `SKILL.md`（例如 [anthropics/skills](https://github.com/anthropics/skills)、[openai/skills](https://github.com/openai/skills)）

如果你安装的本地文件夹，恰好是某个已 push 的 commit 的干净 checkout，Woma 会识别出来。导出时写的就是那个 GitHub commit，而不是你本机的路径。

## 登录与密钥

每个环境的登录状态是独立的，Woma 不会复制或链接任何凭据文件。想登录一次、所有环境通用，就在 shell 配置里设置令牌：

- **Claude Code**：`ANTHROPIC_API_KEY`，或用 `claude setup-token` 生成的 `CLAUDE_CODE_OAUTH_TOKEN`。
- **Codex**：每个环境执行一次 `codex login`，或 `printenv OPENAI_API_KEY | codex login --with-api-key`。

`woma doctor` 会显示每个 agent 将如何认证。MCP 的密钥也是同样的思路：`env_vars` 和 `bearer_token_env_var` 只写变量名，server 启动时从你的 shell 读取，值永远不会被保存。

## 工作原理

```text
~/.woma/
  store/v2/<sha256>/          只读、按内容寻址的 skill 和插件
  environments/research/
    home/claude/              CLAUDE_CONFIG_DIR：skill、插件、MCP，以及你自己的登录和会话
    home/codex/               CODEX_HOME
    .woma/state.json          lock，以及 Woma 管理的文件清单
```

- **agent 用你自己的。** Woma 使用你 PATH 里的 `claude` 和 `codex`，不下载、不锁定、也不包装它们。激活环境只会设置 `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME`，于是你已有的 agent 就会读取这个环境的 skill、插件、MCP 和登录状态。
- **原生格式。** skill 拷进各 agent 原生的 `skills/` 目录。插件和 MCP 通过对 `config.toml`、`settings.json`、`.claude.json` 的精确局部修改来注册，你的注释和其他设置都会保留。
- **安全修改。** 每次修改都先暂存，检查有没有并发编辑，失败就回滚。`woma doctor` 会报告被改动过的受管文件，以及在 Woma 之外被改过的 MCP 条目。
- **不做隐式操作。** 没有默认环境，不会自动激活，也不会导入你现有的 `~/.claude` 或 `~/.codex`。

## 环境要求

- 已按常规方式安装、并在 PATH 中的 Claude Code 和/或 Codex
- Node.js 20.19+、22.13+ 或 24+
- Git
- macOS 或 Linux 上的 Bash 或 Zsh

插件需要 Claude Code 2.1.269+ 或 Codex 0.154.0+。

## 路线图

- **Harbor 评测**：把环境交给 [Harbor](https://github.com/harbor-framework/harbor)，用同一个 benchmark 对比不同 harness。
- 更多 agent（OpenCode、Gemini CLI）。
- 把现有的 `~/.claude` 或 `~/.codex` 一键导入成新环境。

## 了解更多

[命令](docs/commands.md) · [环境文件与包格式](docs/manifest.md) · [设计](docs/design.md) · [原生适配](docs/agent-adapters.md) · [Woma 管理哪些东西](docs/agent-harness-behavior.md) · [安全](SECURITY.md) · [更新日志](CHANGELOG.md) · [用户流程推演](docs/user-journey.md)

## 许可证

[MIT](LICENSE)
