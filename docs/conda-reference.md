# Conda Reference: External Installation and Manual Changes

Research date: 2026-09-13. Source inspection uses Conda 26.7.2, the latest stable release at the time. A small discovery experiment uses the locally available Conda 24.11.3. These findings inform Woma's design; they do not settle its pending discovery and adoption policy.

## What Conda recognizes

| Action | Conda behavior |
| --- | --- |
| Download a Conda archive, then install it with `conda install ./package.tar.bz2` | The normal installation machinery creates package records under `conda-meta/`. Local acquisition still produces a managed installation. Explicit archive installation skips dependency solving. |
| Install a local wheel or source project with pip inside the environment | Conda can discover supported Python distribution metadata and include the package in `conda list`, even though Conda did not perform the installation. |
| Copy a Python distribution with complete, supported metadata into the expected location | Discovery is metadata-based; it does not require observing the installer invocation. Valid metadata can therefore make manually placed content visible. Visibility alone does not establish that the installation is complete or reproducible. |
| Copy files without supported package metadata | Those files do not become package records or ordinary package-export entries. Conda has a separate notion of untracked files. |
| Edit an already installed package's files | Its recorded package version does not become a new version. `conda doctor` can detect changed files when the Conda record contains the required per-file checksums. |

Conda's prefix reader loads `conda-meta/*.json`. For package listing and relevant exports, it also loads foreign Python package records from supported metadata such as `.dist-info/RECORD` and `.egg-info`. Discovery happens when those records are read; it does not depend on a filesystem watcher continuously recording every edit.

## Export and clone have different boundaries

The traditional `conda env export` builds a dependency description from package records. In 26.7.2, its pip section contains `name==version` entries. That representation does not archive local package bytes, arbitrary file edits, or necessarily preserve a local source's provenance. `--from-history` further limits the export to recorded installation intent.

`conda create --clone` has an additional path that copies untracked files, subject to exclusions and prefix handling. Copying those files does not turn them into managed packages. The clone implementation reinstalls recorded Conda packages from their artifacts, so its treatment of untracked files should not be interpreted as a general backup of edits to tracked package files.

Conda's documentation also describes limitations when mixing pip and Conda operations. Discovering a foreign package for listing is a narrower capability than coordinating every installer's dependency resolution and file ownership.

## Local discovery experiment

A disposable synthetic prefix contained a minimal Python package record, one loose Python module, and a second Python module intended to represent a local distribution. No Python runtime or third-party package was installed in that prefix.

1. With only the modules present, `conda list --prefix <fixture> --json` reported the synthetic Python record alone.
2. After adding `woma_reference_pkg-1.0.0.dist-info/METADATA` and `RECORD`, the same command also reported `woma-reference-pkg` version `1.0.0`, with `pypi`/`pypi_0` metadata.
3. `conda env export --prefix <fixture> --json` included `woma-reference-pkg==1.0.0` under `pip`. The loose module remained absent.

This checks metadata discovery, not package installation or runtime correctness. Existing user environments were not modified.

## Implications to discuss for Woma

- Local installation through `woma install <path>` can provide full records even when a user or Agent obtained the content independently.
- Native installation metadata can support discovery without requiring every installer to call Woma. Discovery, ownership, and exact reproduction should have explicit contracts.
- How directly created Skills and edited package files enter a lock remains a Woma policy choice. Conda's behavior does not require automatic adoption or snapshots of every file in an environment.
- The agreed export of non-sensitive MCP configuration, launch arguments, and plugin enablement remains a separate requirement. Package discovery alone does not determine how those configuration fields are captured.

## Sources

- [Conda install reference](https://docs.conda.io/projects/conda/en/stable/commands/install.html) and [26.7.2 command implementation](https://github.com/conda/conda/blob/26.7.2/conda/cli/main_install.py).
- [26.7.2 package listing](https://github.com/conda/conda/blob/26.7.2/conda/cli/main_list.py), [foreign Python package loader](https://github.com/conda/conda/blob/26.7.2/conda/plugins/prefix_data_loaders/pypi/__init__.py), and [metadata discovery](https://github.com/conda/conda/blob/26.7.2/conda/plugins/prefix_data_loaders/pypi/pkg_format.py).
- [26.7.2 traditional environment export](https://github.com/conda/conda/blob/26.7.2/conda/env/env.py).
- [26.7.2 untracked-file and clone implementation](https://github.com/conda/conda/blob/26.7.2/conda/misc.py).
- [26.7.2 altered-file diagnostics](https://github.com/conda/conda/blob/26.7.2/conda/plugins/subcommands/doctor/health_checks/altered_files.py).
- [26.7.2 environment-management guidance](https://github.com/conda/conda/blob/26.7.2/docs/source/user-guide/tasks/manage-environments.rst).
