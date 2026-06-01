# Parallel Dispatch — `/ai-sdlc execute-parallel` Operator Runbook

**AISDLC-462** — tmux N-pane wrapper for concurrent Step 0-13 dispatch.

This is the **interim parallelism solution** until RFC-461 (distributed LLM-worker
scheduler) ships. It spawns N independent Claude Code sessions in tmux panes, each
running `/ai-sdlc execute AISDLC-N` end-to-end with full Step 0-13 pipeline access.

## Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Permission model for spawned sessions](#permission-model-for-spawned-sessions)
- [Activation](#activation)
- [Monitoring](#monitoring)
- [Liveness detection and session reaper](#liveness-detection-and-session-reaper)
- [Cancel back-channel](#cancel-back-channel)
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

## Permission model for spawned sessions

**AISDLC-485 / DEC-0009** — This section documents the permission posture for
sessions spawned by `/ai-sdlc execute-parallel`.

### Why permission handling matters

Each spawned tmux pane runs `claude /ai-sdlc execute <task-id>` in a **detached,
unattended** context. The default Claude Code interactive mode prompts the operator
for approval on every Edit/Write/Bash tool call:

```
Do you want to make this edit to <file>?
  1. Yes
  2. Yes, allow all
  3. No
```

In an unmanned tmux pane this prompt **blocks forever** — the heartbeat file stalls,
no PR is opened, and the entire session hangs until the operator manually attaches
and types an approval. This makes parallel dispatch unusable for autonomous drains.

### The `--dangerously-skip-permissions` flag (opt-in)

The fix is to pass `--dangerously-skip-permissions` to the spawned `claude` invocation.
This flag tells the Claude CLI to skip per-tool interactive approvals so the session
can complete end-to-end without operator intervention.

**This flag is OPT-IN.** It is never silently applied. At the confirmation step
(`/ai-sdlc execute-parallel`), the operator receives an explicit prompt:

> **Permission model for spawned sessions (required acknowledgement):**
> ...
> Reply **yes** to confirm spawning WITH `--dangerously-skip-permissions` (recommended)
> Reply **yes-no-skip** to spawn WITHOUT the flag (sessions may block)

The operator must explicitly reply **yes** to enable the flag. The default (`yes-no-skip`)
leaves the flag off.

### Security trade-off

| Aspect | With `--dangerously-skip-permissions` | Without |
|--------|--------------------------------------|---------|
| Tool prompts (Edit/Write/Bash) | Skipped — sessions complete autonomously | Shown — sessions block in unmanned panes |
| AskUserQuestion (non-tool) | Routed to Decision Catalog (AISDLC-480) | Shown in tmux pane |
| Appropriate for | Autonomous drain with trusted backlog tasks in isolated worktrees | Operator-attached interactive sessions |
| Risk | Spawned claude can edit files within the repo without per-edit approval | Sessions hang on first tool call |

### When to use each mode

**Use `--dangerously-skip-permissions` (reply "yes")** when:
- Running an overnight or unattended parallel drain
- Tasks are standard backlog items executed by the AI-SDLC developer subagent
- Each task runs in its own isolated worktree (Pattern C isolation is active)
- You trust the task implementations that will be dispatched

**Use interactive mode (reply "yes-no-skip")** when:
- You plan to stay attached to the tmux session and monitor each pane
- Tasks involve sensitive operations you want to approve individually
- You're debugging a specific task implementation

### Composition with AISDLC-480

When AISDLC-480 ships, genuine `AskUserQuestion` calls (non-tool decisions, e.g.
"which approach should I take for this ambiguous requirement?") inside a spawned
session are routed to the Decision Catalog rather than blocking in the unmanned
pane. Until AISDLC-480 is implemented, non-tool decisions will surface in the
tmux pane — the operator must attach to the pane to answer, or the session will
eventually time out per its own watchdog.

`--dangerously-skip-permissions` only suppresses **tool-level** permission prompts
(Edit/Write/Bash). It does NOT suppress `AskUserQuestion` calls — those are a
different escalation mechanism.

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

## Liveness detection and session reaper

**AISDLC-481** — the session reaper detects sessions that have stopped
heartbeating and marks them `failed` automatically.

### How liveness works

Every `/ai-sdlc execute` session writes `lastHeartbeat` to its session file
(`.ai-sdlc/dispatch/sessions/<task-id>.session.json`) at each Step 0-13
transition via `update_session_state`. The reaper (`reapStaleSessions` in
`pipeline-cli/src/dispatch/session-reaper.ts`) compares the current wall time
against `lastHeartbeat` (falling back to `spawnedAt` when no heartbeat has
been written yet).

**Default threshold: 30 minutes.** Sessions whose heartbeat anchor is older
than 30 minutes are reaped. This matches the Dispatch Board inflight sweeper
threshold (RFC-0041 OQ-3) so the two substrates have identical liveness
windows.

### Two-substrate reconciliation

The execute-parallel coordination layer has two independent substrates that
track session state:

| Substrate | File location | Purpose |
|-----------|--------------|---------|
| **Session file substrate** | `.ai-sdlc/dispatch/sessions/<task>.session.json` | tmux/execute-parallel coordination |
| **Dispatch Board substrate** | `.ai-sdlc/dispatch/inflight/<task>.dispatch.json` + `.state.json` | Conductor/Worker Dispatch Board (RFC-0041) |

When a session dies, both substrates must be updated consistently — an orphan
in one while the other shows the session alive creates a false-positive
"still running" state.

The reaper reconciles both:

1. **Session file reap**: when `lastHeartbeat` is stale, marks the session
   file `status: failed`.
2. **Board reconcile**: sweeps the Dispatch Board inflight entry for the same
   `taskId`. If an inflight entry exists, it is moved to `failed/` with a
   `stale-heartbeat` diagnostic. If no inflight entry exists (the session was
   a pure tmux session without a board manifest), a diagnostic is still written
   to `failed/` so the Conductor's verdict poll records the event.
3. **Board-only orphan sweep**: after the session-file pass, a board-level
   sweep catches inflight entries that have no corresponding session file
   (Workers that don't use execute-parallel). These appear in
   `SessionReaperResult.boardOnlyReaped`.

### When the reaper runs

The reaper is invoked automatically by `execute-parallel-status` on every
status table refresh. You can also invoke it programmatically:

```typescript
import { reapStaleSessions } from '@ai-sdlc/pipeline-cli';

const result = reapStaleSessions({
  boardDir: '.ai-sdlc/dispatch',
  staleMs: 30 * 60 * 1000, // 30 minutes (default)
});
// result.reaped[].taskId — session-file reaped tasks
// result.boardOnlyReaped[] — board-only reaped task IDs
```

### Manual inspection

```bash
# Check a session file's last heartbeat
cat .ai-sdlc/dispatch/sessions/aisdlc-462.session.json | jq '.lastHeartbeat, .status'

# Check board inflight state
ls .ai-sdlc/dispatch/inflight/
cat .ai-sdlc/dispatch/inflight/AISDLC-462.state.json | jq '.lastHeartbeat'
```

If a session appears stuck (heartbeat age > 30 min), the reaper will clean it
up on the next status refresh. You can force a reap cycle by running:

```bash
/ai-sdlc execute-parallel-status
```

---

## Cancel back-channel

**AISDLC-481 v1 scope: cancel-only.** Full pause/resume is a deliberate
follow-up. This section documents the cancel mechanism.

### What the cancel back-channel does

The orchestrator (or an operator script) writes a cancel control signal to
`.ai-sdlc/dispatch/sessions/<task-id>.cancel.json`. A running
`/ai-sdlc execute` session reads this file at its **step boundaries** (after
Step 1, before Step 5, after Step 6, after Step 7c) and performs a clean abort
when the signal is present.

On cancel:
1. The cancel signal file is removed (idempotent — no spurious re-cancel on restart).
2. The session file status is updated to `cancelled`.
3. A board diagnostic is written to `.ai-sdlc/dispatch/failed/` so the
   Conductor's verdict poll sees the cancellation.
4. The pipeline exits 1.

### Cancel signal schema

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-462",
  "cancelledAt": "2026-06-01T10:00:00.000Z",
  "reason": "operator requested cancel via UI",
  "cancelledBy": "conductor-session-abc"
}
```

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `schemaVersion` | Yes | Always `v1` |
| `taskId` | Yes | Task ID matching the session |
| `cancelledAt` | Yes | ISO-8601 timestamp of signal write |
| `reason` | No | Human-readable reason (audit trail) |
| `cancelledBy` | No | Orchestrator / operator session identifier |

### Writing a cancel signal

#### Via TypeScript (orchestrator-side)

```typescript
import { writeCancelSignal } from '@ai-sdlc/pipeline-cli';

writeCancelSignal('.ai-sdlc/dispatch', {
  schemaVersion: 'v1',
  taskId: 'AISDLC-462',
  cancelledAt: new Date().toISOString(),
  reason: 'operator requested cancel',
  cancelledBy: 'conductor-session-xyz',
});
```

#### Via shell (operator script)

```bash
node -e "
  const fs = require('fs');
  const taskId = 'AISDLC-462';
  const signal = {
    schemaVersion: 'v1',
    taskId,
    cancelledAt: new Date().toISOString(),
    reason: 'manual operator cancel',
    cancelledBy: 'operator-shell',
  };
  const dir = '.ai-sdlc/dispatch/sessions';
  fs.mkdirSync(dir, { recursive: true });
  const tmp = dir + '/' + taskId.toLowerCase() + '.cancel.json.tmp';
  const target = dir + '/' + taskId.toLowerCase() + '.cancel.json';
  fs.writeFileSync(tmp, JSON.stringify(signal, null, 2));
  fs.renameSync(tmp, target);
  console.log('cancel signal written for', taskId);
"
```

### When is the cancel signal read?

The session checks for the cancel signal at these step boundaries:

| After step | Why |
|------------|-----|
| Step 1 (argument validation) | Earliest safe abort — before any state mutation |
| Before Step 5 (developer subagent) | Prevent starting a long-running developer invocation |
| After Step 6 (developer completes) | Before starting expensive review fan-out |
| After Step 7c (reviews complete) | Before committing / pushing |

The cancel is **clean** — no partial commits are left; the session terminates
at a safe boundary. The worktree is preserved on disk for operator inspection
(same behavior as a developer failure).

### Composing with AISDLC-480 (decision routing)

This task's cancel back-channel composes with AISDLC-480's decision routing:

- AISDLC-480 routes an operator question out of a running session to the
  Decision Catalog.
- AISDLC-481 (this task) carries back the control signal (cancel or, in a
  future follow-up, an answer) to the waiting session.

In v1, when a session is waiting for an operator decision (blocked at an
`AskUserQuestion` boundary), the orchestrator can write a cancel signal to
abort cleanly while emitting the `decisionId` in the diagnostic so the audit
trail records which question triggered the cancel.

```bash
# Cancel a session and record the associated decision ID.
node -e "
  const fs = require('fs');
  const signal = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-462',
    cancelledAt: new Date().toISOString(),
    reason: 'blocked on DEC-0042 — cancelling while decision is pending',
    cancelledBy: 'orchestrator',
    decisionId: 'DEC-0042',
  };
  const f = '.ai-sdlc/dispatch/sessions/aisdlc-462.cancel.json';
  fs.writeFileSync(f, JSON.stringify(signal, null, 2));
"
```

Full pause/resume (the session waits, receives the operator answer, and
resumes from where it was blocked) is tracked as a follow-up to this task.

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

### Sessions hang immediately — heartbeat stalls after start

**Symptom:** A session shows `starting` for more than 2 minutes, then transitions to
`in-progress` for a few seconds, then heartbeats stop. Attaching to the pane reveals
an interactive prompt like:

```
Do you want to make this edit to <file>?
  1. Yes
  2. Yes, allow all
  3. No
```

**Cause:** You spawned sessions WITHOUT `--dangerously-skip-permissions` (replied
`yes-no-skip` or ran the command before AISDLC-485). Detached pane sessions cannot
answer interactive tool-permission prompts.

**Fix:** Run `/ai-sdlc execute-parallel-cleanup` to kill the stuck sessions, then
re-run `/ai-sdlc execute-parallel` and reply **yes** at the confirmation step to
enable `--dangerously-skip-permissions`. See the
[permission model section](#permission-model-for-spawned-sessions) for details.

---

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
| `failed` | Session crashed, was killed, or heartbeat became stale (reaped) | Run cleanup, then re-dispatch |
| `cancelled` | Session received and honored a cancel control signal (AISDLC-481) | Review diagnostic in `.ai-sdlc/dispatch/failed/` if needed |

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
