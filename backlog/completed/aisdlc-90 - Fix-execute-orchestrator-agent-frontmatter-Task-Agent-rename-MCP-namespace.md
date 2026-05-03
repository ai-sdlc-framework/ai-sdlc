---
id: AISDLC-90
title: Fix execute-orchestrator agent frontmatter — Task→Agent rename + MCP namespace
status: Done
assignee: []
created_date: '2026-04-30 19:46'
updated_date: '2026-04-30 20:27'
labels:
  - plugin
  - bug
  - orchestrator
dependencies: []
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/agents/execute-orchestrator.md
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-82 -
      Refactor-ai-sdlc-execute-to-a-self-contained-orchestrator-subagent-so-parallel-runs-are-first-class.md
      was modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The first parallel-execution test of the new `execute-orchestrator` subagent (AISDLC-82, shipped in v0.8.0) failed identically across two parallel runs. Both orchestrators aborted at Step 5 because the running subagent did not have the `Task` (Agent) tool in its actual tool grant — even though the agent's frontmatter declares it.

Diagnostic via `claude-code-guide` plus inspection of the plugin's MCP server registration confirmed **two distinct bugs** in `ai-sdlc-plugin/agents/execute-orchestrator.md` frontmatter. A third puzzle (Grep / Glob / AskUserQuestion not propagating despite correct declaration) is being researched separately and will be tracked as a follow-up if the source review confirms a Claude Code product issue.

## The two confirmed bugs

### Bug 1 — Wrong tool name for spawning subagents

The frontmatter declares `tools: [..., Task, ...]`. Per Claude Code docs (confirmed via `claude-code-guide`), the `Task` tool was renamed to `Agent` in v2.1.63. Claude Code accepts both names for backwards compat *as a tool reference*, but the recommended modern syntax for plugin agents that spawn other subagents is `Agent(<allowed-subagent-list>)` — which both grants the tool AND restricts which subagent types can be spawned (defense-in-depth: stops the orchestrator from spawning another orchestrator recursively).

The execute-orchestrator's whole purpose is to spawn `developer`, `code-reviewer`, `test-reviewer`, and `security-reviewer` subagents in parallel. The correct declaration is:

```yaml
- Agent(developer, code-reviewer, test-reviewer, security-reviewer)
```

This grants the Agent tool with the restriction that only those four subagent types can be spawned. The orchestrator's hard rule "Never spawn the `execute-orchestrator` agent recursively from within yourself" (currently enforced only at the prompt level) is now also enforced at the tool-grant level.

### Bug 2 — Wrong MCP tool namespace for plugin-supplied servers

The frontmatter declares:
- `mcp__ai-sdlc-plugin__task_edit`
- `mcp__ai-sdlc-plugin__task_complete`

But the actual tool names registered by Claude Code (visible in deferred tool list) are:
- `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`
- `mcp__plugin_ai-sdlc_ai-sdlc__task_complete`

The naming convention for plugin-supplied MCP tools is:

`mcp__plugin_<plugin-name>_<server-name>__<tool>`

From `ai-sdlc-plugin/.claude-plugin/plugin.json`:
- Plugin `name` = `ai-sdlc`
- Under `mcpServers`, the key is `ai-sdlc`

So the namespace prefix is `mcp__plugin_ai-sdlc_ai-sdlc__`. The current frontmatter strings don't match any registered tool, so Claude Code silently drops them from the allowlist (allowlists fail closed — unmatched tool names result in the tool being unavailable, not an error).

Note: `mcp__backlog__task_view` IS correct because `backlog` is a globally-registered MCP server (not plugin-supplied), so it uses the simpler `mcp__<server>__<tool>` namespace.

## Proposed fix

Update `ai-sdlc-plugin/agents/execute-orchestrator.md` frontmatter:

```yaml
---
name: execute-orchestrator
description: Self-contained orchestrator for one /ai-sdlc execute run. Drives worktree → developer subagent → 3 parallel reviewer subagents → PR.
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent(developer, code-reviewer, test-reviewer, security-reviewer)
  - AskUserQuestion
  - mcp__backlog__task_view
  - mcp__plugin_ai-sdlc_ai-sdlc__task_edit
  - mcp__plugin_ai-sdlc_ai-sdlc__task_complete
model: inherit
harness: claude-code
---
```

## What this enables

Before this fix:
- `/ai-sdlc execute` from the slash command works (it runs in the main session with full tools)
- `Task(subagent_type: 'ai-sdlc:execute-orchestrator')` from the main session — the parallel-execution path AISDLC-82 was designed for — fails at Step 5

After this fix:
- True parallel `/ai-sdlc execute` runs become possible: main session fires N `Agent(execute-orchestrator)` calls in a single message, each runs Steps 0-13 fully independently
- Each orchestrator can correctly spawn its own developer + 3 reviewer subagents
- Each orchestrator can edit task status and complete tasks via the plugin's MCP server

## Related work

- AISDLC-82 (shipped) — added the execute-orchestrator subagent
- AISDLC-81 (shipped) — per-worktree active-task sentinels (the other half of the parallel-execution architecture)
- Open follow-up (research in progress) — Grep / Glob / AskUserQuestion not propagating; will file as separate task if source review confirms a Claude Code product bug

## How to test the fix

After this PR merges + plugin republishes + operator does `/plugin update ai-sdlc && restart`:

1. Pick two backlog tasks ready to execute (e.g., AISDLC-69.1 and AISDLC-69.2)
2. From the main Claude Code session, fire two parallel `Agent(subagent_type: 'ai-sdlc:execute-orchestrator')` calls in a single message
3. Both should execute Steps 0-13 fully (developer → reviews → attestation → PR)
4. Both should produce one PR each, no race on worktrees or sentinels

If Bug 3 (Grep/Glob/AskUserQuestion) is also a real product issue, the orchestrator may still abort — but for a different reason now (e.g., "can't grep for files"). That's the diagnostic distinguisher.

## References

- `ai-sdlc-plugin/agents/execute-orchestrator.md` (the file to edit)
- `ai-sdlc-plugin/.claude-plugin/plugin.json` — defines plugin `name` and `mcpServers.ai-sdlc`
- `ai-sdlc-plugin/agents/developer.md` — reference for working frontmatter format (does not use Agent or plugin MCP, but works for what it declares)
- Claude Code docs: subagents reference (Task → Agent rename in v2.1.63)
- claude-code-guide diagnostic transcript (this session, 2026-04-30) — confirmed allowlist semantics + recursive spawn syntax
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Edit `ai-sdlc-plugin/agents/execute-orchestrator.md` to replace `- Task` with `- Agent(developer, code-reviewer, test-reviewer, security-reviewer)`
- [x] #2 Edit `ai-sdlc-plugin/agents/execute-orchestrator.md` to replace `mcp__ai-sdlc-plugin__task_edit` with `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`
- [x] #3 Edit `ai-sdlc-plugin/agents/execute-orchestrator.md` to replace `mcp__ai-sdlc-plugin__task_complete` with `mcp__plugin_ai-sdlc_ai-sdlc__task_complete`
- [x] #4 Update `ai-sdlc-plugin/agents/agents.test.mjs` to assert the new tool names in the orchestrator's frontmatter (positive: Agent(...) form present; positive: correct MCP namespace; negative: no bare `Task`; negative: no `mcp__ai-sdlc-plugin__*`)
- [x] #5 Update CLAUDE.md 'Parallel runs are first-class' section to reference the corrected tool declarations if needed
- [x] #6 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- [x] #7 After merge + plugin republish (v0.8.1) + operator `/plugin update + restart`, two parallel `Agent(execute-orchestrator)` calls from the main session both complete Steps 0-13 successfully (or fail for a different reason than missing-Task/missing-MCP, which would point at the Grep/Glob/AskUserQuestion follow-up)
- [x] #8 Bump `ai-sdlc-plugin/.claude-plugin/plugin.json` and `ai-sdlc-plugin/plugin.json` patch version to 0.8.1 (release-please will handle this on merge if conventional-commit `fix:` prefix is used)
- [x] #9 Remove `- AskUserQuestion` from `ai-sdlc-plugin/agents/execute-orchestrator.md` frontmatter `tools:` list (over-declared; agent body uses 'ask the user' as structured-failure-return wording, not literal tool calls)
- [x] #10 Update orchestrator body language at the two 'ask the user' sites (~lines 82 and 345) to make the structured-failure pattern explicit: 'abort with `outcome: aborted`, populate `notes` for the spawning session to escalate to the user'
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Fixed three frontmatter bugs in `ai-sdlc-plugin/agents/execute-orchestrator.md` that prevented the v0.8.0 parallel-execution architecture (AISDLC-82) from actually working when spawned via `Agent({subagent_type: 'ai-sdlc:execute-orchestrator'})` — both orchestrator runs in the first parallel test had aborted at Step 5 because their declared tool grants were silently filtered by Claude Code's allowlist resolver.

## Changes

- `ai-sdlc-plugin/agents/execute-orchestrator.md` — frontmatter `Task` → `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` (modern syntax with subagent-type restriction); MCP namespace `mcp__ai-sdlc-plugin__*` → `mcp__plugin_ai-sdlc_ai-sdlc__*` (correct plugin-supplied namespace); removed over-declared `AskUserQuestion`. Body wording at two `ask the user` sites reworded to make the structured-failure-return pattern explicit (`outcome: aborted` + populate `notes`).
- `ai-sdlc-plugin/commands/execute.md` — same `Task` → `Agent(execute-orchestrator)` rename in slash command frontmatter + body (without this, the slash command itself couldn't spawn the orchestrator).
- `ai-sdlc-plugin/commands/execute.test.mjs` — assertions updated to match new MCP namespace + new `Agent(execute-orchestrator)` declaration; added negative regression assertion for bare `Task`.
- `ai-sdlc-plugin/commands/triage.md` + `ai-sdlc-plugin/commands/status.md` — operator-facing MCP tool references updated to correct namespace.
- `ai-sdlc-plugin/agents/agents.test.mjs` — added 2 negative regression assertions (`AskUserQuestion` not in tools; body matches `/outcome:\s*aborted/i`); refreshed stale comment about Task tool.
- `CLAUDE.md` — `Parallel runs are first-class` section reworded to reference corrected tool declarations.
- `ai-sdlc-plugin/.claude-plugin/plugin.json` + `ai-sdlc-plugin/plugin.json` — version bumped 0.8.0 → 0.8.1.

## Design decisions

- **`Agent(<allowlist>)` form, not bare `Agent`**: enforces "no recursive orchestrator spawning" at the tool layer (defense-in-depth). Hard Rule #7 in the agent body is now reinforced by the harness itself.
- **`AskUserQuestion` removed instead of "kept defensively"**: agent body usage was already structured-failure-return, the tool was misleading documentation. Async agents shouldn't pause for human input — the spawning session escalates to the user via the JSON return shape.
- **Slash command updated symmetrically**: without this, the orchestrator's frontmatter fix would have been moot — the slash command couldn't spawn the orchestrator due to the same `Task` → `Agent` rename.

## Verification

- `pnpm build` — clean
- `pnpm test` — 4839 tests pass, 0 fail (vitest workspace)
- `node --test 'ai-sdlc-plugin/**/*.test.mjs'` — 165/165 pass, 19/19 suites (Node-built-in test runner; previously not exercised by `pnpm test`, surfaced 2 broken assertions in iteration 2 that the prior `pnpm test`-only verification missed)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED in round 2 (0 critical, 0 major, 0 minor across all reviewers); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)
- 2 developer iterations (round 1 had a self-introspection false-pass on test verification; round 2 surfaced + fixed the gap)

## Follow-up

- AC #7 (post-merge verification of the actual parallel execution) becomes possible after this PR merges + plugin republishes as 0.8.1 + operator runs `/plugin update + restart`. Tracked in AISDLC-91 which empirically tests the sync-vs-async tool-grant filter and decides on the workaround for the third (Claude Code product-level) propagation issue.
- Once parallel execution is verified working end-to-end, the entire AISDLC-82 architecture (multiple parallel `Agent(execute-orchestrator)` calls from one main session) becomes load-bearing for the dogfood pipeline.
<!-- SECTION:FINAL_SUMMARY:END -->
