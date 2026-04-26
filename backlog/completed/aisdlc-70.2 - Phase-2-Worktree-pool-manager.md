---
id: AISDLC-70.2
title: 'Phase 2: Worktree pool manager'
status: Done
assignee: []
created_date: '2026-04-26 19:44'
updated_date: '2026-04-26 20:28'
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
- [x] #1 WorktreePoolManager implemented at orchestrator/src/runtime/worktree-pool.ts with allocate, adopt, reclaim, cleanupOnMerge methods per RFC §7.1/§7.3
- [x] #2 Wired into orchestrator/src/execute.ts behind feature flag AI_SDLC_PARALLELISM=experimental
- [x] #3 Integration test: dispatch 3 issues against fixture repo, verify isolated worktrees + distinct ports + clean reclamation on PR merge
- [x] #4 Unit tests cover allocation/adoption/reclamation paths including stale-threshold reclamation (default 14 days)
- [x] #5 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 2 worktree pool manager committed as c099918. WorktreePoolManager (allocate/adopt/reclaim/cleanupOnMerge/list/reclaimStale) shipped with strict cross-clone ownership enforcement, dirty-tree safety on reclaim, and the AI_SDLC_PARALLELISM feature flag wired into execute.ts. 60 runtime tests pass (all 5 test files: port-allocator, worktree, worktree-pool unit, worktree-pool integration vs real git, parallelism-flag).

## Changes
- `orchestrator/src/runtime/worktree-pool.ts` (new): WorktreePoolManager.
- `orchestrator/src/runtime/parallelism-flag.ts` (new): AI_SDLC_PARALLELISM env reader.
- `orchestrator/src/runtime/{worktree-pool, worktree-pool.integration, parallelism-flag}.test.ts` (new): 17+3+6 tests.
- `orchestrator/src/runtime/worktree.ts` (modified): verifyOwnership now canonicalizes via fs.realpath to handle macOS /var → /private/var symlink.
- `orchestrator/src/runtime/index.ts` (modified): re-export new modules.
- `orchestrator/src/execute.ts` (modified): instantiate pool when flag is set, log activation; no behavior change when flag is off.

## Design decisions
- **Ownership guard defaults to strict**, advisory only via opt-in. Strict refuses adoption from a different clone with WorktreeOwnershipError.
- **Reclaim refuses dirty trees by default**, with `force: true` override. Matches the project's prior policy of treating destructive git ops as second-thought operations.
- **Injectable git + clock for tests**, real binary used for integration tests. Keeps unit tests fast and deterministic; integration tests catch real-git behavior we'd otherwise mock-around.
- **Wire-in is minimal at this phase** — instantiate + log. Phase 3 dispatcher converts execute.ts to worker-pool and routes through the manager.
- **Realpath canonicalization fix** in verifyOwnership unblocks integration tests on macOS without changing the public contract.

## Verification
- `pnpm --filter @ai-sdlc/orchestrator test -- src/runtime` — 60/60 pass
- `pnpm build` — clean
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
Phase 3 (AISDLC-70.6) consumes the manager. Until then the wire-in is dormant unless `AI_SDLC_PARALLELISM=experimental` is exported.
<!-- SECTION:FINAL_SUMMARY:END -->
