# Orchestrator operator runbook

**Audience**: AI-SDLC operators running `cli-orchestrator tick` /
`cli-orchestrator start` against a real backlog, plus anyone diagnosing
events.jsonl after a failed run.

This runbook is the day-to-day companion to the promotion runbook at
[`orchestrator-promotion.md`](./orchestrator-promotion.md) and the spec
at [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

---

## Inline orchestrator mode (`--spawner claude-cli`) (AISDLC-198)

The inline orchestrator is the recommended way to run the autonomous
orchestrator on **subscription billing** (Claude Code Max). It avoids
per-token API costs by running the orchestrator's tick loop INSIDE the
operator's Claude Code session instead of as a separate process.

### Why inline mode

The autonomous orchestrator (`cli-orchestrator`) needs to dispatch subagents
(developer, reviewers). Subagent dispatch via the `Agent` tool is only
available inside an active Claude Code session. Inline mode solves this
by making the slash command body the orchestrator process — see
[`docs/operations/claude-cli-spawner.md`](./claude-cli-spawner.md) for the
full option evaluation.

### Prerequisites

1. Claude Code Max subscription (any tier).
2. `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` set in your shell
   (enables the `cli-orchestrator` feature gate — required by RFC-0015 §3.1).
3. Backlog with at least one task in `To Do` status.
4. Working directory is the project root (where `backlog/`, `.worktrees/`,
   and `artifacts/` live).

### Starting the inline orchestrator

In your Claude Code session, run the `/ai-sdlc execute` slash command in loop
mode:

```
/loop /ai-sdlc execute <task-id>
```

For autonomous multi-task orchestration (the full loop), the slash command body
reads the dispatch manifest written by `ClaudeCliInlineSpawner` and invokes the
Agent tool for each admitted task. The manifest is at:

```
artifacts/_orchestrator/dispatch-manifest.json
```

Between ticks the slash command uses `ScheduleWakeup` to yield without blocking.

### Monitoring inline orchestrator progress

Progress lines emitted by the orchestrator are in the format:

```
[ai-sdlc-progress] <stage>: <message>
```

The dispatch manifest written before each Agent call is at:

```bash
cat artifacts/_orchestrator/dispatch-manifest.json
```

Events are also written to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl`:

```bash
tail -f artifacts/_orchestrator/events-$(date +%Y-%m-%d).jsonl | jq .
```

### How the dispatch manifest works

When the orchestrator runs with `--spawner claude-cli`, each dispatch slot
calls `ClaudeCliInlineSpawner.spawn()`, which writes a JSON manifest and
returns `status: 'manifest-emitted'`. The manifest shape:

```json
{
  "version": 1,
  "taskId": "AISDLC-123",
  "subagentType": "developer",
  "model": "claude-sonnet-4-6",
  "prompt": "...",
  "cwd": "/path/to/worktree",
  "runInBackground": false,
  "emittedAt": "2026-05-05T00:00:00.000Z"
}
```

The calling slash command body reads the manifest and invokes the `Agent` tool
with the described parameters. This keeps all Agent-tool invocations inside the
Claude Code session (subscription billing) while letting the TypeScript
orchestrator handle scheduling, admission filters, and event emission.

### Stopping the inline orchestrator

The orchestrator tick loop stops when:
- `maxTicks` is reached (set via `--max-ticks N`).
- The operator sends `Ctrl+C` (SIGINT) — the loop drains in-flight dispatches
  and exits cleanly.
- The slash command session ends (ScheduleWakeup will not fire again).

### Transitioning from manual dispatch to inline orchestrator

If you have been manually running `/ai-sdlc execute <task-id>` for each task:

1. Verify the inline orchestrator prerequisites above are met.
2. Start the loop (replace manual per-task invocations).
3. The orchestrator reads the backlog frontier and picks the next `To Do`
   task automatically — no manual task-id selection needed.

### Troubleshooting inline mode

**`manifest-emitted` status in pipeline logs**: This is expected in inline mode.
It means the spawner wrote the manifest; the slash command body must invoke
the Agent tool. If you see this in a non-inline context, the wrong spawner kind
was selected.

**Manifest file not found**: The manifest path defaults to
`$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json`. If `ARTIFACTS_DIR` is
unset it falls back to `<workDir>/artifacts/_orchestrator/`. Check that the
`artifacts/` directory is writable.

**Orchestrator not starting**: Verify `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`
is set. The loop refuses to start when the flag is unset.

---

## Blocking a task from orchestrator dispatch (AISDLC-223)

The orchestrator's `Blocked` admission filter lets operators put a task on
hold without changing its status, removing it from the backlog, or modifying
the dependency graph. A blocked task is skipped on every tick until the
operator removes the `blocked.reason` field.

### When to use

- A task is "ready by all criteria" but you need to wait for an external
  signal before dispatching it — e.g. a soak window, a human decision, a
  dependency outside the task graph.
- AISDLC-115 is the canonical first user: RFC-0011 DoR Gate, soaking for
  promotion evidence. Mark it blocked until the soak window closes so the
  orchestrator stops re-picking it every tick.

### Frontmatter shape

Add a `blocked:` field to the task's YAML frontmatter:

```yaml
---
id: AISDLC-115
status: In Progress
blocked:
  reason: "Soaking — feature flag promotion gated on AISDLC-116 evidence"  # required
  until: "2026-05-13"           # optional advisory ISO date
  unblockedBy: ["AISDLC-116"]   # optional task IDs whose completion unblocks this
---
```

- `reason` (string, required) — any non-empty string activates the block.
  The orchestrator will emit this string verbatim in `TaskBlocked` events.
- `until` (string, optional) — an advisory ISO date. The orchestrator does
  NOT auto-unblock on this date (Phase 2 / AC #8); it is informational only
  and surfaces in `TaskBlocked` events + `cli-orchestrator status` output.
- `unblockedBy` (array, optional) — advisory task IDs to monitor. Same
  advisory semantics as `until` — no auto-unblock in v1.

### Editing the blocked field

Use `mcp__backlog__task_edit` or hand-edit the task file:

```bash
# Set the blocked field
mcp__backlog__task_edit AISDLC-115 blocked.reason "Soaking — gated on AISDLC-116"

# Or hand-edit the YAML frontmatter in backlog/tasks/aisdlc-115 - *.md
```

### Unblocking a task

Remove the `blocked` field (or set `blocked.reason` to an empty string):

```bash
# Remove the field entirely via task_edit
mcp__backlog__task_edit AISDLC-115 blocked null

# Or hand-edit: delete the blocked: block from the YAML frontmatter
```

The next orchestrator tick will admit the task normally (all other filters
still apply).

### Observability: TaskBlocked events

Every tick that the `Blocked` filter rejects a task emits a `TaskBlocked`
event to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl`:

```json
{
  "type": "TaskBlocked",
  "ts": "2026-05-06T12:34:56Z",
  "taskId": "AISDLC-115",
  "reason": "Soaking — feature flag promotion gated on AISDLC-116 evidence",
  "until": "2026-05-13"
}
```

Grep for blocked tasks across all event files:

```bash
grep '"TaskBlocked"' artifacts/_orchestrator/events-*.jsonl | jq .
```

### Observability: cli-orchestrator status

`cli-orchestrator status` includes a `blocked` array in its JSON output:

```json
{
  "ok": true,
  "mode": "status",
  "status": {
    "blocked": [
      {
        "taskId": "AISDLC-115",
        "reason": "Soaking — feature flag promotion gated on AISDLC-116 evidence",
        "until": "2026-05-13"
      }
    ]
  }
}
```

An empty `"blocked": []` means no frontier tasks are currently blocked.

---

## Recovering quarantined work after a failed dispatch (AISDLC-177)

When the orchestrator dispatches a task and the dispatcher (Step 6
parse, the dev subagent itself, or any later step) reports a
non-recoverable failure — `developer-failed`,
`developer-json-contract-violated`, `aborted`, or an uncatalogued
exception — the orchestrator now **rolls back** Step 4's side-effects
automatically:

1. Reverts the task file's `status:` line back to whatever it was
   BEFORE the orchestrator picked the task (typically `To Do`).
2. Removes the worktree at `.worktrees/<task-id-lower>/` via
   `git worktree remove --force`. The per-worktree `.active-task`
   sentinel goes with it.
3. **Preserves any commits the dev produced** by renaming the dev's
   branch under `quarantine/<task-id-lower>-<iso-timestamp>` instead
   of deleting it. This is the recovery path operators care about.
4. Emits an `OrchestratorRollback` event on the events.jsonl bus +
   (when commits were preserved) an `OrchestratorWorkQuarantined`
   companion event with the SHA + commit count.

### Step 1: identify a quarantined ref

Either:

- **From events.jsonl** — grep for the quarantine event:
  ```bash
  grep '"OrchestratorWorkQuarantined"' artifacts/_orchestrator/events-*.jsonl
  ```
  Each line carries `taskId`, `branch` (the original
  `ai-sdlc/<id-lower>` ref name), `quarantineRef`, `commitSha`, and
  `commitCount`.

- **From git** — list every quarantine ref directly:
  ```bash
  git branch --list 'quarantine/*'
  ```
  Refs are named `quarantine/<task-id-lower>-<YYYY-MM-DDTHH-MM-SS-mmm>`
  (UTC, millisecond precision per AISDLC-186). The timestamp suffix is
  the rollback wall-clock, not the commit's authored time. Pre-186 refs
  used second precision (`...T14-23-44`) and may still be present in
  long-lived repos — both formats sort lexicographically by date so
  `git branch --list` returns them interleaved as expected.

### Step 2: inspect the preserved work

```bash
git log quarantine/aisdlc-70-2026-05-04T14-23-44 --not origin/main --oneline
```

If the commits look salvageable, check out a fresh feature branch from
the quarantine ref:

```bash
git checkout -b ai-sdlc/aisdlc-70-recovered quarantine/aisdlc-70-2026-05-04T14-23-44
```

Carry the change forward yourself:

- Cherry-pick into a fresh worktree if the dev's work was almost
  complete but hit a non-deterministic failure.
- Open a PR manually if the commits already pass review locally.
- Discard the ref if the work was wrong-headed (the orchestrator did
  the right thing flagging it):
  ```bash
  git branch -D quarantine/aisdlc-70-2026-05-04T14-23-44
  ```

### Step 3: re-dispatch the task (optional)

The original task's status was reverted to `To Do` by the rollback,
so the next orchestrator tick will pick it up again automatically.
If you want to skip re-dispatch (because you're carrying the work
forward yourself), set the status to `In Progress` manually so the
admission filters skip it:

```bash
# via the plugin MCP tool inside Claude Code
mcp__plugin_ai-sdlc_ai-sdlc__task_edit AISDLC-70 --status "In Progress"
```

### What the rollback does NOT touch

- **`approved` outcomes** — the dev's PR is already opened, no
  rollback fires. The worktree is swept by the normal Step 13 cleanup.
- **`needs-human-attention` outcomes** — the orchestrator deliberately
  leaves the worktree intact so the operator can iterate from where
  the dev stopped. The PR carries a `needs-human-attention` label
  (RFC-0015 §13 Q1).
- **`task-already-in-flight` rejections** — no dispatch happened,
  nothing to roll back. The pre-dispatch filter catches these
  silently with an `OrchestratorTaskAlreadyInFlight` event.
- **Filter-chain rejections** (`OrchestratorBlockedByDependency`,
  `OrchestratorBlockedByDor`, `OrchestratorAwaitingExternal`,
  `OrchestratorOrphanParent`) — the orchestrator never invoked
  Step 4, so there's nothing to roll back.

### Failure modes inside rollback itself

The rollback helper is best-effort: every step (status revert, branch
quarantine probe, worktree removal) runs in its own try/catch, and
warnings accumulate in the `OrchestratorRollback` event's payload
(via the orchestrator's `warn()` log). A partial rollback will still
emit the event so operators see the partial state — the warnings are
the diagnostic, not the absence of the event.

The event payload itself carries booleans for each side-effect so
operators can detect a partial rollback without grep'ing logs:

- **`statusReverted`** (AISDLC-186) — `true` when the task file's
  `status:` line was successfully patched back to `fromStatus`. When
  `false`, the task file write failed (file disappeared mid-run,
  frontmatter became unparseable, disk error). Note that `toStatus`
  reports the INTENDED post-rollback status and mirrors `fromStatus`
  even on failure — the on-disk reality is in `statusReverted`. When
  `false`, manually reset the task status (`mcp__backlog__task_edit
  <id> --status <fromStatus>`).
- **`worktreeRemoved`** — `true` when `git worktree remove --force`
  succeeded (or the path was already absent). `false` indicates the
  worktree directory is still on disk + still registered with git.
- **`branchQuarantined`** — `true` when the dev's branch carried
  commits beyond `origin/main` AND the rename to
  `quarantine/<ref>` succeeded. `false` is the common case (no
  commits to preserve) but can also indicate a rename failure —
  cross-reference the warnings to disambiguate.

Common partial-rollback warnings:

| Warning | Cause | Fix |
|---|---|---|
| `task file not found for <id>` | Backlog task file moved/deleted between Step 4 and rollback. | Manual `mcp__backlog__task_edit` to set status. |
| `worktree remove failed: <stderr>` | Worktree directory locked (e.g. an editor has files open) or already unregistered from `git worktree list`. | `git worktree prune` then `rm -rf .worktrees/<id-lower>` manually. |
| `quarantine rename failed: <stderr>` | Target ref already exists (would require two rollbacks for the same task within the same UTC millisecond per AISDLC-186 — practically impossible) or the branch was deleted by an external process between probe + rename. | Inspect `git reflog show ai-sdlc/<id-lower>` to recover the SHA, then `git branch quarantine/<id>-<ts> <sha>`. |

---

## Counting developer-contract retries by code path (AISDLC-196)

When the developer subagent returns non-JSON prose, the Step 6 retry
helper re-prompts for the JSON envelope and — if the dev recovers — the
orchestrator emits a `DeveloperContractRetry` event onto the
`events.jsonl` bus. Two code paths fire this event:

- **Initial-dispatch path** (`phase: 'initial'`) — Step 5b/6 of
  `executePipeline()`, on the very first dev call for the task.
  Frequent emission here points at developer.md system-prompt drift
  (the agent forgot the JSON contract often enough that the retry is
  doing more work than it should).
- **Iteration-loop path** (`phase: 'iteration'`, plus an `iteration`
  field carrying the actual loop counter, always >=2) — Step 9 of the
  iteration loop, when the dev returns prose on a re-dispatch after a
  CHANGES_REQUESTED round. Frequent emission here points at
  post-feedback re-dispatch fragility (long feedback prompts pushing
  the agent off the contract), not initial-prompt drift.

Operator queries against the date-rotated events files:

```bash
# All DeveloperContractRetry events across every rotated file:
jq -c 'select(.type == "DeveloperContractRetry")' \
  artifacts/_orchestrator/events-*.jsonl

# Iteration-path retries only — surfaces post-feedback re-dispatch drift:
jq -c 'select(.type == "DeveloperContractRetry" and .phase == "iteration")' \
  artifacts/_orchestrator/events-*.jsonl

# Initial-dispatch retries only — surfaces developer.md prompt drift:
jq -c 'select(.type == "DeveloperContractRetry" and .phase == "initial")' \
  artifacts/_orchestrator/events-*.jsonl

# Per-iteration histogram (iteration 2, 3, ... = which feedback round
# tripped the contract most often):
jq -r 'select(.type == "DeveloperContractRetry" and .phase == "iteration") | .iteration' \
  artifacts/_orchestrator/events-*.jsonl | sort | uniq -c
```

The `phase` + `iteration` discriminators are additive (AISDLC-196):
events emitted before the discriminator landed simply omit the fields,
so the queries above implicitly bucket pre-discriminator events into
neither group. Any persistent imbalance between the two paths is the
signal — pick the one with the higher count and address its drift
source first.
