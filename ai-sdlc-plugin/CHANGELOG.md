# Changelog

All notable changes to the AI-SDLC Claude Code plugin (`ai-sdlc-plugin/`) are
documented in this file. The plugin version is tracked in `plugin.json`.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
with entries grouped under a release heading or `Unreleased` while in flight.

## Unreleased

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
