---
id: AISDLC-241
title: >-
  Parallel orchestrator tick races on .git/config lock during git worktree add
status: Done
assignee: []
created_date: '2026-05-08 00:50'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - parallel-dispatch
  - framework-bug
  - dogfood
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-orchestrator tick --max-concurrent 2` (or higher) attempts to create N worktrees concurrently via `git worktree add`. Both spawned subprocesses race to write `.git/config` (git stores the upstream tracking config there). The second one loses with:

```
git worktree add failed for branch 'ai-sdlc/aisdlc-202.2-...':
  Preparing worktree (new branch '...')
  error: could not lock config file .git/config: File exists
  error: unable to write upstream branch configuration
  hint: After fixing the error cause you may try to fix up
  hint: the remote tracking information by invoking:
  hint:   git branch --set-upstream-to=origin/refs/heads/main
Likely cause: branch already exists. Run `/ai-sdlc cleanup AISDLC-202.2` first or pick a different task.
```

The error message claims "branch already exists" but the real cause is the parent's `.git/config` lock contention.

Witnessed empirically 2026-05-07 with `cli-orchestrator tick --max-concurrent 2` dispatching AISDLC-178.7 + AISDLC-202.2: 178.7 won the lock and proceeded; 202.2 lost and aborted with this error.

## Why this matters

This is the load-bearing bug that prevents safe parallel orchestrator dispatch. RFC-0015's vision of unattended autonomous orchestration with `--max-concurrent N` is broken until this is fixed. Today operators must dispatch sequentially (`--max-concurrent 1`) to avoid it.

## Proposed fix

### Option A — Serialize the worktree-add step inside the tick

Wrap the `git worktree add` call in a per-process mutex inside the orchestrator (an `await using lock = await asyncMutex.acquire()` pattern). Worktree creation becomes serialized; everything AFTER it (dev, reviewers, sign, push) stays parallel. Cost: brief serialization at dispatch start (~1s per task).

### Option B — Retry on lock-acquisition failure

Catch the "could not lock config file .git/config" error and retry with exponential backoff (50ms, 100ms, 200ms, 400ms). Cost: marginal latency under contention; no architectural change.

### Option C — Use git's atomic-update mechanism

`git worktree add` may have an internal lock — investigate whether it's actually contention on `.git/config` write or something else. Fix at the right git layer.

Recommendation: Option A is the cleanest (serialization where contention is) + Option B as defense-in-depth.

## Acceptance Criteria

- [ ] #1 Identify whether the lock contention is `.git/config` specifically or something else (use `strace`/`fs_usage` on parallel `git worktree add` to confirm)
- [ ] #2 Apply chosen fix in `pipeline-cli/src/orchestrator/loop.ts` (or wherever worktree creation is dispatched)
- [ ] #3 Hermetic test: stub `git worktree add` to simulate concurrent invocations; assert the wrapper serializes correctly + recovers from lock failures
- [ ] #4 Integration test: real `cli-orchestrator tick --max-concurrent 4` against a fixture frontier with 4 admissible tasks; verify all 4 worktrees get created without lock errors
- [ ] #5 Operator runbook updated documenting the fix + the previous workaround (use `--max-concurrent 1`)

## References

- `pipeline-cli/src/orchestrator/loop.ts` (worktree creation in dispatch path)
- AISDLC-228 (Step 3 quarantine guard — adjacent parallel-dispatch concern)
- AISDLC-227 (in-flight detection — adjacent parallel-dispatch concern)
- AISDLC-231 (hot-file dispatch serializer — adjacent parallel-dispatch concern)
- Witnessed 2026-05-07: `cli-orchestrator tick --max-concurrent 2` dispatching 178.7 + 202.2; 202.2 aborted on `.git/config` lock
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Identify the actual lock-contention surface (.git/config or other)
- [ ] #2 Apply chosen fix (serialize + retry-with-backoff)
- [ ] #3 Hermetic test verifies the wrapper handles concurrent invocations
- [ ] #4 Integration test: --max-concurrent 4 against 4 admissible tasks succeeds
- [ ] #5 Operator runbook documents the fix
<!-- SECTION:ACCEPTANCE:END -->
