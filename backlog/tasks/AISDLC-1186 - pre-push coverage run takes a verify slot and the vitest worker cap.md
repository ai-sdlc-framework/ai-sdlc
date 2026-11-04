---
id: AISDLC-1186
title: 'Pre-push coverage run takes a verify slot and the vitest worker cap'
status: In Progress
assignee: []
created_date: '2026-11-04'
labels:
  - hooks
  - verify
  - fix
dependencies: []
references:
  - scripts/pre-push-patch-coverage.mjs
  - scripts/pre-push-patch-coverage.test.mjs
  - pipeline-cli/src/runtime/verify-slots.ts
  - vitest.shared.mjs
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-04: cut contention between test runs (lever 2 of 4).

**Today.** Machine verify takes one of two board slots (`acquireVerifySlot`, AISDLC-1087) and caps vitest at 4 workers alone or 2 when both slots are held. The pre-push hook's `test:coverage` run takes no slot and sets no cap, so it gets `min(4, ncpu/2)` workers per package on top of any running verify. With two executors verifying and a third pushing, the host runs three uncapped-relative suites at once, which is the load that AISDLC-1087 set out to bound.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the slot exists to bound concurrent suites on this host; a pre-push suite is one, so it counts. 2. Deleted: nothing. 3. Simplified: reuse `acquireVerifySlot` from the built pipeline-cli; no second lock. 4. Accelerated: none. 5. Automated: tests below.

The hook resolves the board directory from `AI_SDLC_DISPATCH_BOARD_DIR`, else `<main checkout>/.ai-sdlc/dispatch` found through `git rev-parse --git-common-dir`. When the board directory exists and `pipeline-cli/dist/runtime/verify-slots.js` loads, the hook takes a slot before the first `test:coverage` run, passes `AI_SDLC_VITEST_MAX_WORKERS` from the slot to each child, and releases the slot on every exit path, including a signal. When either is missing (a fresh clone, an adopter without a board), the hook runs as today and prints one line saying it ran unslotted.

The wait is bounded. After 10 minutes without a slot the hook runs unslotted with `VERIFY_WORKERS_SHARED` workers and says so; a push never hangs on a stuck board.

**Hook-spawned processes (AISDLC-1129).** The new `git rev-parse` call and every child keep using `sessionScrubbedEnv()`, so `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` are unset. The PR body states this.

## Acceptance Criteria

- [ ] AC-1: With a board directory and the built module present, the hook holds a slot for the whole coverage run and each child gets the slot's `AI_SDLC_VITEST_MAX_WORKERS`. A test with injected slot deps asserts both.
- [ ] AC-2: The slot is released after success, after a failing package, after a failing patch gate, and on SIGINT/SIGTERM. Tests cover the first three; the signal path is covered or the PR body explains why it cannot be.
- [ ] AC-3: Without a board directory, or when the module cannot load, the hook runs as today and prints one unslotted line. Tests cover both.
- [ ] AC-4: After the bounded wait the hook runs unslotted with the shared worker count. A test with an injected clock covers it.
- [ ] AC-5: No pipeline caller pushes while holding a verify slot (the hook would wait on its own parent). The PR body names the push call sites checked.
- [ ] AC-6: `docs/operations/cli-hierarchy.md` states that pre-push runs share the verify slots.
