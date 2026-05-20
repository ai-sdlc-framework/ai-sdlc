---
id: AISDLC-377.6
title: 'chore(deprecation): RFC-0041 Phase 3.3 — remove --spawner claude-cli entirely (post-deprecation window)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-3
  - breaking-change
  - removal
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.4
priority: low
blocked:
  reason: 'Awaits one full release window after AISDLC-377.4 (deprecation warning) ships so operators have time to migrate; operator will unblock when the window has elapsed.'
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - pipeline-cli/src/runtime/spawners/claude-cli-inline.ts
---

## Scope (RFC-0041 §7 Phase 3.3)

Removes the legacy `--spawner claude-cli` path entirely. This is a **breaking change** for any operator who has not migrated to the dispatch-board model.

**Hard prerequisite**: AISDLC-377.4 has been on a released main for at least one full release window (one release = ~1–2 weeks typical cadence). Operator unblocks this task when the window has elapsed AND they have verified no internal callers remain.

### Deliverables

1. **Remove the spawner kind handling** from the cli-orchestrator source under pipeline-cli/src/cli/:
   - Delete the spawner kind from the CLI's argument parser
   - Delete the claude-cli inline spawner module under pipeline-cli/src/runtime/spawners/ (path: claude-cli-inline.ts in current repo layout)
   - Delete its co-located test file

2. **Update CLAUDE.md** to remove the deprecated row entirely from the spawner kinds table

3. **Update the pipeline-cli spawner docs** (under pipeline-cli/docs/) to remove the Deprecated section

4. **Operator migration breadcrumb**: ship a brief migration doc under docs/operations/ for one more release in case anyone still has the deprecated form in a script

## Acceptance criteria

- [ ] #1 claude-cli spawner code + tests removed from pipeline-cli
- [ ] #2 cli-orchestrator tick --spawner claude-cli now errors with an Unknown-spawner-kind message pointing at the new migration doc
- [ ] #3 CLAUDE.md + pipeline-cli docs no longer reference claude-cli (except in the migration breadcrumb)
- [ ] #4 The new docs/operations/ migration breadcrumb exists with the recommended replacement paths
- [ ] #5 No Agent(... run_in_background: true) calls remain in the dispatch hot path (grep test in CI)
- [ ] #6 New code reaches 80%+ patch coverage (mostly removal — coverage drops are expected and gate-allowed)

## Out of scope

- Removing `/ai-sdlc execute` (single-task interactive path stays; orthogonal to dispatch-board)
- Migrating downstream adopters' scripts (we publish the breadcrumb; adopters do their own migration)

## Source

RFC-0041 §7 Phase 3.3 deliverable; gated by operator-declared deprecation window per AISDLC-377.4.
