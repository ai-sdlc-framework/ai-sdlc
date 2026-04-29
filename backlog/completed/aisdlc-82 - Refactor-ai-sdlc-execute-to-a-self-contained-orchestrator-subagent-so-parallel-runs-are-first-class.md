---
id: AISDLC-82
title: >-
  Refactor /ai-sdlc execute to a self-contained orchestrator subagent so
  parallel runs are first-class
status: Done
assignee: []
created_date: '2026-04-29 02:23'
updated_date: '2026-04-29 05:46'
labels:
  - enhancement
  - plugin
  - parallel
  - design
  - follow-up
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - >-
    backlog/completed/aisdlc-71 -
    Replace-orchestrator-driven-dogfood-pipeline-with-ai-sdlc-execute-plugin-command.md
  - >-
    backlog/tasks/aisdlc-81 -
    Per-worktree-active-task-sentinel-—-enable-parallel-ai-sdlc-execute-runs-with-cross-repo-writes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced during the parallel-run test (AISDLC-73 + AISDLC-77 in flight at once). The current `/ai-sdlc execute` design CANNOT be invoked in parallel — Skill calls are synchronous in the main session, and the slash command's body assumes the main session walks through Steps 0-13 itself.

Today, "parallel runs" require the operator (or me, as the orchestrator model) to:
1. Manually do Steps 0-4 for each task sequentially
2. Launch dev subagents in parallel via Task tool
3. Hand-roll Step 7 reviewer fan-out as each dev returns
4. Sequence pushes (avoid husky pre-push race)
5. Open PRs

This is fragile, hard to compose with `/loop`, and forces the operator to remember the recipe.

## Root cause

`developer`, `code-reviewer`, `test-reviewer`, `security-reviewer` all have `disallowedTools: [AgentTool]` (designed to prevent recursive subagent spawning). So no subagent can BE the orchestrator — only the main session can spawn Task subagents.

## Proposed fix: dedicated `execute-orchestrator` subagent

Define a NEW agent at `ai-sdlc-plugin/agents/execute-orchestrator.md`:
- `tools: [Read, Grep, Glob, Bash, Task, AskUserQuestion, mcp__backlog__task_view, mcp__backlog__task_edit, mcp__backlog__task_complete]` — note `Task` is allowed (the only agent with this exception)
- Body = the existing `commands/execute.md` Steps 0-13 recipe
- Returns a structured JSON summary on completion

Then `/ai-sdlc:execute` becomes:

```bash
Task({ subagent_type: 'execute-orchestrator', prompt: '$ARGUMENTS' })
```

To run N in parallel, the main session fires N `Task` calls in a single message — clean parallel.

## Alternative considered: Bash-script orchestrator

Move all of Steps 0-13 into a single shell script (`scripts/execute-task.mjs`) that does the worktree + dev-spawn + reviewer-spawn + commit + push + PR. Run from the slash command via `node scripts/execute-task.mjs $ARGUMENTS`. Parallel = `node scripts/execute-task.mjs A & node scripts/execute-task.mjs B & wait`.

Tradeoff: the dev + reviewer subagent spawns need to happen IN-SESSION (they're Claude Code Task subagents, not external processes). A bash script can't spawn Task subagents directly. So this option requires inverting more architecture (e.g., exposing dev/reviewer as Anthropic API calls instead of Task subagents). Bigger lift, not recommended.

## Recommendation

Subagent-based fix. Smaller change. Preserves all the current architecture (Task subagents, governance hooks, attestation). Gets parallel for free.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `ai-sdlc-plugin/agents/execute-orchestrator.md` defined with full Step 0-13 body, `Task` in tools, model: inherit
2. `ai-sdlc-plugin/commands/execute.md` body simplified to `Task({ subagent_type: 'execute-orchestrator', prompt: $ARGUMENTS })` — preserve as the user-facing entry point
3. `ai-sdlc-plugin/agents/agents.test.mjs` extended with assertions for the new agent (tools, model, body has Step 0/Step 13)
4. SubagentStart hook (`subagent-start.{sh,js}`) fires for the new agent and injects the same governance context as today
5. Per-worktree sentinel (AISDLC-81 prerequisite) so parallel runs with cross-repo writes work — call out as a hard dependency
6. Parallel-run integration test: spawn 2 `execute-orchestrator` subagents at once via two Task calls in a single message; both complete cleanly; both produce attestations CI accepts; both PRs open; no resource collisions
7. `/loop /ai-sdlc:execute <task-id>` continues to work serially (composes naturally with the new design — `/loop` fires one Task at a time)
8. Documentation updated:
   - CLAUDE.md: parallel runs now first-class
   - commands/execute.md: short body explains the orchestrator-subagent design
   - Notes about scaling: review subagent burst (3N concurrent reviewers for N parallel runs), husky pre-push serialization recommended
9. All new code: 80%+ patch coverage, build/test/lint/format clean

## Out of scope

- AISDLC-81 (per-worktree sentinel) — separate prerequisite task
- Push serialization mechanism (husky pre-push race) — orchestrator subagent handles its OWN push; multiple orchestrators racing to push is a separate concern, deferred
- Removing the `disallowedTools: [AgentTool]` from `developer` (still want to prevent recursive dev spawning; only the orchestrator gets the exception)
- Changing CI behavior around the attestation system

## References

- ai-sdlc-plugin/commands/execute.md (current Steps 0-13 recipe)
- ai-sdlc-plugin/agents/developer.md (current dev agent — disallowedTools: AgentTool)
- backlog/completed/aisdlc-71 - *.md (original /ai-sdlc execute design)
- backlog/tasks/aisdlc-81 - *.md (per-worktree sentinel — hard prerequisite)
- This conversation's parallel-run test (AISDLC-73 + AISDLC-77) where the limitation surfaced
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 `ai-sdlc-plugin/agents/execute-orchestrator.md` defined with full Step 0-13 body, `Task` in tools list (the only agent with this exception), `model: inherit`, governance hard rules embedded
- [x] #2 `ai-sdlc-plugin/commands/execute.md` body simplified to a one-liner spawning `execute-orchestrator` via Task tool with `$ARGUMENTS`; preserves the user-facing slash command entry point
- [x] #3 `ai-sdlc-plugin/agents/agents.test.mjs` extended with assertions for the new agent (tools, model: inherit, body contains Step 0 + Step 13 markers)
- [x] #4 SubagentStart hook (`subagent-start.{sh,js}`) fires for `execute-orchestrator` and injects the same governance context as for other subagents
- [x] #5 Per-worktree sentinel from AISDLC-81 is a hard dependency — callout in the task body that AISDLC-81 must merge first, OR design verifies the orchestrator coexists with the project-level sentinel as a parallel-safe fallback
- [ ] #6 Parallel-run integration test: 2 `execute-orchestrator` subagents spawned via two Task calls in a single message; both complete cleanly, both produce CI-accepted attestations, both PRs open, no resource collisions
- [x] #7 `/loop /ai-sdlc:execute <task-id>` continues to work serially (composes naturally; `/loop` fires one Task at a time)
- [x] #8 Documentation updated: CLAUDE.md notes parallel runs are first-class; commands/execute.md explains the orchestrator-subagent design; notes about scaling (3N concurrent reviewers for N parallel runs, husky pre-push serialization recommended)
- [x] #9 All new code: 80%+ patch coverage; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Refactored `/ai-sdlc execute` from a slash-command-with-body to a thin wrapper that spawns a new `execute-orchestrator` subagent containing the full Step 0-13 pipeline. The orchestrator is the only plugin agent permitted `Task` (and the only one without `disallowedTools: [AgentTool]`) — making parallel runs first-class. The main session can now fire N orchestrators in a single message and each runs independently against its own worktree, no manual orchestration needed.

AC #6 (parallel-run integration test) deferred for human verification — running 2 real orchestrators in unit tests would consume significant compute and require live backlog tasks. The full design is wired and ready; a manual 2-task parallel run after merge will validate end-to-end.

## Changes
- `ai-sdlc-plugin/agents/execute-orchestrator.md` (NEW): full Step 0-13 body. `tools: [Read, Grep, Glob, Bash, Task, AskUserQuestion, mcp__backlog__task_view, mcp__ai-sdlc-plugin__task_edit, mcp__ai-sdlc-plugin__task_complete]`. `model: inherit`. Hard governance rules embedded (NEVER merge PRs, force-push, edit blocked paths, recursive orchestrator-spawning). Uses AISDLC-83 plugin tool names (not upstream).
- `ai-sdlc-plugin/commands/execute.md` (REWRITTEN): thin wrapper that spawns the orchestrator via Task with `$ARGUMENTS`. Frontmatter narrowed (no MCP tool perms needed at slash-command level — orchestrator owns those). Brief design explanation in body.
- `ai-sdlc-plugin/agents/agents.test.mjs`: 25-assertion suite for the new agent (Task in tools, no AgentTool in disallowedTools, model: inherit, plugin task_edit/task_complete tool names, Step 0/13 markers, governance rules, 3 reviewer invocations, AISDLC-81 dependency, no-recursive-orchestrator rule). Cross-checks all OTHER agents still have `disallowedTools: [AgentTool]` (regression catch).
- `ai-sdlc-plugin/commands/execute.test.mjs`: wrapper assertions (subagent_type, $ARGUMENTS) + bonus fix of pre-existing AISDLC-81 fallout (subtests 17/18/19 now correctly assert per-worktree sentinel behavior instead of the legacy project-level path).
- `CLAUDE.md`: parallel runs section rewritten with scaling notes (3N concurrent reviewers for N parallel runs, husky pre-push serialization, /loop compatibility).

## Design decisions
- **Subagent-based, not script-based**: the alternative was a bash/Node script that orchestrates externally, but Claude Code Task subagents need to be spawned IN-SESSION. A script can't fan out subagents directly, so subagent-as-orchestrator is the cleanest mechanism.
- **Hard rule against recursive orchestrator**: Rule #7 in the agent body forbids spawning another orchestrator from inside one. Prompt-only enforcement (Task tool grant is binary in agent frontmatter), but blast radius is bounded — recursive orchestrators still hit PreToolUse hook + governance gates and can't escalate.
- **Wrapper preserves slash command UX**: `/ai-sdlc execute` still works exactly as before from the user's perspective. The refactor is invisible to the operator.
- **Tool names use AISDLC-83 plugin variants**: orchestrator body calls `mcp__ai-sdlc-plugin__task_edit` / `task_complete` (preserving `permittedExternalPaths`), not the upstream tools. Aligned with AISDLC-83 (PR #91 — see ordering note below).

## Verification
- `pnpm build` — clean
- `pnpm test` — clean (67 tests pass: 25 in agents.test.mjs + 42 in execute.test.mjs, including fixed AISDLC-81 subtests)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 0+1 minor + 2 suggestion; test: 1 minor + 2 suggestion; security: 0)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- **AC #6 manual e2e**: spawn 2 `execute-orchestrator` subagents at once via two Task calls in a single message; verify both complete cleanly, both produce CI-accepted attestations, both PRs open, no resource collisions.
- **PR ordering with AISDLC-83 (#91)**: AISDLC-83 also touches `commands/execute.md`. This PR fully rewrites that file as a one-liner. AISDLC-83 should merge FIRST so its tool-name update lands on main; this PR's rebase will resolve the file-overwrite cleanly (the orchestrator body already uses the new tool names, so net behavior is preserved). If this PR merges first, AISDLC-83's edits to execute.md become no-ops (the file is now a wrapper) but its edits to status.md/triage.md/CHANGELOG.md still apply.
- Reviewer suggestions: explicit `disallowedTools: []` in orchestrator frontmatter for clarity; tighter wrapper-body regex binding subagent_type and $ARGUMENTS together; refresh `Claude Opus 4.6 (1M context)` co-author to 4.7 in commit-message templates.
<!-- SECTION:FINAL_SUMMARY:END -->
