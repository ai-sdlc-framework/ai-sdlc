---
id: AISDLC-70.6
title: 'Phase 3: Concurrency + merge gate'
status: To Do
assignee: []
created_date: '2026-04-26 19:46'
labels:
  - rfc-0010
  - phase-3
  - concurrency
  - git
milestone: m-2
dependencies:
  - AISDLC-70.2
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#9-concurrency-and-admission-control
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#10-merge-coordination
  - orchestrator/src/execute.ts
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Convert execute.ts from single-issue to a worker-pool bounded by parallelism.maxConcurrent. Implement the file-based merge gate with stale-base detection and rebase-on-conflict (RFC §10). Folds in Q3 resolution (PPA re-scoring on requeue + failure-type taxonomy). Estimated 1–2 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 execute.ts converted from single-issue to worker-pool model bounded by resolved parallelism.maxConcurrent (RFC §9.1 resolution table including tier-aware defaults)
- [ ] #2 Re-scoring on requeue per RFC §9.4: hybrid algorithm (time threshold > 24h OR failure-type-signal OR operator-triggered); failure-type taxonomy table from §9.4.1 implemented (Q3)
- [ ] #3 Triage history persisted to $ARTIFACTS_DIR/<issue-id>/triage-history.jsonl per RFC §9.4.2 (Q3)
- [ ] #4 RetriageStorm warning when single issue triggers >10 re-triage events in 24h (Q3)
- [ ] #5 File-based merge gate (<pool>/.merge-gate.lock) per RFC §10.1; stale-base detection + rebase-on-conflict per §10.2
- [ ] #6 MergeConflict/RebaseConflict events surface at merge gate; MigrationConflict for schema-touching stages
- [ ] #7 Integration test: 5 concurrent issues with deliberately-overlapping touched files; verify all PRs land mergeable through serialized gate
- [ ] #8 Verify gh pr merge is NEVER executed by orchestrator per project policy (feedback_never_merge_prs.md)
- [ ] #9 New code reaches 80%+ patch coverage
<!-- AC:END -->
