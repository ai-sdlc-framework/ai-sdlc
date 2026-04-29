---
name: execute
description: Execute a backlog task end-to-end via subagents — worktree → developer → reviews → PR. Spawns the execute-orchestrator subagent so multiple invocations from the main session can fan out in parallel.
argument-hint: <task-id>
allowed-tools: Task
model: inherit
---

Execute backlog task `$ARGUMENTS` by spawning the `execute-orchestrator` subagent. The orchestrator runs the full Step 0-13 pipeline (worktree → developer → 3 parallel reviews → attestation → PR) and returns a structured JSON summary.

## Why an orchestrator subagent (not inline body)?

Originally the Step 0-13 recipe lived in this command body and ran in the main session. That made parallel runs impossible — every subagent invoked from the body (`developer`, the three reviewers, etc.) declares `disallowedTools: [AgentTool]` to prevent recursive spawning, and the main session's body is sequential by construction.

`execute-orchestrator` is the one and only plugin agent with `Task` in its tools list. Moving the recipe into that agent makes parallel runs first-class:

- One `/ai-sdlc execute <id>` invocation → main session fires one `Task(execute-orchestrator)` → orchestrator drives one pipeline.
- N parallel runs → main session fires N `Task(execute-orchestrator)` calls **in a single message** → all N orchestrators run concurrently, each in their own worktree, with independent per-worktree `.active-task` sentinels (AISDLC-81), independent developer + reviewer fan-outs, and independent PRs.

`/loop /ai-sdlc:execute <task-id>` continues to work unchanged — `/loop` fires one Task at a time, which composes naturally with the new design.

## Scaling notes

- **Reviewer concurrency**: each orchestrator spawns 3 reviewer subagents in parallel (Step 7), so the worst-case concurrent reviewer count is `3N` for N parallel runs. Reviewers are read-only and the file system handles concurrent reads fine.
- **`pre-push` serialisation**: the husky `pre-push` hook in `.husky/pre-push` serialises across orchestrators when multiple finish at the same moment, but only at the push boundary (Step 11). Steps 5-10 (developer + reviews + attestation) run fully in parallel.
- **Per-worktree sentinels**: AISDLC-81 moved the active-task sentinel from the project-level `.worktrees/.active-task` to per-worktree `.worktrees/<id>/.active-task`. This is the hard dependency that makes parallel runs safe — each orchestrator's developer subagent resolves `permittedExternalPaths` from its own sentinel without racing the others.

## Orchestration

Spawn the orchestrator via the Task tool:

- `subagent_type: execute-orchestrator`
- `prompt: "$ARGUMENTS"` (the task ID is the only argument the orchestrator needs)

When the orchestrator returns its JSON, surface the final summary block (the `Task: ... Branch: ... PR: ...` lines from its Step 13) plus the PR URL. If `outcome` is `developer-failed` or `aborted`, surface the `notes` field so the operator knows what to fix.

## What this command DOES NOT do (intentional)

- **Never runs `gh pr merge`.** The orchestrator never merges; only humans merge. Per CLAUDE.md.
- **Never runs `git push --force`.** The orchestrator aborts on non-fast-forward push.
- **Never edits `.ai-sdlc/**` or `.github/workflows/**`.** Both the PreToolUse hook and the orchestrator's hard rules block this.
- **Never spawns more than one orchestrator from a single `/ai-sdlc execute` invocation.** Parallel runs are achieved by the operator (or `/loop`) firing the slash command multiple times — each invocation gets its own orchestrator subagent.
