# Native Installation Adapters

Adapters implement concrete installation and registration contracts. Core does not interpret Hook lifecycle events or MCP tool behavior.

| Contract | Codex | Claude Code |
| --- | --- | --- |
| Selected home | `CODEX_HOME=<prefix>/home` | `CLAUDE_CONFIG_DIR=<prefix>/home` |
| Skill location | `home/skills/<name>` | `home/skills/<name>` |
| Plugin manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` |
| Verified runtime floor | 0.154.0 | 2.1.269 |
| Plugin installation | `home/plugins/cache/woma/<name>/<native-version>` | `home/skills/<name>` |
| Local source | `.woma/marketplace/plugins/<name>` | Installed plugin directory itself |
| Native plugin ID | `<name>@woma` | `<name>@skills-dir` |
| Registration | `marketplaces.woma` source/type and `plugins.<id>.enabled` in `config.toml` | `enabledPlugins.<id>` in `settings.json` |

Codex's local marketplace uses `.agents/plugins/marketplace.json`, local `source.path`, and `AVAILABLE` / `ON_USE` policy. Its installed cache uses the upstream native version, or `local` if absent. Woma verifies that the marketplace registration still names its selected prefix before updating it. User plugin policy fields in the same table are preserved.

Claude's documented Skills-directory discovery loads the original Plugin in place with the native `@skills-dir` identity. Native tools can enable/disable it. Removing its directory removes the plugin; no marketplace install database is synthesized.

New plugins default to disabled. Existing enable state is preserved on update and can be changed through the native tool. Removal deletes only Woma's enabled entry and necessary marketplace keys, keeping unrelated config. JSONC and TOML syntax trees support local edits, including inline TOML tables, without replacing whole user settings.

Native dependency arrays, optional dependencies, and required-plugin declarations are rejected unless empty: the initial adapters cannot stop a native resolver from adding unlocked content. Woma-level dependencies are allowed and become part of the exact closure. Universal root manifests, dual-manifest overlays, and older native plugin protocols are refused until separately verified. Woma does not silently install a plugin as plain Skills.

Plugin runtime data written by the harness outside its installation paths stays native and unexported. A plugin that modifies its own managed files creates drift and blocks future package mutation. Executables called by MCP/Hooks, project configuration, ambient system policy, keychains, and remote services are not managed by the adapter.

References and live contract checks:

- [Codex plugin commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-plugin)
- [Codex plugin packaging and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Claude Plugin reference and Skills-directory plugins](https://code.claude.com/docs/en/plugins-reference)
- `WOMA_LIVE_TESTS=1 npm run test:live` exercises official runtime installation and native plugin listing in temporary homes, without model calls.
