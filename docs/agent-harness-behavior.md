# Harness Ownership and Behavior

Each v2 environment contains one harness and one stable, real native `home/`. Activation changes shell variables and prepends its stable `bin/`; it neither loads Packages nor copies native state. Two shells select environments independently. Switching restores the saved original variables before applying the new selection, so environments do not stack. Deactivation restores unset variables as unset and empty variables as empty.

| Surface | Owner | Package operations | Exported |
| --- | --- | --- | --- |
| Runtime files and launcher | Woma | Explicitly install/update; reject standalone removal | Exact source and integrity |
| Installed Package Skills/Plugins | Woma | Snapshot, validate, update/remove, detect drift | Exact source and integrity |
| Necessary plugin registration keys | Woma with local native enable choice | Structural edits with change checks | Reconstructed, enable choice omitted |
| Other model/provider/permission settings | User/harness | Preserve | No |
| Native installations outside Woma ownership | User/harness | Preserve; explicit native path adoption only | No |
| Credentials, sessions, caches, Memory | User/harness | Preserve | No |
| Project configuration, keychains, external commands/services | External | No management | No |

Native tools may install new content under the selected home. Woma does not scan for it or automatically add it to the recipe. Explicit `woma install <path>` snapshots and validates that package first. If the source is exactly the native destination that Woma would own, the existing content can be adopted. A different source colliding with unmanaged installed content fails.

Atomic replacement of `config.toml` or `settings.json` by an editor is supported. These are ordinary files, never required links. Woma preserves unrelated fields and comments while editing its registration keys. Changing plugin enable state is local configuration, not content drift. Changing managed package files is drift; `doctor` reports it and update/remove preserve the changed files and fail.

Woma serializes its own mutations. External native/config writers are not part of its lock protocol; changes are checked immediately before publishing and rollback preserves unexpected writes with a diagnostic and retained backup. Do not run installers concurrently. An already-running harness may cache discovered capabilities; restart it after a package change.

New environments are clean: no default packages, automatic login migration, copied provider config, native-home scan, implicit activation, or enabled plugins. User/project/system configuration and OS keychains may still influence native behavior; selecting an environment is not a sandbox or a promise of account isolation outside the selected home.

`env remove` removes the complete inactive prefix, including credentials, sessions, caches, Memory, configuration, unmanaged installations, and any other local files. Its prompt explicitly lists this loss. Woma's shared immutable content store remains, but neither recipe nor lock is a backup of native state.
