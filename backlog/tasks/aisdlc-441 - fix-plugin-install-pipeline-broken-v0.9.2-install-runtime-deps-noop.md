---
id: AISDLC-441
title: 'fix(plugin): install pipeline broken in v0.9.2 — install-runtime-deps.sh is a no-op + no hook triggers it'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - plugin
  - install
  - p0
  - regression
dependencies: []
references:
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/package.json
  - ai-sdlc-plugin/hooks/session-start.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
priority: critical
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (GH issue #713)

**Severity: P0 — published v0.9.2 plugin is unusable on a fresh install.**

The plugin ships without its runtime dependencies. Claude Code's local marketplace installer copies the cache layer but does not invoke `npm install`, so the MCP server entry point and every `pipeline-cli` binary fail with `Cannot find module .../node_modules/.../dist/...js`.

Two compounding bugs:

1. **`scripts/install-runtime-deps.sh` is a no-op.** It runs `npm install` against `ai-sdlc-plugin/package.json` which has zero `dependencies:` — only a custom `runtimeDependencies:` field that npm doesn't understand. So the script "succeeds" without installing anything.
2. **No hook triggers the script.** Even if the script worked, nothing in `plugin.json`'s hook list invokes it. The path-resolver (`scripts/resolve-pipeline-cli.sh`) has logic to call `install-runtime-deps.sh` as a self-heal, but the script's no-op nature makes that self-heal cosmetic.

## Manual recovery (documented in #713)

From inside the plugin cache directory:

```bash
npm install --omit=dev --no-audit --no-fund --ignore-scripts \
  @ai-sdlc/pipeline-cli@^0.10.0 \
  @ai-sdlc/plugin-mcp-server@0.9.2
```

After that, the MCP server starts and `/ai-sdlc execute` runs.

## Scope

- **Fix `install-runtime-deps.sh`** to actually install the runtime deps. Two paths:
  1. Move `runtimeDependencies` content into `dependencies:` in `ai-sdlc-plugin/package.json` (then plain `npm install` works) — preferred.
  2. Make the script parse the `runtimeDependencies` field and run `npm install <each>` explicitly — fallback if (1) breaks something.
- **Wire the script into the install path** so it actually runs on first plugin load. Either:
  1. Add a `postInstall` script (if Claude Code's plugin loader supports it).
  2. Invoke from `SessionStart` hook (first-time only — guard with a sentinel like `node_modules/.installed-by-ai-sdlc`).
  3. Invoke from `resolve-pipeline-cli.sh` and make the self-heal actually heal.
- **Fix the lying error message** in `resolve-pipeline-cli.sh` — when self-heal succeeds, retry resolution; when self-heal fails, surface WHY (no `dependencies:` field, etc.) instead of listing topologies that can never succeed.
- **Hermetic test** that simulates a fresh-plugin-install scenario (empty `node_modules`, plugin cache copy) and asserts the install path now succeeds.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Fresh `/plugin install ai-sdlc` on a clean Codespace / VM populates `node_modules` such that `@ai-sdlc/pipeline-cli` and `@ai-sdlc/plugin-mcp-server` resolve
- [ ] #2 MCP server starts (no `Failed to reconnect to plugin:ai-sdlc:ai-sdlc: -32000`)
- [ ] #3 `/ai-sdlc execute <task-id>` succeeds past Step 1.5 (no `ERR_MODULE_NOT_FOUND` on `cli-deps`)
- [ ] #4 `scripts/install-runtime-deps.sh` actually installs the declared `runtimeDependencies` (either via repackaged `dependencies:` field OR explicit parse-and-install)
- [ ] #5 Some hook OR resolver step actually invokes the install script on first load (not pure copy-then-fail)
- [ ] #6 `resolve-pipeline-cli.sh` error message surfaces the real root cause when self-heal fails (no more "tried 4 topologies" that all are unreachable)
- [ ] #7 Hermetic test simulates fresh-install scenario + asserts deps resolve
- [ ] #8 PR body closes #713
- [ ] #9 80%+ patch coverage on new test code
<!-- AC:END -->
