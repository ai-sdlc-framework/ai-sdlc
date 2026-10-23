---
id: RFC-0059
title: Ephemeral executors, spawn per task and terminate on verdict
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-10-23
updated: 2026-10-23
requires: [RFC-0051]
assumes: [RFC-0058]
requiresDocs: []
targetSpecVersion: v1alpha1
---

# RFC-0059: Ephemeral executors, spawn per task and terminate on verdict

**Status:** Signed Off, v0.1 (2026-10-23). Born Signed Off in one PR with its tasks
(OQ-3). Three design questions and one interim rule were decided by the operator on
2026-10-23 by rubric; see Open Questions. Tasks AISDLC-1073 to 1076.

**Lifecycle:** Signed Off
**Author:** Dominique Legault
**Created:** 2026-10-23
**Updated:** 2026-10-23
**Target Spec Version:** v1alpha1

## Summary

RFC-0051 and RFC-0058 keep three standing executor sessions (alpha, beta, gamma, up to
epsilon) alive between tasks. An idle executor still costs tokens: it holds its context
and polls `cli-hierarchy executor-start --wait`. This RFC removes the standing pool.
Each eligible claim gets its own interactive session, named after the task, that exists
only until the task has a verdict. No task, no session, no tokens.

## Motivation

Weekly token audit, 2026-10-16 to 2026-10-23:

- Cache-read tokens are 98 percent of the 7,980M tokens used in the week.
- On 2026-10-23 three idle executor sessions polled `cli-hierarchy executor-start
  --wait` 2,100 to 3,000 times each at 450k to 966k context and consumed 3,702M tokens,
  47 percent of the week, with no task.
- Idle executors with a live hooks module still poll about once a minute at 72k to
  105k context.
- The account reached 91 percent of its seven-day limit on Friday; the reset is Tuesday.

The operator's goal is continuous day-and-night usage that lasts to the weekly reset,
with no idle session ever. A session that is not running cannot re-read its cache.
Cache-read cost is `calls x context`; an ephemeral executor has zero calls while no
task exists and a small, fresh context while one does.

## Goals

- No executor session exists without an assigned task.
- Termination is deterministic and owned by dispatch, not by the model.
- Concurrency follows the weekly budget as well as a static ceiling.
- Billing stays on the subscription: the interactive `claude` session, never `claude -p`.

## Non-Goals

- Headless or API-billed executors (RFC-0051 non-goals, RFC-0041 section 4.1, RFC-0058).
- Changing in-task rotation: the 120k threshold and resume-from-manifest are unchanged.
- Changing the board, briefs, verdict files, review or attestation flow (RFC-0053 unaffected).

## Five-step pass (DEC-0090 order)

1. Question the requirement: "executors must be available instantly" is the only reason
   for a standing pool. A spawn costs seconds against tasks that run tens of minutes.
2. Delete: the standing pool, the idle poll, `executor-start --wait` under a spawned
   executor, fixed roster names, the clear-between-tasks step.
3. Simplify: one session equals one task equals one verdict; the roster entry is a
   function of the task id.
4. Accelerate: dispatch spawns in the same tick that finds an eligible claim.
5. Automate last: the sweep and the crash path reuse the existing stall and requeue code.

## Proposal

### Spawn

`cli-hierarchy spawn <task-id>`:

1. Computes the role name `ai-sdlc-executor-<task-id-lowercase>`
   (for example `ai-sdlc-executor-aisdlc-1067`).
2. Creates the tmux session (window manager only, RFC-0058 OQ-3).
3. Registers a dynamic roster entry: role `executor`, name, task id, spawn time.
4. Launches the interactive `claude` session with the executor command and
   `AI_SDLC_EXECUTOR_TASK=<task-id>` in its environment.

Under that variable `executor-start` claims exactly that task and exits with a named
refusal if the task is not claimable. It never polls and refuses `--wait`. The hooks
module executor branch reads the same variable instead of waiting for a wake.

### Terminate

In the tick that records a verdict in `done/` or `failed/`, dispatch runs
`cli-hierarchy down --role <name>` and removes the roster entry. The executor module's
`turn.complete` self-exit is a fallback only. A sweep downs any executor still alive
5 minutes after its verdict. A crashed executor (no heartbeat for 10 minutes) is downed
and its manifest requeued by the existing stall path.

### Pool and cap

There are no standing executors. The dispatch tick spawns one executor per eligible
claim, up to `cap = min(executors.max, budget allowance)`, where `executors.max` is the
config ceiling and the allowance comes from the budget pacer (AISDLC-1072, the weekly
utilization line). `status` lists dynamic executors with task id and age, and prints the
BUDGET and cap lines.

### Unchanged inside a task

`clear` and rotation at 120k context work as today: the executor resumes from its
manifest. The name stays fixed for the life of the task, so a rotation never changes
the roster entry.

### Up

`up` no longer starts executors. `--executors` defaults to 0; the option stays for one
release and prints a deprecation line.

## Design Details

- Roster entries are dynamic: written by `spawn`, removed by `down` on termination. A
  static entry (planner, dispatch) is untouched. A name that already exists makes `spawn`
  a no-op that reports the live session, so a repeated tick never double-spawns.
- Order within a tick: record verdicts, down finished executors, then spawn for
  eligible claims, so the cap frees before it is consumed.
- A claim conflict (another session already holds the task) makes `spawn` refuse before
  creating anything.

## Security and Trust

Roster names are derived from task ids, which are validated ids (`AISDLC-<n>`), and
are lowercased and matched against `^ai-sdlc-executor-[a-z0-9-]+$` before any shell or
tmux call. `spawn` adds no authority: the executor claims through the same claim path,
under the same hooks, sender checks and attestation requirements as a standing executor.
The environment variable selects which task to claim; it cannot widen what the claim
path allows.

## Velocity Impact (DEC-0048)

Positive for throughput per token and neutral for latency. A spawn adds a few seconds
and one fresh-context start per task, against tasks that run tens of minutes. Idle
cost drops from about 47 percent of a week to zero, so the same weekly budget funds
roughly twice the task hours and the pipeline can run through to the reset. Risk: a
spawn failure delays one task by a tick; the tick retries it. The cap never goes below
one while the budget pacer allows any work.

## Backward Compatibility

Amends the executor lifecycle in RFC-0051 and RFC-0058 (persistent executors, clear
between tasks). Standing names alpha to epsilon are no longer created by `up`; existing
sessions with those names are downed by the interim rule until phase 1 lands.
`--executors N` keeps working for one release with a deprecation line.

## Alternatives Considered

- Fixed names (alpha to epsilon) downed when idle and restarted on demand: rejected;
  it keeps a name-to-task mapping that must be cleared and adds a state to reason about.
- A warm pool of one: rejected; it is the idle cost this RFC removes, paid continuously.
- Letting the executor exit itself as the primary path: rejected as a primary path;
  it depends on the model's last turn. Kept as a fallback.

## Implementation Plan

| Phase | Task | Scope |
|---|---|---|
| 1 | AISDLC-1073 | `cli-hierarchy spawn`, dynamic roster, `AI_SDLC_EXECUTOR_TASK` in `executor-start` |
| 2 | AISDLC-1074 | Tick spawns per claim and downs on verdict, 5-minute sweep, stall path |
| 3 | AISDLC-1075 | `up --executors 0`, `status`, runbook, hooks module executor branch |
| 4 | AISDLC-1076 | Cap from `executors.max` and the budget pacer, BUDGET and cap lines |

## Open Questions

### OQ-1: Who terminates an executor?

**Resolution (2026-10-23, operator rubric):** Dispatch terminates the executor in the
tick that records its verdict (`cli-hierarchy down --role <name>`). The executor
module's `turn.complete` self-exit is a fallback only. A sweep removes any executor
alive 5 minutes after its verdict.

### OQ-2: Pool model

**Resolution (2026-10-23, operator rubric):** No standing executors. Each eligible
claim spawns a session named `ai-sdlc-executor-<task-id-lowercase>` (for example
`ai-sdlc-executor-aisdlc-1067`). The concurrency cap is `min(executors.max, what the
budget pacer allows)`. Roster entries are dynamic and removed on termination. Rejected:
fixed names downed when idle; a warm pool of one.

### OQ-3: Where is this recorded?

**Resolution (2026-10-23, operator rubric):** This RFC, born Signed Off in one PR with
its tasks (allowed for a new RFC).

### OQ-4: What happens until phase 1 lands?

**Resolution (2026-10-23, operator rubric):** Dispatch downs every executor right after
its verdict and restarts one only when a claimable task exists. Already in force
2026-10-23.

## References

- RFC-0051 (session hierarchy; Non-Goals), RFC-0058 (hooks module, executor lifecycle),
  RFC-0041 section 4.1 (billing), RFC-0053 (unaffected).
- Code: `pipeline-cli/src/hierarchy/up.ts`, `down.ts`, `restart.ts`, `roster.ts`,
  `dispatch-loop.ts`, `executor-start.ts`; `docs/operations/cli-hierarchy.md`.
- Weekly token audit 2026-10-16 to 2026-10-23; AISDLC-1072 (budget pacer).

## Sign-Off

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | ✅ Signed | 2026-10-23 |
| Operator | Dominique Legault | ✅ Signed | 2026-10-23 |
| Product | | pending | |
| Design | | pending | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-23 | Born Signed Off; four decisions recorded as resolved Open Questions; tasks AISDLC-1073 to 1076. |
