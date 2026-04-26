---
id: AISDLC-70.1
title: 'Phase 1: Foundations (port allocator + worktree ownership + schemas)'
status: Done
assignee: []
created_date: '2026-04-26 19:44'
updated_date: '2026-04-26 20:19'
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
- [x] #1 port(worktreePath, basePort) implemented in orchestrator/src/runtime/port-allocator.ts per RFC §8.1, with unit tests covering distribution and collision-probe behavior
- [x] #2 Worktree slug normalization + cross-clone ownership verification (verifyOwnership) implemented in orchestrator/src/runtime/worktree.ts per RFC §7.2/§7.4, with unit tests against fixture repo
- [x] #3 JSON schemas added for Pipeline.spec.parallelism, WorktreePool, SubscriptionPlan, DatabaseBranchPool per RFC §6
- [x] #4 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 1 foundations for RFC-0010 implemented and committed as 8687bb0 on branch rfc/0010-parallel-execution-worktree-pooling. All four acceptance criteria met. 33 unit tests pass; full workspace build, lint, and format checks clean.

## Changes
- `orchestrator/src/runtime/port-allocator.ts` (new): deterministic md5-derived port + collision-probe walk + PORT env override + multi-port contiguous allocation. RFC §8.1-8.4.
- `orchestrator/src/runtime/worktree.ts` (new): branch slugification + cross-clone ownership verification via `.git` pointer parsing. RFC §7.2 / §7.4.
- `orchestrator/src/runtime/index.ts` (new): module exports.
- `orchestrator/src/runtime/{port-allocator,worktree}.test.ts` (new): 33 tests covering deterministic distribution, collision probe, PORT override, slug edge cases, and four ownership outcomes.
- `spec/schemas/pipeline.schema.json` (modified): added `Pipeline.spec.parallelism` field + `Parallelism` $def.
- `spec/schemas/worktree-pool.schema.json` (new): WorktreePool resource.
- `spec/schemas/subscription-plan.schema.json` (new): SubscriptionPlan resource.
- `spec/schemas/database-branch-pool.schema.json` (new): DatabaseBranchPool resource.
- `reference/src/core/generated-schemas.ts` (regenerated): 9 → 12 schemas.

## Design decisions
- **Port allocator returns sync deterministic port + async probe.** The pure function `deterministicPort()` is exported separately for callers who want the math without TCP binding (e.g., for diagnostics or fixture clocks). `allocatePort()` adds the binding probe + collision walk on top.
- **`isPortFree()` injectable for tests.** Tests pass `{ isPortFree: async () => true/false }` to avoid actually binding to ports — keeps tests fast and deterministic.
- **Worktree ownership uses async `readFile` + `stat`.** No sync I/O in the hot path; ready for the eventual concurrent dispatcher in Phase 3.
- **Schema additions use `$ref` to a new `Parallelism` $def.** Keeps the inline `properties` block clean and matches existing conventions in pipeline.schema.json.
- **`additionalProperties: true` on DatabaseBranchPool.spec.credentials.** Each adapter has its own credential shape (Neon: apiTokenEnv + projectId; pg-snapshot-restore: adminConnectionStringEnv; etc.). Adapter-level validation will narrow this in Phase 6.

## Verification
- `pnpm --filter @ai-sdlc/orchestrator test -- src/runtime` — 33/33 pass (14 port-allocator + 19 worktree)
- `pnpm --filter @ai-sdlc/reference build` — clean, 12 schemas generated
- `pnpm build` — full workspace clean
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Manual: `head` of generated-schemas.ts confirms new schemas present.

## Follow-up
Phase 2 (AISDLC-70.2) — WorktreePoolManager that consumes these primitives. Will add `git worktree add/remove` execution, the allocate/adopt/reclaim lifecycle, and feature-flag wiring into `execute.ts`.
<!-- SECTION:FINAL_SUMMARY:END -->
