---
id: AISDLC-223
title: >-
  Add `blocked` frontmatter field + BlockedFilter admission gate (skip tasks
  awaiting external signal)
status: In Progress
assignee: []
created_date: '2026-05-06 19:49'
labels:
  - enhancement
  - orchestrator
  - framework-bug
  - rfc-0015
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The orchestrator (`cli-orchestrator tick`) picks the highest-priority task from the dispatchable frontier. But a task can be "ready by every existing admission gate" yet not actually dispatchable — e.g., implementation shipped + flag in soak window collecting evidence before promotion (AISDLC-115's current state on 2026-05-06) — and the orchestrator wastes a tick attempting to dispatch it.

Today the operator has no clean way to signal "this task is alive but on hold." Backlog.md's status enum is fixed (`Draft | Needs Clarification | To Do | In Progress | Done`); none of these mean "blocked." Marking it `In Progress` overloads the active-dispatch state. Marking `Done` is a lie. Removing the task from the frontier requires architectural changes to the dependency graph.

Witnessed empirically 2026-05-06: end-to-end orchestrator test (cli-orchestrator tick) picked AISDLC-115 (RFC-0011 DoR Gate, soaking for promotion evidence), ran admission filters (OrphanParent → DependencyReadiness → DorReadiness → ExternalDeps all passed), entered Step 0/1/2/3, and aborted at Step 3 because the prior session's branch already existed. Even with stale-branch handling fixed, the orchestrator would re-pick AISDLC-115 every tick until soak completes — burning ~5 minutes per tick on a no-op.

## Proposed design

### Frontmatter field

```yaml
---
id: AISDLC-115
status: In Progress
blocked:
  reason: "Soaking — feature flag promotion gated on AISDLC-116 evidence"
  until: "2026-05-13"           # optional ISO date; advisory only
  unblockedBy: ["AISDLC-116"]   # optional list of task IDs to monitor
---
```

All sub-keys optional except `reason` (string, free-form).

### Admission filter

New `BlockedFilter` added to the chain:

```
OrphanParent → DependencyReadiness → DorReadiness → ExternalDeps → Blocked
```

Filter logic: if frontmatter has non-empty `blocked.reason`, refuse with `{ filter: 'Blocked', passed: false, reason: '<the reason string>' }`.

### Orchestrator events

`TaskBlocked` event emitted to `_events.jsonl` per RFC-0015 §observability:

```json
{
  "type": "TaskBlocked",
  "ts": "2026-05-06T12:34:56Z",
  "taskId": "AISDLC-115",
  "reason": "Soaking — feature flag promotion gated on AISDLC-116 evidence",
  "until": "2026-05-13"
}
```

The TUI (when AISDLC-178.x lands) surfaces blocked tasks in a dedicated pane so operator can see "what's waiting on me to unblock."

### Operator workflow

1. Mark task with `blocked.reason: "..."` (via `mcp__backlog__task_edit` or hand-edit)
2. Orchestrator skips on every tick; emits `TaskBlocked` events for observability
3. When the unblocking condition clears, operator removes the `blocked` field
4. Next tick picks it up normally

### Auto-unblock (optional Phase 2)

If `blocked.until` is in the past, emit a `TaskUnblockExpired` warning event (don't auto-unblock — operator decides). If `blocked.unblockedBy` is non-empty and ALL listed task IDs are Done, same warning. This is advisory plumbing for the TUI.

## Acceptance Criteria

- [ ] #1 Frontmatter `blocked` field accepted by `mcp__backlog__task_edit` + parsed by the orchestrator's task loader
- [ ] #2 `backlog-drift` validation accepts the field (any string value for `reason`; `until` parsed as ISO date if present; `unblockedBy` validated as task ID array if present)
- [ ] #3 New `BlockedFilter` added to the orchestrator's admission chain at `pipeline-cli/src/orchestrator/filters/blocked.ts`, wired into the cascade after ExternalDeps
- [ ] #4 `TaskBlocked` event added to the `_events.jsonl` schema; emitted on every tick that filters a blocked task
- [ ] #5 `cli-orchestrator status` output includes a `blocked: [{taskId, reason, until?}]` section so operators can see the blocked queue without parsing events
- [ ] #6 Hermetic test in `pipeline-cli/src/orchestrator/filters/blocked.test.ts`: fixture task with `blocked.reason` set → filter returns `passed: false`; without it → returns `passed: true`
- [ ] #7 End-to-end test: tick fixture with one blocked + one ready task → only the ready task is dispatched; `events.jsonl` contains a `TaskBlocked` entry for the blocked one
- [ ] #8 Phase 2 (separate sub-task or follow-up): auto-emit `TaskUnblockExpired` warning when `blocked.until` is in the past or all `unblockedBy` IDs are Done
- [ ] #9 `docs/operations/operator-runbook.md` documents the field shape + workflow (set/unset)
- [ ] #10 First user: AISDLC-115 — once this lands, operator sets `blocked.reason: "soaking — feature flag promotion gated on AISDLC-116 evidence"` so the orchestrator stops re-picking it every tick

## Composes with / supersedes

- **Composes with RFC-0015** (autonomous orchestrator): without this gate, the orchestrator can't actually run unattended on a real backlog — it spends every tick on a "ready but not actually dispatchable" task and never makes progress
- **Composes with AISDLC-178** (TUI): blocked-tasks pane is an obvious feature for the operator dashboard
- **Composes with the stale-branch issue** (filed separately): both are orchestrator self-reliance gaps surfaced by the 2026-05-06 end-to-end test

## References

- `pipeline-cli/src/orchestrator/filters/` (existing admission filters — pattern to mirror)
- `pipeline-cli/src/orchestrator/loop.ts` (where the filter chain is wired)
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` (admission gate design)
- AISDLC-115 (the canonical blocked task driving this)
<!-- SECTION:DESCRIPTION:END -->
