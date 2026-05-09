---
id: AISDLC-243
title: >-
  DoR gate should detect non-dispatchable tasks (soak / investigation /
  operator-only) — not just blocked.reason workaround
status: Done
assignee: []
created_date: '2026-05-08 00:50'
labels:
  - enhancement
  - rfc-0011
  - dor
  - orchestrator
  - rfc-0015
  - dogfood
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Today the orchestrator's frontier admits any task with status `To Do` + dependencies satisfied + DoR gates passing. But many tasks in the backlog are NOT actually dispatchable as code work — they're operational, observational, or investigation tasks that an LLM dev cannot complete:

- **Soak phases** — `AISDLC-178.7` is the operator-monitored soak post-178.6 ship. The "implementation" is "watch the TUI for a week, gather telemetry, decide promotion". An LLM dispatched against this writes meaningless code that fails the coverage gate.
- **Investigation/spike tasks** — `AISDLC-233` (worktree leakage diagnosis) requires running tools in a real environment + interpreting results. An LLM dispatched against it would write unrelated code.
- **Operator-only chores** — manual setup, signing key rotation, secrets management, etc. An LLM cannot perform these.

The current workaround is to manually tag tasks with `blocked.reason` so AISDLC-223's `BlockedFilter` excludes them. But:
- Operator must know to tag every non-code task
- The frontmatter field is overloaded (`blocked` was meant for tasks awaiting external signal, not for "permanently not LLM-dispatchable")
- New tasks default to dispatchable, so first dispatch attempt wastes resources

Witnessed empirically 2026-05-07: AISDLC-178.7 was picked by orchestrator twice today, dev ran ~20min each time, aborted on coverage gate. Wasted ~40min of subscription time before operator manually marked it blocked.

Operator (2026-05-08): "shouldn't there be a way to detect that the issues isn't buildable before we dispatch it to an agent shouldn't this be handled at the DoR gate instead of having to tag an issue as blocked with a reason."

## Proposed design

### Add `dispatchable: boolean` to task frontmatter

```yaml
---
id: AISDLC-178.7
title: 'Phase 7: Soak ...'
status: To Do
dispatchable: false
dispatchableReason: >-
  Operator soak phase — implementation is operator monitoring, not LLM
  code work. Promote manually after telemetry shows stability.
---
```

Default is `dispatchable: true` (back-compat). Tasks like 178.7 set it to `false`.

### Add a new `DispatchabilityFilter` to the orchestrator's filter chain

Place it AFTER `OrphanParentFilter` + `DependencyReadinessFilter`, BEFORE `DorReadinessFilter`. If `dispatchable === false`, filter excludes the task with reason `dispatchableReason`.

### Extend the DoR gate / refinement reviewer

When new tasks are filed, the refinement reviewer (RFC-0011 §7.4) inspects the task and may suggest `dispatchable: false` based on signals:
- Title contains "Soak", "Operator", "Manual", "Investigation"
- Description mentions "operator monitors", "operator decides", "manual"
- Task type heuristics: pure-doc tasks, RFC tasks, deployment tasks

LLM-judged with a confidence threshold; below threshold → leave dispatchable=true (default-on); above threshold → recommend dispatchable=false in a comment, operator confirms.

### Optional: `taskType` enum field

A more structured alternative to a boolean:
```yaml
taskType: code | soak | investigation | docs | manual | rfc | meta
```

The orchestrator dispatches only `code` and `docs`. Other types are surfaced in the TUI but not auto-dispatched.

Recommendation: ship `dispatchable: boolean` first (simple boolean opt-out). Migrate to `taskType` enum in a follow-up if the boolean proves insufficient.

## Acceptance Criteria

- [ ] #1 New `dispatchable: boolean` (default `true`) field on task frontmatter, documented in CLAUDE.md backlog workflow section
- [ ] #2 New `DispatchabilityFilter` in `pipeline-cli/src/orchestrator/filters/dispatchability.ts` registered in the filter chain after `DependencyReadinessFilter`, before `DorReadinessFilter`
- [ ] #3 Filter excludes tasks with `dispatchable: false`; trace output includes `dispatchableReason` field
- [ ] #4 Refinement reviewer (RFC-0011 §7.4) heuristic added: if title/body matches soak/investigation/operator patterns, suggest `dispatchable: false` in the task's review comment (LLM-judged, confidence-gated)
- [ ] #5 Migration: scan existing backlog/tasks for tasks that should be `dispatchable: false` (start with 178.7, 115.x soak phases, 233 investigation, AISDLC umbrella parents). One-shot migration PR labels them.
- [ ] #6 `cli-deps frontier` output annotates non-dispatchable tasks (or hides them with a `--include-non-dispatchable` flag) so operators see only dispatchable candidates by default
- [ ] #7 Integration test: backlog with 1 dispatchable + 1 non-dispatchable task; tick admits only the dispatchable one; trace shows the other was filtered with reason

## Composes with

- **AISDLC-115** (RFC-0011 DoR gate) — extends with the dispatchability check
- **AISDLC-223** (BlockedFilter) — sister filter for the temporary-blocked case (this is the permanent-not-dispatchable case)
- **AISDLC-178.7** (the witness task — first migration candidate)

## References

- `spec/rfcs/RFC-0011-definition-of-ready-gate.md` (RFC for the DoR gate)
- `pipeline-cli/src/orchestrator/filters/blocked.ts` (sister filter as code reference)
- `backlog/tasks/aisdlc-178.7 - ...md` (witness task, recently tagged blocked)
- AISDLC-223 (BlockedFilter — the workaround we're replacing for the permanent case)
- Operator request 2026-05-08: "shouldn't there be a way to detect that the issues isn't buildable before we dispatch it to an agent shouldn't this be handled at the DoR gate instead of having to tag an issue as blocked with a reason"
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 dispatchable: boolean field on task frontmatter (default true)
- [ ] #2 DispatchabilityFilter registered in filter chain
- [ ] #3 Filter trace surfaces dispatchableReason
- [ ] #4 Refinement reviewer suggests dispatchable: false on soak/investigation/operator patterns
- [ ] #5 Migration PR labels existing non-dispatchable tasks (178.7, soak phases, investigations)
- [ ] #6 cli-deps frontier annotates or hides non-dispatchable tasks
- [ ] #7 Integration test: dispatchable + non-dispatchable mix; only dispatchable admitted
<!-- SECTION:ACCEPTANCE:END -->
