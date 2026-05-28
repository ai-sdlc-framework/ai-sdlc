---
id: AISDLC-462
title: >-
  feat: /ai-sdlc execute-parallel — tmux N-pane wrapper for concurrent Step 0-13
  dispatch with Dispatch Board coordination
status: To Do
assignee: []
created_date: '2026-05-28 19:02'
labels:
  - feature
  - dispatch
  - parallelism
  - tmux
  - infrastructure
  - stopgap
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-28 after evaluating Claude Code Agent Teams as a scaling solution for `/ai-sdlc execute`. Agent Teams was rejected: teammates inherit subagent tool restrictions and cannot use the `Agent` tool, so a teammate running `/ai-sdlc execute AISDLC-N` would fail at the first `Agent(developer)` call.

This task is the **interim solution** until a planned distributed LLM-worker scheduler RFC ships. It implements a one-level-higher version of what Agent Teams does: spawns N independent Claude Code sessions in tmux panes, each running `/ai-sdlc execute AISDLC-N` end-to-end with full Step 0-13 pipeline access, coordinated via the existing Dispatch Board substrate.

## Operator vision (verbatim paraphrase from the design conversation)

> "Develop a Wrapper script for N-pane spawn, essentially doing what agent teams does but a level higher so we truly do get N independent CC sessions, we just need to co-ordinate communication between the sessions like the way agent teams does. Max of 5 sessions seems about right from my experience of 4 agents running concurrently. there can be spikes of the 4 agents all running the reviewers at the same time and getting around 12 subagents running concurrently can spike my CPU and memory usage."

## Design decisions (operator-confirmed via decision-rubric 2026-05-28)

1. **Multiplexer**: tmux (cross-platform, scriptable, panes survive operator detach)
2. **Task selection**: hybrid — wrapper auto-suggests top N from `cli-deps frontier --check-dispatch-readiness`, operator confirms via AskUserQuestion before spawn
3. **Resource gate**: one-shot pre-spawn check on `vm_stat` available memory + load average; refuse spawn if avail mem < 4GB OR load avg > number-of-cores
4. **Entry point**: new slash command `/ai-sdlc execute-parallel` in `ai-sdlc-plugin/commands/`
5. **Hard cap**: 5 sessions maximum (operator-experience-grounded — 5 × 3 reviewers = ~15 subagents at peak, matches observed CPU/mem spike threshold)

## Architecture

### Wrapper flow

```
/ai-sdlc execute-parallel [--count N] [--tasks AISDLC-N,...]

1. Read frontier via `cli-deps frontier --format json --check-dispatch-readiness`
2. Filter to dispatchable, dispatch-readiness=ready, no open PR on branch
3. Auto-suggest top N (default N=4, max N=5)
4. AskUserQuestion: present candidates, operator confirms / swaps
5. Per task:
   a. Pre-flight: resource gate (vm_stat + load avg), no duplicate worktree, hard cap not exceeded
   b. Reserve: write .ai-sdlc/dispatch/sessions/<task-id>.session.json with {tmuxWindow, status: 'starting', startedAt}
   c. Spawn: tmux new-window -n "exec-<id>" "claude /ai-sdlc execute <id>"
   d. Log: tail pane stdout to .ai-sdlc/dispatch/sessions/<task-id>.log
6. Print central status table (5-row table: task | pane | status | PR# | last heartbeat)
7. Return — operator can attach to any pane via `tmux attach -t <session>` or wait for completion
```

### Coordination substrate (Dispatch Board extension)

New subdir: `.ai-sdlc/dispatch/sessions/`

Per-session JSON file format (`<task-id-lower>.session.json`):

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-453",
  "tmuxSession": "ai-sdlc-parallel",
  "tmuxWindow": "exec-aisdlc-453",
  "paneId": "%14",
  "spawnedAt": "2026-05-28T18:30:00Z",
  "status": "starting" | "in-progress" | "done" | "failed",
  "currentStep": "07-reviewers-running",
  "lastHeartbeat": "2026-05-28T18:35:12Z",
  "prUrl": null,
  "prNumber": null | 800
}
```

Heartbeat protocol: spawned CC's `/ai-sdlc execute` body updates `currentStep` + `lastHeartbeat` after each Step 0-13 transition. Final write sets `status: 'done'` + `prUrl`. (Implementation: extend existing Step progress markers to write into the session file when one exists.)

Mutual-awareness check: before spawn, wrapper reads `sessions/` to confirm task isn't already dispatched by another pane.

### Companion commands

- `/ai-sdlc execute-parallel-status` — reads `sessions/`, renders live table (task | pane | status | step | PR | heartbeat-age)
- `/ai-sdlc execute-parallel-cleanup` — lists in-flight panes, AskUserQuestion to confirm, then `tmux kill-window` for each + archive session files

## Acceptance Criteria
<!-- AC:BEGIN -->
(See below for the structured list.)

## Out of scope (defer to RFC-461 or follow-ups)

- Multi-machine workers (single-host only for v1)
- Continuous resource telemetry (one-shot pre-spawn check only)
- Subscription burn-rate tracking + pacing
- Cross-org scheduling
- Operator TUI dashboard beyond the basic status table
- Auto-restart of failed panes
- Linux/Windows multiplexer support (macOS + tmux only for v1)

## Why this is "interim"

RFC-461 designs the proper distributed scheduler with multi-host, subscription-burn pacing, multi-tenant isolation, etc. This task ships single-host parallelism FAST so the operator can move backlog work in parallel today, and validates the Dispatch Board `sessions/` schema that RFC-461 Phase 1 will extend.

## References

- RFC-461 — distributed scheduler RFC (parent vision, planned)
- ai-sdlc-plugin/commands/execute.md — the slash command being parallelized
- pipeline-cli/src/dispatch/board.ts — existing Dispatch Board substrate
- ai-sdlc-plugin/commands/dispatch-worker.md — existing Pattern Z manual sibling-session command (this task supersedes it for operator-driven use)
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 New slash command `/ai-sdlc execute-parallel` exists at `ai-sdlc-plugin/commands/execute-parallel.md` with proper frontmatter (name, description, allowed-tools)
- [ ] #2 Wrapper reads `cli-deps frontier --format json --check-dispatch-readiness` and filters to truly dispatchable (no open PR on branch, no existing worktree)
- [ ] #3 Hybrid task selection: AskUserQuestion presents top N candidates (default N=4, max N=5) for operator confirm/swap before spawn
- [ ] #4 Pre-spawn resource gate: refuse if `vm_stat` available pages < ~4GB OR `sysctl -n vm.loadavg` 1-min > `sysctl -n hw.ncpu` cores
- [ ] #5 Hard cap: maximum 5 concurrent sessions enforced via `tmux list-windows` count + sessions/ subdir count
- [ ] #6 Spawn mechanism: `tmux new-session -d -s ai-sdlc-parallel` (idempotent) + `tmux new-window -n exec-<task-id> "claude /ai-sdlc execute <task-id>"`
- [ ] #7 Coordination substrate: new `.ai-sdlc/dispatch/sessions/` subdir; per-task `<task-id-lower>.session.json` file with v1 schema (taskId, tmuxWindow, paneId, status, currentStep, lastHeartbeat, prUrl, prNumber)
- [ ] #8 Heartbeat protocol: `/ai-sdlc execute` body updates the session file's currentStep + lastHeartbeat after each Step 0-13 transition when one exists for the task
- [ ] #9 Mutual-awareness check: wrapper refuses to spawn a task already in `sessions/` with status != 'done' | 'failed'
- [ ] #10 Companion command `/ai-sdlc execute-parallel-status` exists and renders live table from `sessions/`
- [ ] #11 Companion command `/ai-sdlc execute-parallel-cleanup` exists, lists in-flight panes, AskUserQuestion to confirm before `tmux kill-window` + archiving session files to `sessions/archived/`
- [ ] #12 Hermetic tests: mock tmux invocations + vm_stat + frontier output; verify spawn logic, cap enforcement, resource-gate refusal, mutual-awareness skip
- [ ] #13 Operator runbook: new section in `docs/operations/parallel-dispatch.md` covering activation, monitoring, cleanup, troubleshooting
- [ ] #14 README: brief mention in `ai-sdlc-plugin/README.md` Canonical Execution Paths table
<!-- AC:END -->
