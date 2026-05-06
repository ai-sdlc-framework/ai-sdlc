---
id: AISDLC-210
title: >-
  Worktree-pool integration test has port-collision flake (3 tmp paths sometimes
  hash to 2 ports)
status: To Do
assignee: []
created_date: '2026-05-06 04:46'
labels:
  - bug
  - tech-debt
  - test-infrastructure
  - orchestrator
  - flake
dependencies: []
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`orchestrator/src/runtime/worktree-pool.integration.test.ts:95` (test "dispatches 3 isolated worktrees with distinct ports and reclaims cleanly") asserts `new Set(ports).size === 3` for 3 worktree paths fed through `allocatePort()`. The deterministic port allocator hashes the worktree path. Empirically (PR #349 CI run): 3 random tmp paths sometimes produce only 2 distinct ports — port collision in the deterministic hash space.

## Repro
The test uses `mkdtempSync`-generated paths; collisions happen when 2 of the 3 paths happen to hash to the same value. Frequency unknown — fired once during PR #349's CI; passed on re-run.

## Impact
Flaky CI failure that blocks PRs intermittently. Not a real bug in the port allocator (collisions are mathematically possible given finite port space) — the test's assumption is too strict.

## Fix options
1. **Loosen the assertion**: assert `new Set(ports).size >= 2` (i.e., at least some distinction) and verify all returned ports are in the valid range.
2. **Use deterministic test paths**: instead of `mkdtempSync`, use 3 pre-chosen paths that are known not to collide for the test fixture (e.g. `/tmp/ai-sdlc-test-port-{1,2,3}`).
3. **Inject the port allocator's seed**: parameterize the deterministic hash so the test can guarantee no collision.

Option 2 is the cheapest. Option 3 is the most principled (the test exercises the deterministic property; using a fixed input proves determinism without depending on hash distribution).

## Acceptance Criteria
- [ ] #1 The test no longer relies on chance hash distribution of mkdtemp paths
- [ ] #2 Test still meaningfully verifies the deterministic-port property of allocatePort
- [ ] #3 Test does not introduce hardcoded paths that could collide with concurrent test runs
- [ ] #4 Document the port-collision possibility in the port-allocator's JSDoc + a note that integration tests must use deterministic paths
<!-- SECTION:DESCRIPTION:END -->
