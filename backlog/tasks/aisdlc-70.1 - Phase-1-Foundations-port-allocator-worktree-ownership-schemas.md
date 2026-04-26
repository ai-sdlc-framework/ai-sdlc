---
id: AISDLC-70.1
title: 'Phase 1: Foundations (port allocator + worktree ownership + schemas)'
status: To Do
assignee: []
created_date: '2026-04-26 19:44'
labels:
  - rfc-0010
  - phase-1
  - runtime
milestone: m-2
dependencies: []
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#7-worktree-pool-manager
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#8-deterministic-port-allocator
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#6-schema-amendments
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Foundational primitives that all subsequent phases build on: deterministic port allocator (RFC §8), worktree slug + cross-clone ownership verification (RFC §7.2/§7.4), and JSON schemas for the new resources. Low-risk, high-value first PR. Estimated 1 week.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 port(worktreePath, basePort) implemented in orchestrator/src/runtime/port-allocator.ts per RFC §8.1, with unit tests covering distribution and collision-probe behavior
- [ ] #2 Worktree slug normalization + cross-clone ownership verification (verifyOwnership) implemented in orchestrator/src/runtime/worktree.ts per RFC §7.2/§7.4, with unit tests against fixture repo
- [ ] #3 JSON schemas added for Pipeline.spec.parallelism, WorktreePool, SubscriptionPlan, DatabaseBranchPool per RFC §6
- [ ] #4 New code reaches 80%+ patch coverage
<!-- AC:END -->
