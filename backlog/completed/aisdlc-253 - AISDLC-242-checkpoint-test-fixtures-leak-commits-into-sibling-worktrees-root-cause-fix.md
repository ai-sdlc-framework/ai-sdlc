---
id: AISDLC-253
title: AISDLC-242 checkpoint test fixtures leak commits into sibling worktrees — root-cause + fix
status: To Do
assignee: []
created_date: '2026-05-10 00:15'
labels:
  - bug
  - infrastructure
  - test-pollution
  - rfc-0015
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/checkpoint.test.ts
  - pipeline-cli/src/orchestrator/loop.resume.test.ts
  - pipeline-cli/src/orchestrator/checkpoint.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The AISDLC-242 checkpoint test fixtures (`pipeline-cli/src/orchestrator/checkpoint.test.ts` + `loop.resume.test.ts`) leak commits into the host worktree's actual git branch when `pnpm test` runs as part of a dev subagent's verification step. This has now caused observable damage on at least 4 worktrees (AISDLC-251, AISDLC-236, AISDLC-231 twice).

## Symptoms (observed on PR #425 / AISDLC-231 worktree, 2026-05-09 23:43:27)

Reflog evidence:

```
c86fa06d ai-sdlc/aisdlc-231-blast-radius-overlap@{2026-05-09 23:43:27 -0700}: commit: chore: initial
05776fc6 ai-sdlc/aisdlc-231-blast-radius-overlap@{2026-05-09 23:43:27 -0700}: commit: wip(checkpoint): test annotation (AISDLC-242)
79e235fb ai-sdlc/aisdlc-231-blast-radius-overlap@{2026-05-09 23:39:37 -0700}: commit: chore: auto-sign attestation for AISDLC-231
ac8443f1 ai-sdlc/aisdlc-231-blast-radius-overlap@{2026-05-09 23:39:31 -0700}: commit: chore(spec): sign attestation
084db792 ai-sdlc/aisdlc-231-blast-radius-overlap@{2026-05-09 23:34:42 -0700}: commit: fix(orchestrator): fix 4 majors...
```

Two leak commits at EXACTLY the same second (`23:43:27`) — sequential automated execution, not human action.

After the leak the worktree's `HEAD` tree contains only `README.md` (1 file vs 2477 in the legitimate fix commit). The leak completely wiped the project state on the actual branch and pushed to GitHub before being caught.

## What I confirmed about the source

- Author `Test User <test@example.com>` exactly matches `checkpoint.test.ts:45-46` git config (NOT `loop.resume.test.ts` which uses just `"Test"` without `"User"`)
- Subject `wip(checkpoint): test annotation (AISDLC-242)` — the literal `'test annotation'` exists ONLY at `checkpoint.test.ts:122` and `:138`
- Subject `chore: initial` matches `makeGitRepo()` fixture commit at `checkpoint.test.ts:49,76`
- HEAD tree = README.md only — exactly what `makeGitRepo()` produces

## What I could not pinpoint in available investigation time

- The exact mechanism by which `mkdtempSync(...)` resolves to the worktree's git repo
- All test code APPEARS correct: every `execSync` has explicit `cwd:`, `mkdtempSync` returns paths under `/var/folders/...`, no `process.chdir()` anywhere in `pipeline-cli/src/`

## Suspect mechanisms (any of these could explain it)

1. **Vitest worker cwd inheritance** — workers spawned from the worktree's cwd; if any test calls `execSync('git ...')` without explicit `cwd:`, git walks up from the worker's cwd and finds the worktree's `.git/`
2. **Hidden `process.chdir()`** in an imported helper or vitest plugin that grep missed
3. **`git status --porcelain` walk-up** — when test passes `plainDir` (a fresh temp dir, no git), git walks UP to find a repo. On macOS the temp dir is `/var/folders/...` which has no git ancestor — but if anything alters resolution, it could hit the worktree
4. **`GIT_DIR` / `GIT_WORK_TREE` env leakage** from the Bash session's environment
5. **Vitest threads pool** with shared module state where one test changes a module-level variable that subsequent tests inherit

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Reproduce the leak in isolation (run `pnpm test --filter @ai-sdlc/pipeline-cli` from inside a fresh `.worktrees/aisdlc-test-leak/` worktree, observe leak commits on the worktree's branch)
- [ ] #2 Identify the exact code path that allows a test fixture's git command to land in the host worktree's `.git/`
- [ ] #3 Fix at the source — examples (pick whichever is correct per the root cause):
  - Add `GIT_DIR` / `GIT_WORK_TREE` env unset in test helpers
  - Switch vitest pool to `forks` (true process isolation per test file)
  - Add a worktree-path guard to production `emitCheckpointCommit` that refuses to commit when cwd resolves to a `.worktrees/<id>/` path that doesn't match `opts.taskId`
  - Add a vitest setup that guards against any `cwd` resolving to a `.worktrees/` ancestor in a test
- [ ] #4 Add a regression test that exercises the previously-leaking path and asserts no commits land on the host worktree's branch
- [ ] #5 Document the failure mode + fix in the AISDLC-242 retro section of `pipeline-cli/docs/orchestrator.md`
- [ ] #6 Verify against the cross-worktree corpus: re-run dev subagents on 3 different worktrees, confirm no `wip(checkpoint)` or `chore: initial` commits leak
<!-- SECTION:ACCEPTANCE:END -->

## Composes with

- `feedback_bash_cwd_persists.md` — likely related root-cause class
- `feedback_test_git_identity_bleed.md` — sister bug (test fixture polluting worktree git config); may share root cause

## Recovery history

- AISDLC-251 worktree: reset + force-push (operator)
- AISDLC-236 worktree: reset + force-push (operator)
- AISDLC-231 / PR #425 (this incident): reset to ac8443f1 + force-push-with-lease (operator-approved 2026-05-10)

## Severity rationale

**High priority** — every dev subagent dispatch on the orchestrator currently risks wiping the worktree's branch state and pushing the wipe to GitHub. The pattern has reproduced 4× across 3 distinct worktrees in 48 hours. Each incident requires a force-push-with-lease recovery (destructive operation, requires operator approval). Continuing dispatch without a fix amplifies blast radius.
<!-- SECTION:DESCRIPTION:END -->
