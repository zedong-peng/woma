# Native Installation Adapters

Adapters implement concrete installation and registration contracts for each agent. Woma does not interpret Hook lifecycles or MCP tool behavior.

| Contract | Claude Code | Codex |
| --- | --- | --- |
| Agent home | `CLAUDE_CONFIG_DIR=<prefix>/home/claude` | `CODEX_HOME=<prefix>/home/codex` |
| Executable | the user's `claude` on PATH (not managed by Woma) | the user's `codex` on PATH (not managed by Woma) |
| Skill location | `home/claude/skills/<name>` | `home/codex/skills/<name>` |
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Verified plugin floor | 2.1.269 | 0.154.0 |
| Plugin installation | `home/claude/skills/<name>` (Skills-directory plugin) | `home/codex/plugins/cache/woma/<name>/<native-version>` plus `.woma/marketplace/plugins/<name>` |
| Plugin ID and enable key | `enabledPlugins."<name>@skills-dir"` in `settings.json` | `plugins."<name>@woma".enabled` in `config.toml` |
| Marketplace registration | none | `marketplaces.woma.{source_type,source}` in `config.toml` |
| MCP servers | `mcpServers.<name>` in `home/claude/.claude.json` | `mcp_servers.<name>` in `home/codex/config.toml` |

Verified behavior, checked by `WOMA_LIVE_TESTS=1 npm run test:live` against the Claude Code and Codex installed on PATH, without model calls:

- Codex lists `$CODEX_HOME/skills` Skills in its prompt input (`codex debug prompt-input`).
- Codex reads `mcp_servers` including `env_vars` and `bearer_token_env_var` (`codex mcp list --json`).
- Claude Code reads user-scope `mcpServers` from `$CLAUDE_CONFIG_DIR/.claude.json` and starts stdio servers with its own environment, so a token exported in the shell reaches the server without being written to disk (`claude mcp list`). Claude Code rewrites `.claude.json` when it starts, and Woma's entries survive unchanged (`woma doctor` stays clean).
- Both agents discover Woma-installed plugins, and report them as enabled (`plugin list --json`).

Claude Code also expands `${VAR}` references in `mcpServers` entries. This was observed manually and is not covered by the live tests. Woma relies on it only for the `Authorization` header of HTTP servers.

Codex's local marketplace uses `.agents/plugins/marketplace.json` with local `source.path` and `AVAILABLE` / `ON_USE` policy. Before editing the registration, Woma checks that `marketplaces.woma` still names its own prefix.

New plugins are enabled on install. After that, native enable and disable choices are preserved on update. On removal, Woma deletes its enable key and the marketplace registration once no Codex plugin remains.

Configuration edits are syntax-aware. TOML is edited through a syntax tree: Woma replaces or removes whole tables such as a `[mcp_servers.github]` block written by `codex mcp add`, and preserves comments and unrelated keys. JSON and JSONC are edited with targeted modifications. Every file is checked for concurrent changes immediately before it is replaced.

Adapters reject a plugin in any of these cases, because a native resolver could otherwise add unlocked content:

- native `dependencies`, `optionalDependencies` or `requiresPlugins` arrays that are not empty
- a universal root manifest
- a package with both a `.claude-plugin` and a `.codex-plugin` manifest
- a Claude marketplace entry defined only by marketplace fields (`strict: false` with commands, hooks, LSP or MCP servers)

A plugin is never silently installed as plain Skills.

Plugin runtime data written outside the installation paths stays native and is not exported. Executables called by MCP servers or Hooks, project configuration, OS policy, keychains and remote services are not managed.

References:

- [Claude Code plugins reference and Skills-directory plugins](https://code.claude.com/docs/en/plugins-reference)
- [Codex plugin packaging and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-plugin)
