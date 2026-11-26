---
id: AISDLC-1423
title: Concurrent runtime-deps installers run npm twice under CI load
status: Done
priority: medium
labels:
  - ai-sdlc-plugin
  - flaky-test
  - ci
dependencies: []
references:
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/scripts/install-runtime-deps-lock.test.mjs
---

## Description

**Five-step review (requirements first).**
1. Question: `install-runtime-deps-lock.test.mjs` AC1 (AISDLC-1084) asserts that two concurrent installers on one plugin dir run `npm install` once. It failed with `2 !== 1` at line 107 in four gate runs on 2026-11-25/26: 45766978060 (PR #3021, which does not touch the installer) and 45747614831, 45744829992, 45741582706 (all on `release-please--branches--main`). The failure blocks unrelated PRs and the release PR until someone re-runs the job. Requested by the operator on 2026-11-26. The requirement itself is right: overlapping `npm install --prefix <same dir>` runs corrupt the tree, which is why AISDLC-1084 added the lock. So the assertion is not the thing to loosen.
2. Delete: none until the cause is known.
3. Simplify: first find the cause. The `mkdir` lock (lines 188-219) looks correct, including the empty-pid window, so the two runs most likely come from the waiter: it takes the lock after the first installer finishes, re-checks, and still decides to install. Candidates to rule in or out: (a) the health check or the stale check (`check-stale-runtime-deps.mjs`, run after the lock) disagrees with the tree the stub just wrote; (b) a check that runs BEFORE taking the lock, so a decision made pre-lock is acted on post-lock; (c) the test itself, for example the stub's `sleep 2` racing the second spawn on a slow runner, so the waiter's log line or the tree write lands outside the window. If (a) or (b), fix the script: after taking the lock, the waiter makes its install decision only from a fresh check. If (c), make the test deterministic: start the second installer only once the first holds the lock (for example poll for `$LOCK_DIR/pid`), and do not raise sleeps or add retries.
4. Accelerate: none.
5. Automate: none added.

## Acceptance Criteria
- [ ] #1 The PR body names the root cause, with evidence (a reproduction under load, such as running AC1 in a loop with CPU contention, or a trace from the stub log), and says whether it was the script or the test.
- [ ] #2 AC1 still asserts exactly one `npm install`, one `installed successfully` and one `waited for lock`. No assertion is loosened, no retry is added and no sleep is raised.
- [ ] #3 AC1 passes 50 runs in a row locally under CPU contention, for example with `stress`/`yes` loads running beside it. The PR states the command used.
- [ ] #4 If the script changes, a new test pins the fixed behaviour: a waiter that takes the lock after a healthy install runs no npm.
- [ ] #5 `node --test ai-sdlc-plugin/scripts/install-runtime-deps*.test.mjs`, `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
