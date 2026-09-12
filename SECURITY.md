# Security Boundaries

Woma installs code and instructions chosen by the user. An integrity digest proves content identity, not trustworthiness. Review package sources and native plugin capabilities before enabling them. Hooks and MCP commands execute according to the harness's own permissions and lifecycle; Woma does not reinterpret or sandbox them.

Runtime Providers download official npm release artifacts over HTTPS, verify SHA-512 distribution integrity, validate archive paths and file types, and record SHA-256 snapshot integrity. Extraction does not run package scripts or a global installer. Unsupported release layouts and dependencies fail. Woma never falls back to a system harness executable. Runtime auto-update checks are disabled where supported; explicit updates belong in `woma update`.

Git sources resolve to full commits. HTTP credentials in source URLs are rejected; use Git's credential helper. Local sources are immutable snapshots. Package symlinks and special files are refused, including archive links and path traversal. Snapshots omit `.git`, `.woma`, and `.DS_Store`; other explicitly supplied package content is retained, so do not put secrets in a package source.

Native plugin manifests and behavior remain upstream-owned. The initial adapters reject native dependency resolution that cannot be completely locked. External executables, remote MCP services, operating-system policy, keychains, and project configuration remain outside Woma's managed-content guarantee.

Native homes contain real files. Woma only owns installed paths and necessary registration keys, and leaves user settings, native installations, sessions, credentials, caches, and Memory in place. Export reads only Woma metadata and never scans or archives a native home. A local source path or Git URL in an exported recipe/lock may still disclose repository locations; review it before sharing.

Environment writers serialize by canonical prefix. Content drift blocks mutation. Ordinary failures roll back Woma's changes; unexpected external edits are retained with backup paths and a diagnostic. Woma does not promise concurrency safety with writers that ignore its lock or automatic crash recovery. An interrupted transaction requires reviewing its journal and backups before further mutation.

Activation is shell selection, not a security boundary. Native tools may still use OS keychains, project settings, external services, and inherited environment variables. Run untrusted packages in an appropriate sandbox.

Environment deletion permanently removes the entire inactive prefix and all native local state. The confirmation lists credentials, sessions, caches, Memory, configuration, and native installations. Locks and recipes cannot restore that state. Legacy environments are never migrated or deleted automatically.
