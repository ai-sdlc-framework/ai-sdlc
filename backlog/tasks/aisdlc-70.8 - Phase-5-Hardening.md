---
id: AISDLC-70.8
title: 'Phase 5: Hardening'
status: To Do
assignee: []
created_date: '2026-04-26 19:47'
labels:
  - rfc-0010
  - phase-5
  - hardening
milestone: m-2
dependencies:
  - AISDLC-70.7
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#19-implementation-plan
  - docs/operations/operator-runbook.md
  - CHANGELOG.md
parent_task_id: AISDLC-70
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Chaos test, runbook extensions, and feature-flag promotion to default-on after 1 week of dogfood stability (RFC §17 Phase 5). Estimated 1 week.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Chaos test: kill agents mid-stage at three points (during plan, during implement, during validate); verify worktree reclamation + resumability per RFC §16.3
- [ ] #2 Operator runbook extended with any new failure modes discovered during Phases 1–4 implementation (docs/operations/operator-runbook.md)
- [ ] #3 Operator runbook entries for WorktreeOwnershipMismatch, RebaseConflict, stuck heartbeats per RFC §17 Phase 5
- [ ] #4 After 1 week of dogfood pipeline running with AI_SDLC_PARALLELISM=experimental, promote feature flag to default-on
- [ ] #5 Document the promotion in CHANGELOG.md and spec/rfcs/RFC-0010-*.md revision history (v21)
<!-- AC:END -->
