---
id: AISDLC-70.2
title: 'Phase 2: Worktree pool manager'
status: To Do
assignee: []
created_date: '2026-04-26 19:44'
labels:
  - rfc-0010
  - phase-2
  - worktree
milestone: m-2
dependencies:
  - AISDLC-70.1
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#7-worktree-pool-manager
  - orchestrator/src/execute.ts
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
WorktreePoolManager that allocates, adopts, and reclaims worktrees per RFC §7. Wired into execute.ts behind feature flag AI_SDLC_PARALLELISM=experimental. Estimated 1–2 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorktreePoolManager implemented at orchestrator/src/runtime/worktree-pool.ts with allocate, adopt, reclaim, cleanupOnMerge methods per RFC §7.1/§7.3
- [ ] #2 Wired into orchestrator/src/execute.ts behind feature flag AI_SDLC_PARALLELISM=experimental
- [ ] #3 Integration test: dispatch 3 issues against fixture repo, verify isolated worktrees + distinct ports + clean reclamation on PR merge
- [ ] #4 Unit tests cover allocation/adoption/reclamation paths including stale-threshold reclamation (default 14 days)
- [ ] #5 New code reaches 80%+ patch coverage
<!-- AC:END -->
