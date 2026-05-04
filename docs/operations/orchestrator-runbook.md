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
