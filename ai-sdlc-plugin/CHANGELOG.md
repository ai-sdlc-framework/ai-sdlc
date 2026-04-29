# Changelog

All notable changes to the AI-SDLC Claude Code plugin (`ai-sdlc-plugin/`) are
documented in this file. The plugin version is tracked in `plugin.json`.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
with entries grouped under a release heading or `Unreleased` while in flight.

## Unreleased

### Documentation

- **Remote-agent usage policy** (`CLAUDE.md`): documented that Anthropic CCR
  remote agents (scheduled via the bundled `/schedule` skill,
  `Path: bundled:schedule`) are read-only by design. Empirical 4-for-4
  failure rate of `/ai-sdlc execute` over `/schedule` (AISDLC-78, -79, -80,
  -85) confirmed the structural blockers: no signing key in the remote
  sandbox, plugin not auto-installed, subagents not registered, no local
  worktree. The new `Remote agents (/schedule) — read-only by design`
  section in `CLAUDE.md` lists acceptable patterns (PR status surveys,
  backlog state reports, cron-triggered metric digests, Slack workflows,
  CI run surveys) and explicitly-prohibited patterns
  (`/ai-sdlc execute`, signing-key-dependent flows, plugin-subagent
  flows, worktree flows, cross-repo write flows). Notes AISDLC-87
  (CI-side attestor) as the planned fix that will eventually unblock
  remote-agent `/ai-sdlc execute`. Since the `/schedule` skill is
  system-bundled (not in this repo), the callout lives in `CLAUDE.md`
  per AISDLC-86 AC #4. (AISDLC-86)

### Changed

- **`/ai-sdlc execute`, `/ai-sdlc status`, `/ai-sdlc triage`**: rewired all
  call sites that previously used `mcp__backlog__task_edit` and
  `mcp__backlog__task_complete` to the plugin's drop-in replacements
  `mcp__ai-sdlc-plugin__task_edit` / `mcp__ai-sdlc-plugin__task_complete`
  (shipped in AISDLC-73). The new tools preserve unknown frontmatter keys
  verbatim — most importantly `permittedExternalPaths`, which the upstream
  tools silently strip on every status flip, breaking cross-repo writes for
  any task that needs them. `mcp__backlog__task_view` (read-only) continues
  to use upstream. (AISDLC-83)
- `ai-sdlc-plugin/commands/execute.md` `allowed-tools` frontmatter updated
  accordingly: removed upstream `mcp__backlog__task_edit` /
  `mcp__backlog__task_complete`, added the plugin equivalents.

### Notes

- No MCP server schema changes were required — the AISDLC-73 tool schemas
  (`status`, `acceptanceCriteriaCheck`, `finalSummary`, `updatedDate` for
  `task_edit`; `id`, `finalSummary`, `updatedDate` for `task_complete`)
  already cover every field `/ai-sdlc execute` needs. No bundle rebuild
  was needed for AISDLC-83.
- AC #4 of AISDLC-83 (end-to-end dogfood verification with a task carrying
  `permittedExternalPaths`) is intentionally deferred to a manual run by
  the human operator after this PR merges.
