---
id: AISDLC-485
title: >-
  Fix execute-parallel spawned sessions hang on permission prompts
status: To Do
assignee: []
created_date: '2026-05-31 00:00'
labels:
  - bug
  - dispatch
  - parallelism
  - autonomy
  - execute-parallel
dependencies: []
references: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## Context

Live test 2026-05-31: operator ran `/ai-sdlc execute-parallel --tasks AISDLC-474,AISDLC-472`. The tmux wrapper correctly spawned session `ai-sdlc-parallel` with windows `exec-aisdlc-474` and `exec-aisdlc-472`, and both pipelines ran Steps 0–5 fine. Both froze immediately after: the `ai-sdlc:developer` subagent's Edit tool fired an interactive permission prompt (`Do you want to make this edit to <file>? 1.Yes 2.Yes,allow all 3.No`) that cannot be answered in a detached, unattended tmux pane. Heartbeats in `.ai-sdlc/dispatch/sessions/<id>.session.json` froze the instant the prompt appeared.

Root cause is in `ai-sdlc-plugin/commands/execute-parallel.md` around lines 360–363. The spawn is:

```bash
tmux new-window \
  -t "$TMUX_SESSION" \
  -n "$TMUX_WINDOW" \
  "claude /ai-sdlc execute $TASK_ID; read -rp 'Session for $TASK_ID complete. Press Enter to close.' _"
```

The spawned `claude` receives no `--dangerously-skip-permissions` (or equivalent) flag, so every Edit/Bash/Write tool call in the unattended pane blocks forever waiting for a human response.

This makes `/ai-sdlc execute-parallel` unusable for autonomous parallel dispatch — which is its entire purpose.

## Impact

`/ai-sdlc execute-parallel` is unusable for unattended or autonomous dispatch. Every spawned session hangs on the first tool-permission prompt (Edit/Write/Bash); the operator must manually attach to each tmux pane and type an approval, defeating the parallelism and the autonomy goal entirely. Confirmed in live test 2026-05-31: both AISDLC-474 and AISDLC-472 panes froze identically at the first Edit call. Heartbeat files stalled, no verdict was produced, no PR was opened.

## Proposed Fix

The spawned `claude` invocation in `execute-parallel.md` must run non-interactively. Three options for the implementer to evaluate (with operator confirmation for security-posture choices):

**(a) Pass `--dangerously-skip-permissions` to the spawned `claude`** — simplest, appropriate because the operator explicitly opted in to autonomous parallel dispatch. This flag should be gated behind the existing execute-parallel confirmation step so it is never silent: the AskUserQuestion shown before spawning should state clearly that spawned sessions will run with reduced permission prompting. The spawn line becomes:

```bash
"claude --dangerously-skip-permissions /ai-sdlc execute $TASK_ID; read -rp '...' _"
```

**(b) Pre-seed a per-worktree permission allowlist** so the common dev tools (Edit/Write/Bash on repo paths) are pre-approved before the window opens. More surgical but adds worktree-setup complexity.

**(c) Set an env var** that the spawned session reads to auto-approve routine tool calls. Feasibility must be confirmed (Claude Code must expose such a mechanism) before committing to this path.

Option (a) is the recommended path given the operator's explicit autonomous-dispatch intent, but the `--dangerously-skip-permissions` default is a security-posture decision that must surface to the operator (Decision Catalog pattern) before being adopted — it must not be silently defaulted in the spawn.

Cross-reference: AISDLC-480 (AskUserQuestion routing to Decision Catalog) and AISDLC-481 (session IPC) are the related autonomy-gap family — this bug is the lower-level tool-permission layer that sits beneath both.

## Acceptance Criteria

- [ ] #1 `/ai-sdlc execute-parallel` spawns sessions that do NOT hang on routine tool-permission prompts (Edit/Write/Bash) — verified by a parallel run that completes Steps 0–13 to PR-open with no manual pane attachment.
- [ ] #2 The permission-skip behavior is opt-in and surfaced in the execute-parallel confirmation step: the operator explicitly acknowledges that spawned sessions will run with reduced permission prompting before any windows are opened. It is never silently defaulted.
- [ ] #3 The spawn command in `execute-parallel.md` is updated accordingly, and `execute-parallel-status` and `execute-parallel-cleanup` remain consistent with the new spawn contract.
- [ ] #4 A hermetic test asserts that the spawn command includes the permission-handling flag or mechanism when the opt-in path is activated.
- [ ] #5 Docs: the parallel-dispatch runbook notes the permission model for spawned sessions and the security trade-off (reduced prompting in exchange for autonomous operation).
- [ ] #6 The fix composes with AISDLC-480: a spawned session that encounters a genuine AskUserQuestion (non-tool decision) routes to the Decision Catalog rather than hanging indefinitely.

<!-- SECTION:DESCRIPTION:END -->
