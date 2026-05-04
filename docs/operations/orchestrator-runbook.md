# Orchestrator operator runbook

**Audience**: AI-SDLC operators running `cli-orchestrator tick` /
`cli-orchestrator start` against a real backlog, plus anyone diagnosing
events.jsonl after a failed run.

This runbook is the day-to-day companion to the promotion runbook at
[`orchestrator-promotion.md`](./orchestrator-promotion.md) and the spec
at [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

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
  Refs are named `quarantine/<task-id-lower>-<YYYY-MM-DDTHH-MM-SS>`
  (UTC, sub-second precision dropped). The timestamp suffix is the
  rollback wall-clock, not the commit's authored time.

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

Common partial-rollback warnings:

| Warning | Cause | Fix |
|---|---|---|
| `task file not found for <id>` | Backlog task file moved/deleted between Step 4 and rollback. | Manual `mcp__backlog__task_edit` to set status. |
| `worktree remove failed: <stderr>` | Worktree directory locked (e.g. an editor has files open) or already unregistered from `git worktree list`. | `git worktree prune` then `rm -rf .worktrees/<id-lower>` manually. |
| `quarantine rename failed: <stderr>` | Target ref already exists (impossibly-rapid duplicate rollback) or the branch was deleted by an external process between probe + rename. | Inspect `git reflog show ai-sdlc/<id-lower>` to recover the SHA, then `git branch quarantine/<id>-<ts> <sha>`. |
