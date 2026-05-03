---
id: AISDLC-91
title: Plugin agents cannot spawn nested Agent calls (deeper than Grep/Glob filter)
status: Done
assignee: []
created_date: '2026-04-30 19:54'
updated_date: '2026-04-30 22:15'
labels:
  - plugin
  - bug
  - orchestrator
  - claude-code-upstream
dependencies:
  - AISDLC-90
references: []
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      claude-code/src/agentToolUtils.ts
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      claude-code/src/runAgent.ts
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      claude-code/src/loadPluginAgents.ts
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/agents/execute-orchestrator.md
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-90 -
      Fix-execute-orchestrator-agent-frontmatter-Task-Agent-rename-MCP-namespace.md
      was modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Status as of 2026-04-30 parallel-execution test:** the original scope of this task (Grep/Glob/AskUserQuestion silently filtered for async plugin agents) is partially correct but UNDERSTATED. The actual blocker is one level deeper.

**Empirical finding from AISDLC-69.2's orchestrator run:** When `execute-orchestrator` (a plugin agent spawned via `Agent` from the main session) tried to spawn `developer` via `Agent(developer, ...)`, the harness returned:

> `"No such tool available: Agent. Agent is not available inside subagents. Complete the task with the tools provided and return findings to the orchestrator."`

This means **the Agent tool itself is filtered from any plugin-agent subagent invocation, regardless of frontmatter declaration**. Nested-subagent spawning is blocked one level deep at the harness level. No plugin-side workaround exists.

This invalidates the AISDLC-82 architecture (execute-orchestrator-as-subagent that spawns its own dev + reviewers). See AISDLC-98 for the architectural revert.

## What this task is now

- Pure investigation + upstream issue filing.
- The fix path is upstream Claude Code (or accepting the architecture revert).
- This task closes once we either (a) get an upstream change that allows allowlisted nested-Agent for plugin agents, or (b) accept that AISDLC-98 is the canonical fix and we don't need a workaround.

## Original Grep/Glob/AskUserQuestion findings still hold

The original task description's analysis of `ASYNC_AGENT_ALLOWED_TOOLS` filter (`agentToolUtils.ts:70-116`) is still accurate for those specific tools. The deeper finding (Agent tool also filtered) is incremental on top of that.

So the full filter taxonomy as observed:
- **Always filtered for async/subagent context**: `Agent` (NEW finding), `Grep`, `Glob`, `AskUserQuestion`
- **Always available**: `Read`, `Bash`, `mcp__<server>__<tool>` for globally-registered MCP servers, `mcp__plugin_<plugin>_<server>__<tool>` for plugin-supplied MCP (subject to AISDLC-99's path-resolution bug)
- **Conditionally available**: depends on the spawning context's tool grants and whether the harness recognizes the tool name

## Workaround options now (mostly superseded by AISDLC-98)

### Path A — Architecture revert (AISDLC-98)

Move the orchestrator pipeline back to the slash command body. The slash command runs in the main Claude Code session (not a subagent), which has Agent. Parallelism handled at slash-command level.

Cost: medium (mostly prose moves + test updates).
Pros: works today.
Cons: gives up the AISDLC-82 vision of "main session fans out N orchestrators".

### Path B — Out-of-process orchestrator (already exists)

`pnpm --filter @ai-sdlc/dogfood watch --issue <id>` is a TypeScript service, not a subagent. It can fan out N developer subagents directly (via the Claude Code SDK or via spawning ephemeral Claude Code sessions). This is the existing CI/unattended path.

Cost: zero — already shipped.
Pros: works today, no Claude Code limitation.
Cons: API-key billing, not subscription. Different operational profile from `/ai-sdlc execute`.

### Path C — File upstream Claude Code issue

Request that plugin agents be able to declare allowlisted nested-Agent tool grants for explicitly-permitted subagent types. Indefinite timeline.

Cost: low to file, unbounded to land.
Pros: would unlock AISDLC-82-style architectures for the plugin ecosystem broadly.
Cons: not a near-term fix.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. File the upstream Claude Code issue (Path C) documenting the empirical findings: nested Agent filtered, plus Grep/Glob/AskUserQuestion async filter. Include the source-code references this task already has (`agentToolUtils.ts:70-116`, `loadPluginAgents.ts:98-182`). Link to AISDLC-69.2's orchestrator transcript as the empirical proof.
2. Once the upstream issue is filed, link it from this task's notes.
3. Wait for upstream signal (closed / under-investigation / not-planned). Update this task accordingly.
4. If upstream lands a fix: revert AISDLC-98 (re-introduce execute-orchestrator-as-subagent). If upstream rejects: close this task as "superseded by AISDLC-98".

## References

- `claude-code/src/agentToolUtils.ts` (the filter source)
- `claude-code/src/loadPluginAgents.ts`
- AISDLC-69.2's orchestrator return JSON (this session) — primary empirical evidence
- AISDLC-82 — the architecture this would have enabled
- AISDLC-90 — the frontmatter fixes that PARTIALLY worked (agent loaded, but Agent tool still filtered at runtime)
- AISDLC-98 — the architectural revert that ships independently of this task
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 After AISDLC-90 ships, empirically test whether spawning the orchestrator with `run_in_background: false` (Option B) bypasses the async tool filter — confirm by having the orchestrator report its actual tool list to verify Grep/Glob/AskUserQuestion propagation
- [ ] #2 If Option B works: change `/ai-sdlc execute` slash command + execute-orchestrator agent docs to use sync invocation; update CLAUDE.md 'Parallel runs are first-class' to clarify sync-spawning semantics
- [ ] #3 If Option B does NOT work: restructure execute-orchestrator agent prompt + tool list to use only ASYNC_AGENT_ALLOWED_TOOLS (replace Grep/Glob with Bash-driven equivalents; remove AskUserQuestion in favor of structured failure-mode JSON return)
- [ ] #4 File upstream Claude Code issue documenting the silent filter override; include the specific source file references and a minimal repro plugin agent definition
- [ ] #5 Update CLAUDE.md with a 'Plugin agent tool gotchas' section documenting the ASYNC_AGENT_ALLOWED_TOOLS constraint so future plugin authors don't blindly declare unsupported tools
- [ ] #6 Update `ai-sdlc-plugin/agents/agents.test.mjs` to assert that plugin agent declarations don't include tools that wouldn't actually propagate (lint-style test against a known-bad list)
- [ ] #7 Re-run parallel execution test (2 simultaneous Agent calls) and confirm both orchestrators complete Steps 0-13 successfully with correct tool grants
- [ ] #8 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Closed as **superseded by AISDLC-98** (which retired the AISDLC-82 execute-orchestrator subagent architecture and moved the pipeline body back into the slash command body).

The original AISDLC-91 hypothesis (Grep/Glob/AskUserQuestion silently filtered for async plugin agents) was correct but incomplete. Empirical finding from AISDLC-69.2's parallel-execution test: the `Agent` tool itself is filtered from any plugin-agent subagent invocation, regardless of frontmatter declaration — making nested-subagent spawning impossible one level deep at the harness level. AISDLC-98 reverted AISDLC-82 and re-inlined the pipeline accordingly.

This task closes per its own AC #2 ("accept that AISDLC-98 is the canonical fix"). No upstream Claude Code change is being pursued.

## Follow-up

- AISDLC-98 (MERGED) — the canonical architectural fix
- The harness-level `Agent` filtering is documented in CLAUDE.md `Backlog Workflow > Cross-repo writes > Parallel runs are first-class — but parallelism is per-Claude-Code-session, not per-subagent (AISDLC-98)`
<!-- SECTION:FINAL_SUMMARY:END -->
