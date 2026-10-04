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
- [Watching the agents](#watching-the-agents)
- [Liveness detection and session reaper](#liveness-detection-and-session-reaper)
- [Cancel back-channel](#cancel-back-channel)
- [The executor loop](#the-executor-loop)
- [Cleanup](#cleanup)
- [Pre-push gate resource use](#pre-push-gate-resource-use)
- [Troubleshooting](#troubleshooting)
- [Session file schema](#session-file-schema)
- [Status definitions](#status-definitions)

---

## Overview

| Property                | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| Max concurrent sessions | 5                                                          |
| Multiplexer             | tmux (macOS only, v1)                                      |
| Session coordination    | `.ai-sdlc/dispatch/sessions/<task-id>.session.json`        |
| Resource gate           | `vm_stat` available pages ≥ 4 GB AND 1-min load avg < ncpu |
| Task selection          | Auto-suggest from frontier; operator confirms              |

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

| Aspect                         | With `--dangerously-skip-permissions`                                   | Without                                  |
| ------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- |
| Tool prompts (Edit/Write/Bash) | Skipped — sessions complete autonomously                                | Shown — sessions block in unmanned panes |
| AskUserQuestion (non-tool)     | Routed to Decision Catalog (AISDLC-480)                                 | Shown in tmux pane                       |
| Appropriate for                | Autonomous drain with trusted backlog tasks in isolated worktrees       | Operator-attached interactive sessions   |
| Risk                           | Spawned claude can edit files within the repo without per-edit approval | Sessions hang on first tool call         |

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

## Watching the agents

`cli-hierarchy up` starts the planner, the dispatch session and the executors as
**one detached tmux session per agent**. The tmux session name, its window name and
the agent name are the same (`planner`, `operator-dispatch`, `executor-alpha`, ...),
and the roster (`.ai-sdlc/dispatch/hierarchy.json`) records it as `tmuxSession`.
Agents do not share a session because two terminals attached to one session both
follow its current window: they can never show two different agents.

`up` prints one line per started agent with the command that shows it, and
`cli-hierarchy status` has an `ATTACHED` column (yes or no per session).

```bash
# Show one agent in this terminal
cli-hierarchy attach executor-alpha
```

`attach` runs `tmux switch-client` when `TMUX` is set (the terminal is already a
tmux client; attaching would nest) and `tmux attach-session` otherwise. An unknown
name fails and lists the names in the roster. `cli-hierarchy up --attach` does the
same for the planner, or for the dispatch session when no planner was started.

Each session sets its own terminal title to the agent name (`set-titles on` and
`set-titles-string`, scoped to that session) and shows the name in its status line.
No global tmux option is changed.

Safety: only the default agent names are ever acted on. In the per-agent layout a
roster entry is accepted only when its session and window are the same default name
(`planner`, `operator-dispatch`, `executor-alpha` to `executor-epsilon`); `up` cannot
produce any other name, and a hand-written roster entry with another name is ignored by
`status`, `attach`, `terminals`, `down` and `brief --notify` (it is reported as "not
touched"). That is deliberate and fails closed; it is not widened without an explicit
decision. A matching name is not proof that `up` created the session, so `up` also marks
every session it starts with the session option `@ai-sdlc-hierarchy` (session-scoped,
no global option), and `down` and `brief --notify` refuse to type into or close a
session without it, and refuse when a recorded pane id no longer belongs to the window.
A refused `down` leaves the entry in the roster and exits non-zero; your own tmux
session called `planner` is therefore never closed. Entries of the earlier layout
below predate the marker and have no ownership check.

A roster written by the earlier single-session layout (windows of one
`ai-sdlc-hierarchy` session) is still reported by `status` and stopped by `down`;
`up` refuses to start on top of it until `cli-hierarchy down` has been run.

### Optional: one VS Code terminal per agent

```bash
cli-hierarchy terminals --vscode            # writes .vscode/tasks.json
cli-hierarchy terminals --vscode --print    # print the JSON to merge by hand
cli-hierarchy terminals --vscode --out ./dir --force
```

This writes a task per agent (dedicated panel, running `cli-hierarchy attach <name>`)
plus a `hierarchy: open all agents` task that opens them all. It refuses to replace an
existing `tasks.json` without `--force`. It is a generator only; the tmux behaviour
above does not depend on VS Code. A VS Code terminal tab shows the agent title only
when the `terminal.integrated.tabs.title` setting includes `${sequence}`.

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

| Substrate                    | File location                                                     | Purpose                                    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| **Session file substrate**   | `.ai-sdlc/dispatch/sessions/<task>.session.json`                  | tmux/execute-parallel coordination         |
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

| Field           | Required | Description                                |
| --------------- | -------- | ------------------------------------------ |
| `schemaVersion` | Yes      | Always `v1`                                |
| `taskId`        | Yes      | Task ID matching the session               |
| `cancelledAt`   | Yes      | ISO-8601 timestamp of signal write         |
| `reason`        | No       | Human-readable reason (audit trail)        |
| `cancelledBy`   | No       | Orchestrator / operator session identifier |

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

| After step                         | Why                                                  |
| ---------------------------------- | ---------------------------------------------------- |
| Step 1 (argument validation)       | Earliest safe abort — before any state mutation      |
| Before Step 5 (developer subagent) | Prevent starting a long-running developer invocation |
| After Step 6 (developer completes) | Before starting expensive review fan-out             |
| After Step 7c (reviews complete)   | Before committing / pushing                          |

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

## The executor loop

In a session hierarchy, each executor session runs `/ai-sdlc executor` for its whole
life. The planner and dispatch sessions are covered by their own commands; this
section is the executor's side of the board.

One pass of the loop:

1. **Identify.** The executor reads the roster (`.ai-sdlc/dispatch/hierarchy.json`)
   and finds its own entry (the session whose process is the entry's `pid`) and the
   dispatch session's entry. The name is used exactly as the roster has it,
   including any collision suffix the harness added.
2. **Claim.** `cli-dispatch claim --worker-kind in-session-agent --worker <name>`
   moves the next eligible manifest to `inflight/` with `workerId` equal to the
   roster name. That equality is what lets `cli-hierarchy status` and `down` join an
   inflight task to its session. When nothing is eligible, the executor schedules a
   wake-up on the empty-queue interval (30 seconds, or
   `spec.inSessionAgent.emptyQueueHibernateSec` from the dispatch config) and tries
   again.
3. **Execute.** It runs `/ai-sdlc execute <task-id>` with the task id and no other
   argument. The pipeline is not modified for executors.
4. **Report.** `cli-dispatch complete --task-id <id> --outcome <outcome>
   --worker <name> [--pr <n>] [--follow-ups <ids>] [--decisions <ids>]` writes the
   verdict. `success` and `iterate-needed` land in `done/`; every other outcome
   lands in `failed/`. Every outcome except `iterate-needed` also removes the task
   from `inflight/`; on `iterate-needed` the inflight manifest stays, so the worker
   keeps the slot across the iteration. The verdict records the
   outcome, the pull request number, the follow-up task ids and the decision ids
   raised. The command refuses when the task is not inflight, when a follow-up id
   is not a sub-id of the task, and when `--worker` is missing or differs from the
   name recorded at claim time. That match guards against a mistake (a session
   completing the wrong task); it is not authentication, because the recorded name
   is readable from the inflight manifest.
5. **Tell the dispatch session.** One status line goes to the dispatch session:
   task, outcome, pull request, decision ids. It carries status only.
6. **Stop.** The dispatch session sees the verdict, clears the executor's context and
   issues `/ai-sdlc executor` again.

### After a clear

`/clear` keeps a session's name and permission mode but empties its context. The
plugin's `SessionStart` hook runs again with source `clear`; when the session is
named in the roster it injects a short block with the session's role, name, the
dispatch session's name and the command to run. The hook adds nothing for any other
source (`startup`, `resume`, `compact`) and nothing for a session that is not in the
roster. It finds its session by matching the roster's `pid` against the hook
process's ancestors.

### Follow-up task ids

An executor never files a top-level task id. A follow-up it discovers is filed as a
sub-id of its own task. `cli-dispatch next-subid <task-id>` prints the first
`<task-id>.<n>` that is free in all three places a sub-id can already exist:

- `backlog/` (task files, open and completed),
- the board (a manifest or verdict in any state),
- the file lists of open pull requests (`gh pr list`; when it cannot be reached the
  command warns, reports `"openPrScan":"unavailable"` and checks the first two only).

### Rules an executor keeps

- It never messages another executor.
- It never answers a decision, its own or another task's.
- It never edits an RFC's Open Questions.
- When it is blocked, it records the question with `cli-decisions escalate` and
  stops. The routing of that decision to the dispatch session or the planner is a
  separate step that is not part of this loop yet.

---

## The operator-dispatch loop

The dispatch session runs `/ai-sdlc operator-dispatch` on a wake-up interval (60
seconds). It owns throughput: it turns briefs into work, keeps the board moving,
clears each executor between tasks, unblocks what it is allowed to unblock and
reports to the planner. Each wake-up runs one command:

```bash
cli-hierarchy tick --worker <dispatch session name>
```

The command identifies its caller instead of trusting `--worker`: it finds the nearest
ancestor process that is a running roster entry and a claude process, and refuses,
writing and sending nothing, unless that session has the `operator-dispatch` role.
`--worker` is optional; when given it must equal the caller's own roster name. The
roster is read from the main checkout's board, never from a path the caller passes: the
command also refuses unless `--board-dir` and the working directory are the main
checkout's. Every
board write the loop makes carries that name. `cli-hierarchy clear` and
`cli-hierarchy route-decision` apply the same check. The command prints, as JSON, what
it did and what the session has to say.

1. **Ingest.** Each new `*.md` file in `.ai-sdlc/dispatch/briefs/` is parsed and
   enqueued with the same mapping as `cli-dispatch enqueue --from-brief`, then
   marked ingested in `.ai-sdlc/dispatch/operator-dispatch.state.json`. A later
   wake-up never enqueues it again. A brief the board refuses is reported and is
   retried only after the file changes.
2. **Verdict watch.** Each new verdict in `done/` or `failed/` is handled once. The
   executor that wrote it is cleared (below), then failures go through the
   unblocking playbook.
3. **Reports.** A progress line goes to the planner at the configured cadence
   (15 minutes by default, `--report-every-ms`), and a summary when every task of
   an ingested brief has reached a final state.

### The unblocking playbook

Every step is gated by the `operational` list in `spec.governance` of
`.ai-sdlc/agent-role.yaml` (read, never written, by the loop, and read only from the verified main checkout: the `.git` there must be a real directory, not a symlink, matching the git common dir; any doubt grants nothing) and is recorded as an
`OperatorPlaybookAction` event. A step the policy does not grant is refused and
becomes an escalation.

| Failure record | Action | Grant needed |
| --- | --- | --- |
| Mechanical conflict shape (`test-additions-overlap`, `prettier-drift`, `pnpm-lock-regen`, `package-json-bin-concat`, `behind-only`) | Rebase the task branch onto `origin/main`, then lease-push to that branch | `rebase-own-branch`, `lease-push-own-branch` |
| `stale-merge-ref` | Push an empty commit to the task branch | `retrigger-ci` |
| `stale-heartbeat`, `spawn-rejected`, `quota-exhausted`, `transient`, within the retry limit | `cli-dispatch requeue --task-id <id>` | `requeue` |
| Anything else | Escalate: the planner is messaged with the task id and the failure. No git action is taken. | none |

The playbook can push to one place: `HEAD:refs/heads/<the task's own branch>`.
`main`, `master`, any other branch, any forced or deleting push and any other
refspec form are refused before git is run. A lease push is also refused, with no
git action, unless the trusted policy sets `allowForcePush: leaseOnOwnBranch`, when
the branch is on the policy's `protectedBranches` list (or the built-in protected
names), and when the task's worktree does not verify as a genuine worktree of this
repository (under `.worktrees/`, registered under the main checkout's
`.git/worktrees/`, with a consistent `gitdir` back-pointer). Git runs with
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and every `GIT_CONFIG*` variable removed,
credential prompts off, and a two minute timeout per command, except `git push`, which
gets thirty minutes because the repository's pre-push hooks run inside it. Git is
started in its own process group, and on a timeout the whole group is killed so no
hook worker is left running. A rebase that does not apply cleanly is aborted, never
resolved by hand.

Decision ids and cause codes read from a verdict are checked before they are passed
on: a decision id must be `DEC-` followed by four to nine digits and a cause must be lower-case words
joined by hyphens. Anything else is dropped and listed in the verdict's
`rejectedFields`; `cli-dispatch complete` refuses such values outright.

`cli-dispatch requeue --task-id <id> [--retry-limit <n>]` returns one failed task to
`queue/` with its retry count incremented. It restores the manifest saved when the
task failed. It refuses, changing nothing, when the task is not in `failed/`, has no
saved manifest, is already queued, inflight or blocked, or has used its retries
(default 2).

### Clearing an executor

```bash
cli-hierarchy clear <executor-name> [--settle-ms <n>]
```

`cli-hierarchy clear` is for the dispatch session only. It resolves the calling session
from the roster and refuses, sending nothing, for any other caller, including a human
at a plain shell. A person outside the hierarchy who needs to empty a pane uses tmux
directly (`tmux send-keys -t <pane> -l -- /clear`, then `Enter`), after checking with
`cli-hierarchy status` that the executor holds no inflight task.

Looks up the executor in the roster and sends `/clear` and Enter to its pane, waits
for the settle time (8000 ms by default), then sends `/ai-sdlc executor` and Enter.
It refuses, sending nothing, when the name is not a running executor, the name or
pane id is malformed, the window is not open, or the executor holds an inflight
task. Keys are sent only to the pane the roster names, and only after tmux confirms
the pane still belongs to that window. An `ExecutorContextCleared` event records
the clear.

The `hierarchy.clear` capability is reported `live` when the restart command was
sent and the executor printed its identity line again within the settle time, and
`degraded`, with the reason, when it did not or a keystroke could not be sent. A
degraded clear shows up in `doctor`; check the executor's window with
`cli-hierarchy status`.

### Events

`HierarchySessionStarted` (from `cli-hierarchy up`), `ExecutorContextCleared`,
`DecisionRouted` (`cli-hierarchy route-decision`) and `OperatorPlaybookAction` are
written to the orchestrator events stream.

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

## Pre-push gate resource use

AISDLC-681. Parallel sessions all run the pre-push coverage gate
(`scripts/check-coverage.sh`), and each gate run fans out vitest workers, so the
gate is bounded on three axes:

- **Reaping.** The build and the coverage run execute in their own process group
  (`scripts/run-in-process-group.mjs`). When the hook ends (normally, by timeout, or
  via SIGINT/SIGTERM/SIGHUP) that whole group is killed, so no vitest worker is left
  with parent pid 1. Separately, every package's vitest config imports the shared
  preset (`vitest.shared.mjs`): `pool: 'forks'`, and each worker exits when its parent
  disappears (it polls the parent pid every 2 s). This protects any test run, including
  subagent runs killed by a Bash-tool timeout, not only the gate. Neither is env-gated.
- **Timeout.** `AI_SDLC_COVERAGE_TIMEOUT_SEC` (default `900`) is a hard wall-clock limit
  per build and per coverage run. On expiry the group is killed and the gate FAILS with a
  message naming the timeout; a timeout is never a pass.
- **Worker ceiling.** Two variables, default `min(4, ncpu/2)` each:
  `AI_SDLC_COVERAGE_MAX_WORKERS` sets the `--maxWorkers` the gate passes to the
  coverage run; `AI_SDLC_VITEST_MAX_WORKERS` sets the default ceiling the shared
  preset applies to every vitest run (local and CI). When both apply to a gate run,
  the gate's explicit `--maxWorkers` wins.
- **Lock.** Only one gate runs per repository at a time. The lock is the directory
  `<main checkout>/.ai-sdlc/runtime/coverage-gate.lock` (the main checkout is resolved
  from `git rev-parse --git-common-dir`, so sibling worktrees share it). A waiting push
  prints the holder's pid, host, worktree, and start time. A same-host holder is
  trusted by pid liveness only (alive keeps the lock however old; dead releases it). An
  ownerless lock (hook killed mid-create) is reclaimed after 10 s; a foreign-host or
  unparsable owner after 2 x timeout + 60 s. Reclaiming runs under a short mutex and
  verifies the owner it judged stale. A symlinked lock path is refused. A push waits up
  to 2 x timeout + 60 s (`AI_SDLC_COVERAGE_LOCK_WAIT_SEC` overrides), then fails.
  `AI_SDLC_COVERAGE_TIMEOUT_SEC` is clamped to 86400.

`ai-sdlc doctor` (check `orphaned-vitest-workers`) warns about vitest processes with
parent pid 1 older than two minutes and prints the `kill` command.

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

| Status        | Description                                                       | Next action                                                |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `starting`    | tmux window created; `claude` not yet running                     | Wait 30-60s then check                                     |
| `in-progress` | Pipeline running; heartbeats flowing                              | Monitor with status command                                |
| `done`        | `/ai-sdlc execute` completed; PR opened                           | Review the PR                                              |
| `failed`      | Session crashed, was killed, or heartbeat became stale (reaped)   | Run cleanup, then re-dispatch                              |
| `cancelled`   | Session received and honored a cancel control signal (AISDLC-481) | Review diagnostic in `.ai-sdlc/dispatch/failed/` if needed |

---

## Heartbeat step names

The `currentStep` field shows which Step 0-13 the session last completed:

| Step name              | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `01-validated`         | Task argument parsed and validated                |
| `05-dev-running`       | Developer subagent invoked                        |
| `06-dev-done`          | Developer subagent returned                       |
| `07-reviewers-running` | Review fan-out started                            |
| `07c-leaves-emitted`   | Transcript leaves emitted                         |
| `10-signing`           | Pre-sign rebase complete                          |
| `11b-pr-opened`        | Draft PR opened on GitHub                         |
| `done`                 | Pipeline complete; PR flipped to ready-for-review |

---

## Relation to existing dispatch patterns

| Pattern                                                               | When to use                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `/ai-sdlc execute <task-id>`                                          | Single task, interactive session                        |
| `/ai-sdlc execute-parallel`                                           | Multiple tasks, operator monitoring tmux                |
| `/ai-sdlc orchestrator-tick` + `/ai-sdlc dispatch-worker` (Pattern Z) | Fully autonomous drain with Conductor/Worker separation |

`execute-parallel` is the simplest parallel path — operator stays in the loop,
each session is visible in tmux. Pattern Z is for autonomous overnight drains
where the operator is away.
