---
id: AISDLC-1393
title: "The plugin README recovery command works in the operator's own shell"
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - bug
  - docs
  - plugin
dependencies: []
references:
  - ai-sdlc-plugin/README.md
  - ai-sdlc-plugin/commands/plugin-root-preamble.test.mjs
priority: low
---

## Description

**Gap.** `ai-sdlc-plugin/README.md:197` tells the operator to run `bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" "$CLAUDE_PLUGIN_ROOT" --force`. This is a command a human types into their own shell, where `CLAUDE_PLUGIN_ROOT` is never set (Claude Code sets it only for hook and plugin processes; README `:168` says as much since AISDLC-1367). The command expands to `bash "/scripts/install-runtime-deps.sh" "" --force` and fails.

**Source.** Leftover found while checking GitHub issue #2741 (fixed by AISDLC-1367, #2908); outside that task's acceptance criteria.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the operator needs one copy-paste command that finds the installed plugin. 2. Deleted: the reliance on an unset variable. 3. Simplified: resolve the install path the same way the commands' plugin-root preamble does (`installed_plugins.json`), or print the path with an existing CLI and use it. 4. Accelerated: none. 5. Automated: extend the existing guard so README shell snippets cannot use `$CLAUDE_PLUGIN_ROOT` outside a hook context.

- Replace the snippet with a command that resolves the plugin install path without `CLAUDE_PLUGIN_ROOT` (for example a one-line `node -e` reading `~/.claude/plugins/installed_plugins.json`, or an `ai-sdlc` subcommand if one already prints it).
- Grep the other docs for operator-run snippets using `$CLAUDE_PLUGIN_ROOT` and fix them the same way.

## Acceptance Criteria

- [ ] #1 The README recovery command runs from a plain terminal with no Claude Code variables set and reaches `install-runtime-deps.sh`.
- [ ] #2 A test fails when a fenced shell block in `ai-sdlc-plugin/README.md` or `docs/` uses `$CLAUDE_PLUGIN_ROOT` in an operator-run command.
- [ ] #3 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
