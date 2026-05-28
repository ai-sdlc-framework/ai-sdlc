# Parallel Dispatch — `/ai-sdlc execute-parallel` Operator Runbook

**AISDLC-462** — tmux N-pane wrapper for concurrent Step 0-13 dispatch.

This is the **interim parallelism solution** until RFC-461 (distributed LLM-worker
scheduler) ships. It spawns N independent Claude Code sessions in tmux panes, each
running `/ai-sdlc execute AISDLC-N` end-to-end with full Step 0-13 pipeline access.

## Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Activation](#activation)
- [Monitoring](#monitoring)
- [Cleanup](#cleanup)
- [Troubleshooting](#troubleshooting)
- [Session file schema](#session-file-schema)
- [Status definitions](#status-definitions)

---

## Overview

| Property | Value |
|----------|-------|
| Max concurrent sessions | 5 |
| Multiplexer | tmux (macOS only, v1) |
| Session coordination | `.ai-sdlc/dispatch/sessions/<task-id>.session.json` |
| Resource gate | `vm_stat` available pages ≥ 4 GB AND 1-min load avg < ncpu |
| Task selection | Auto-suggest from frontier; operator confirms |

### Why tmux?

Each `/ai-sdlc execute` session needs its own independent Claude Code process with:
- Its own `Agent` tool grant (plugin subagents cannot spawn sub-agents)
- Its own worktree, signing key access, and operator filesystem
- Its own tmux pane that survives operator detach

tmux panes each run `claude /ai-sdlc execute <task-id>` independently, sharing
nothing except the git repo and the `.ai-sdlc/dispatch/sessions/` coordination
substrate.

---

## Prerequisites

1. **tmux installed** — `brew install tmux` if missing.
2. **`claude` CLI on PATH** — required for `claude /ai-sdlc execute` invocations.
3. **Signing key** — `~/.ai-sdlc/signing-key.pem` must exist for attestation.
4. **Task files in `backlog/tasks/`** — at least one task with dispatch-ready status.

Check with:

```bash
which tmux && which claude && ls ~/.ai-sdlc/signing-key.pem
```

---

## Activation

### 1. Basic: auto-suggest 4 tasks

```bash
# In any Claude Code session:
/ai-sdlc execute-parallel
```

This reads the frontier, presents the top 4 dispatch-ready candidates, and asks
for confirmation before spawning.

### 2. Custom count

```bash
/ai-sdlc execute-parallel --count 3
```

Spawns up to 3 sessions (still capped at 5 total including already-running ones).

### 3. Explicit task list

```bash
/ai-sdlc execute-parallel --tasks AISDLC-462,AISDLC-463,AISDLC-464
```

Bypasses frontier query; uses the specified task IDs. Still applies mutual-awareness
and cap checks per task.

### Resource gate override (testing only)

```bash
AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 /ai-sdlc execute-parallel
```

Skips the memory + load average check. Use only in controlled environments.

---

## Monitoring

### Live status table

```bash
/ai-sdlc execute-parallel-status
```

Output example:

```
AI-SDLC Parallel Execute Status (2026-05-28T18:35:00Z)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task               Window                 Status       Step                 PR         Heartbeat
────────────────────────────────────────────────────────────────────────────
AISDLC-462         exec-aisdlc-462        in-progress  07-reviewers-running #800       2m ago
AISDLC-463         exec-aisdlc-463        in-progress  05-dev-running       —          5m ago
AISDLC-464         exec-aisdlc-464        done         done                 #802       8m ago
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Attach to a running session

```bash
# Attach to the shared tmux session
tmux attach -t ai-sdlc-parallel

# Navigate between windows:
# Ctrl-b then w  → interactive window list
# Ctrl-b then '  → select window by name
# Ctrl-b then n  → next window

# Detach without killing:
# Ctrl-b then d
```

### Watch a specific task's pane

```bash
# List windows
tmux list-windows -t ai-sdlc-parallel

# Select a specific window
tmux select-window -t ai-sdlc-parallel:exec-aisdlc-462
```

### Check session files directly

```bash
ls .ai-sdlc/dispatch/sessions/
cat .ai-sdlc/dispatch/sessions/aisdlc-462.session.json
```

---

## Cleanup

### Cleanup all sessions

```bash
/ai-sdlc execute-parallel-cleanup
```

This lists all sessions (active + terminal), asks for confirmation, kills in-progress
tmux windows, and archives session files to `.ai-sdlc/dispatch/sessions/archived/`.

### Cleanup specific tasks

```bash
/ai-sdlc execute-parallel-cleanup --tasks AISDLC-462,AISDLC-463
```

### Manual tmux cleanup (emergency)

```bash
# Kill a specific window
tmux kill-window -t ai-sdlc-parallel:exec-aisdlc-462

# Kill the entire session (kills ALL panes)
tmux kill-session -t ai-sdlc-parallel
```

After killing manually, archive the session files:

```bash
mv .ai-sdlc/dispatch/sessions/aisdlc-462.session.json \
   .ai-sdlc/dispatch/sessions/archived/
```

---

## Troubleshooting

### "Resource gate refused — available memory < 4GB"

The system has less than 4 GB of available memory (free + inactive + speculative pages
from `vm_stat`). Wait for existing sessions to complete their review step (the heaviest
point), or close other applications, then retry.

Override for testing:

```bash
AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 /ai-sdlc execute-parallel
```

### "Resource gate refused — 1-min load avg >= ncpu"

The system's 1-minute load average equals or exceeds the number of CPU cores. This
typically happens when 4+ review subagents are running concurrently (each session
spawns up to 3 reviewers; with 5 sessions that can be 15 subagents at peak). Wait a
few minutes for the current wave of reviews to complete, then retry.

### "Hard cap of 5 sessions already reached"

Five sessions are already active. Check their status:

```bash
/ai-sdlc execute-parallel-status
```

If some are done/failed but the session files weren't cleaned up:

```bash
/ai-sdlc execute-parallel-cleanup
```

### "SKIP TASK — already active (status=starting/in-progress)"

A session file already exists for that task with a non-terminal status. Either:
- The task is genuinely running in another pane — attach and check.
- The prior session crashed without updating its status to `failed`. Manual fix:

```bash
node -e "
  const fs = require('fs');
  const f = '.ai-sdlc/dispatch/sessions/aisdlc-462.session.json';
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.status = 'failed';
  s.lastHeartbeat = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
"
```

Then retry `/ai-sdlc execute-parallel`.

### Session shows `starting` for more than 5 minutes

The tmux window spawned but `claude /ai-sdlc execute` hasn't emitted its first heartbeat.
Possible causes:
- `claude` CLI is not on PATH in the tmux environment.
- The task's dependency preflight failed immediately.
- The CCR guard refused the session (check for CCR env vars in your tmux environment).

Attach and inspect:

```bash
tmux attach -t ai-sdlc-parallel
# Select the stuck window and read the output
```

### PR URL not appearing in status table

The session may still be in Step 1-10 (before the PR is opened). The PR URL is written
to the session file after Step 11b (PR creation). During Steps 1-10, the `PR` column
shows `—`.

### Heartbeat age very stale (> 10 minutes) during `in-progress`

The session may be stuck waiting for:
- A long `pnpm test` run (normal for large test suites)
- A reviewer subagent with a very long diff to analyze
- An operator input prompt inside the tmux pane

Attach to the pane to check:

```bash
tmux attach -t ai-sdlc-parallel
```

---

## Session file schema

Session files live at `.ai-sdlc/dispatch/sessions/<task-id-lower>.session.json`.
Full schema: `spec/schemas/dispatch-session.v1.schema.json`.

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-462",
  "tmuxSession": "ai-sdlc-parallel",
  "tmuxWindow": "exec-aisdlc-462",
  "paneId": "%14",
  "spawnedAt": "2026-05-28T18:30:00Z",
  "status": "in-progress",
  "currentStep": "07-reviewers-running",
  "lastHeartbeat": "2026-05-28T18:35:12Z",
  "prUrl": null,
  "prNumber": null
}
```

After PR creation:

```json
{
  ...
  "status": "done",
  "currentStep": "done",
  "prUrl": "https://github.com/ai-sdlc-framework/ai-sdlc/pull/800",
  "prNumber": 800
}
```

---

## Status definitions

| Status | Description | Next action |
|--------|-------------|-------------|
| `starting` | tmux window created; `claude` not yet running | Wait 30-60s then check |
| `in-progress` | Pipeline running; heartbeats flowing | Monitor with status command |
| `done` | `/ai-sdlc execute` completed; PR opened | Review the PR |
| `failed` | Session crashed or was killed manually | Run cleanup, then re-dispatch |

---

## Heartbeat step names

The `currentStep` field shows which Step 0-13 the session last completed:

| Step name | Description |
|-----------|-------------|
| `01-validated` | Task argument parsed and validated |
| `05-dev-running` | Developer subagent invoked |
| `06-dev-done` | Developer subagent returned |
| `07-reviewers-running` | Review fan-out started |
| `07c-leaves-emitted` | Transcript leaves emitted |
| `10-signing` | Pre-sign rebase complete |
| `11b-pr-opened` | Draft PR opened on GitHub |
| `done` | Pipeline complete; PR flipped to ready-for-review |

---

## Relation to existing dispatch patterns

| Pattern | When to use |
|---------|-------------|
| `/ai-sdlc execute <task-id>` | Single task, interactive session |
| `/ai-sdlc execute-parallel` | Multiple tasks, operator monitoring tmux |
| `/ai-sdlc orchestrator-tick` + `/ai-sdlc dispatch-worker` (Pattern Z) | Fully autonomous drain with Conductor/Worker separation |

`execute-parallel` is the simplest parallel path — operator stays in the loop,
each session is visible in tmux. Pattern Z is for autonomous overnight drains
where the operator is away.
