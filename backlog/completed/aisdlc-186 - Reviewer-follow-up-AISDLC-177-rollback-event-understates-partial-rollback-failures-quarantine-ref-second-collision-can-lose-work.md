---
id: AISDLC-186
title: >-
  Reviewer follow-up: AISDLC-177 rollback event understates partial-rollback
  failures + quarantine ref second-collision can lose work
status: Done
assignee: []
created_date: '2026-05-04 18:36'
labels:
  - bug
  - orchestrator
  - reliability
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/rollback.ts
  - spec/schemas/orchestrator-events.v1.schema.json
  - docs/operations/orchestrator-runbook.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source
Code reviewer on PR #274 (AISDLC-177, full-pipeline review 2026-05-04) flagged two distinct issues.

## Issue 1: OrchestratorRollback event understates partial-rollback failures
`loop.ts:940` reports `toStatus: result.fromStatus` unconditionally, even when `RollbackResult.statusReverted === false` (e.g., task file disappeared mid-rollback). Operator reading events.jsonl sees the event claim status was restored to the pre-dispatch value when in fact the file write never happened (the warning only surfaces via logger.warn, NOT in the event payload).

Contradicts the runbook claim that the event payload is a sufficient forensic record.

**Fix:** add `statusReverted: result.statusReverted` to the OrchestratorRollback event payload (and update the schema to match). OR set `toStatus` to a sentinel like `'(unchanged)'` when revert failed.

## Issue 2: Quarantine ref naming collision can lose work
`rollback.ts:158`: Quarantine refs use second-precision UTC timestamps (`quarantine/<id>-<YYYY-MM-DDTHH-MM-SS>`). If two rollbacks fire for the same task in the same UTC second, the second `git branch -m` fails (rename-fails-if-exists semantics), surfacing as a logged warning. The original ref retains its name and the SECOND attempt's commits are eligible for `branch -D` cleanup — losing the second attempt's work.

Production probability is low but the failure mode is silent + data-losing.

**Fix:** retry rename with numeric suffix (`-2`, `-3`, ...) on collision, OR append a few hex chars from the tip SHA so collisions are deterministically avoided.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 OrchestratorRollback event payload includes `statusReverted: boolean` field
- [ ] #2 spec/schemas/orchestrator-events.v1.schema.json updated to require statusReverted on OrchestratorRollback events
- [ ] #3 Quarantine ref naming collision-resistant: numeric suffix retry OR SHA-suffix variant
- [ ] #4 Test: two same-second rollbacks for same task produce TWO distinct quarantine refs (no work lost)
- [ ] #5 Test: rollback with task file disappeared emits OrchestratorRollback with statusReverted: false
<!-- AC:END -->
