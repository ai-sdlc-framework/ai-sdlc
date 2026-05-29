---
id: AISDLC-473
title: >-
  Rename /ai-sdlc:status command to /ai-sdlc:pipeline-status (avoid collision
  with built-in Claude Code /status)
status: Done
assignee: []
created_date: '2026-05-29 16:08'
updated_date: '2026-05-29 17:05'
labels:
  - plugin
  - commands
  - dx
  - bugfix
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The ai-sdlc plugin's `status` slash command collided with Claude Code's built-in `/status` command. When the operator typed `/status`, the plugin command shadowed the built-in, making the native status unreachable. This task renames the plugin command to `pipeline-status` so both coexist.

Scope (operator decision 2026-05-29): rename ONLY `status` to `pipeline-status`. The plugin's `review` command also collides with built-in `/review`, but the operator chose to rename that one in a separate later PR — this task does not touch `review.md`.

Conflict audit result: of the 18 ai-sdlc plugin commands, exactly two collide with built-in Claude Code commands — `status` (this task) and `review` (deferred). The other 16 names are unique.

The command body itself is unchanged — only the `name:` frontmatter field, the filename, and the doc-table references change. The body's branch/task/issue mode-detection logic stays identical.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc-plugin/commands/status.md` renamed (git mv, history preserved) to `ai-sdlc-plugin/commands/pipeline-status.md`
- [x] #2 The renamed file's frontmatter `name:` field reads `pipeline-status` (was `status`); description, argument-hint, allowed-tools unchanged
- [x] #3 `ai-sdlc-plugin/README.md` slash-command table references `/ai-sdlc pipeline-status`, not `/ai-sdlc status`
- [x] #4 Root `README.md` command table shows `/ai-sdlc pipeline-status` — N/A: the root README has no status command row, so nothing stale to update
- [x] #5 `review.md` is NOT modified (handled by a separate follow-up PR per operator decision)
- [x] #6 No other ai-sdlc command name collides with a built-in Claude Code command (audit: only status + review collided; review deferred)
- [x] #7 `pnpm lint`, `pnpm format:check`, and `pnpm build` pass; the `no-bare-paths.test.mjs` command-naming test still passes after the rename (it enumerates command files dynamically)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Renamed the plugin's `/ai-sdlc:status` slash command to `/ai-sdlc:pipeline-status` via `git mv` (history preserved). Updated the renamed file's `name:` frontmatter field plus the bold display block, the `ai-sdlc-plugin/README.md` Slash Commands table row, and the `no-bare-paths.test.mjs` header-comment example filename. The command body is byte-identical.

The collision is resolved so the operator can again reach Claude Code's built-in `/status`; the plugin command is now `/pipeline-status` (and `/ai-sdlc:pipeline-status`).

Three reviewer subagents (code, test, security) approved. The `review` to `review-pr` rename is tracked as a separate follow-up PR.
<!-- SECTION:NOTES:END -->
