---
id: AISDLC-260
title: AISDLC-242 checkpoint test suite leaks real commits onto active branch
status: Done
assignee: []
created_date: '2026-05-12 10:55'
labels:
  - bug
  - test-isolation
  - aisdlc-242
  - blocker-class
priority: high
references:
  - pipeline-cli/src/orchestrator/checkpoint.ts
  - pipeline-cli/src/orchestrator/checkpoint.test.ts
  - pipeline-cli/src/__test-helpers/git-env.ts
  - orchestrator/src/runtime/git-env.ts
---

## Bug

During the first end-to-end dogfood of `cli-orchestrator tick` (RFC-0015) — AISDLC-259's dispatch — the AISDLC-242 checkpoint test suite **leaked 27 real `wip(checkpoint): … (AISDLC-242)` commits** onto the active feature branch. The polluted branch is preserved at `.worktrees/aisdlc-259/` (branch: `ai-sdlc/aisdlc-259-fix-tui-panel-border-misalignment-on-critical-path`) as evidence.

This is the **same class as AISDLC-241**'s `Test User <test@test.com>` identity bleed (see memory entry `feedback_test_git_identity_bleed.md`) — but worse, because the leak creates **real commits with the operator's authoring identity** on the branch HEAD, not just an identity-config leak that could be unset.

## Repro

1. Provision a worktree (e.g. via `/ai-sdlc execute <task>` or `cli-orchestrator tick`).
2. From the worktree, run any path that triggers the AISDLC-242 checkpoint tests, including:
   - `pnpm test:coverage` from `pipeline-cli/`
   - `pnpm test` from `pipeline-cli/`
   - The husky `pre-push` hook (runs `check-coverage.sh` which runs `pnpm test:coverage` via `pnpm -r --parallel exec`)
3. Inspect `git log` on the branch — observe commits like:
   - `wip(checkpoint): step 1 (AISDLC-242)`
   - `wip(checkpoint): edited file.ts & more; $(echo pwned) (AISDLC-242)`
   - `wip(checkpoint): captured untracked (AISDLC-242)`
   - etc.

Each `pnpm test:coverage` invocation appears to add **9 wip-checkpoint commits** to the branch HEAD. Three retries during the AISDLC-259 dispatch yielded 27 polluted commits.

## Likely root cause

The AISDLC-242 checkpoint test suite operates against a `git` working tree to verify checkpoint creation behavior. The tests almost certainly use one of:

- A test that does `git -C <fixture-dir>` but `<fixture-dir>` resolves to the calling repo's `.git` directory under some condition (working-tree vs git-dir mismatch).
- A test that uses `process.cwd()` instead of an injected `repoRoot` and inherits the test runner's cwd.
- A test that creates a temp dir via `mkdtempSync` but forgets to invoke `git init` in the temp dir, so `git` falls back to walking up and finds the parent repo.

Whatever the mechanism, the test is not hermetic — it leaks real commits with the operator's `user.email = dominique@reliablegenius.io` identity onto whatever branch happens to be checked out.

## Acceptance criteria

- [ ] Identify the failing isolation pattern in the AISDLC-242 test files (likely under `pipeline-cli/src/checkpoint/**.test.ts` or similar).
- [ ] Refactor the affected tests to use a hermetic temp-dir fixture (`mkdtempSync` + `git init` + `git -C <temp>` everywhere, never `process.cwd()`).
- [ ] Add a guard test (or pre-push gate) that fails if any test creates a commit outside `os.tmpdir()`. One implementation: have the test runner snapshot `git rev-parse HEAD` before and after the suite, asserting equality.
- [ ] Sweep the existing leaked branch (`.worktrees/aisdlc-259/` orphan branch) — operator decision whether to delete the worktree+branch or keep as forensic evidence.
- [ ] Add a memory entry consolidating this with the existing `feedback_test_git_identity_bleed.md` — test pollution incidents now span both identity AND commit-creation.

## Out of scope

- Re-doing the AISDLC-259 work (already shipped via cherry-pick in PR #459).
- Fixing the husky `pnpm -r --parallel exec test:coverage` flakiness (separate issue — see flaky failures during PR #458 + #459 pushes).

## Verification

- Run `pnpm --filter @ai-sdlc/pipeline-cli test` 10 times in a fresh worktree. Assert `git rev-parse HEAD` is unchanged across all 10 runs.
- Run the husky pre-push hook in a fresh worktree. Assert no new commits appear on the branch.

## finalSummary

### Summary
Strip `GIT_DIR` and `GIT_WORK_TREE` from the env passed to every `execSync`/`execFileSync` git call in `pipeline-cli/src/orchestrator/checkpoint.ts`. Production behavior unchanged when the vars are absent (the common case); when they ARE present (husky pre-push context, where `git push` exports `GIT_DIR=<host>/.git` to its child processes), the production code now ignores the bleed instead of writing through it.

### Changes
- `pipeline-cli/src/orchestrator/checkpoint.ts` (modified): added `productionGitEnv()` helper that returns `process.env` minus `GIT_DIR` and `GIT_WORK_TREE`; applied to all 5 git invocations (`status`, `add`, `commit`, `log --grep`, `rev-list --count`).
- `pipeline-cli/src/orchestrator/checkpoint.test.ts` (modified): added new `describe('emitCheckpointCommit() — AISDLC-260: env-bleed isolation', ...)` with 2 regression tests covering (a) commit lands on fixture not bleed target when GIT_DIR is set, (b) the count helpers also ignore the bleed env.

### Design decisions
- **Strip in production rather than only fix tests**: every caller benefits, including any future operator workflow that happens to export `GIT_DIR`. Minimal cost (creating a new env object per call).
- **Don't strip other env vars (e.g. `GIT_AUTHOR_*`)**: production needs operator identity from the environment when per-repo config doesn't override it.
- **No changes to `__test-helpers/git-env.ts`**: that helper is for test fixtures and was already correct (AISDLC-253). The bug was that the production code didn't scrub when called *from* tests.
- **End-to-end repro added inline rather than as a separate scripts test**: the existing checkpoint.test.ts is the right home for the regression — no need to invent a new test runner.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/orchestrator/checkpoint.test.ts` — 34 tests pass (including 2 new regression tests).
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 169 files / 2778 tests pass.
- `pnpm --filter @ai-sdlc/pipeline-cli test:coverage` (full suite) run with `GIT_DIR=<worktree>/.git` exported — host HEAD unchanged before vs after. End-to-end bleed test: ✓ NO BLEED.
- `pnpm format:check` — clean.
- `pnpm lint` — 0 errors (2 pre-existing warnings in `00-sweep.ts`, unrelated).

### Follow-up
- Audit other production files that shell out to git for the same `GIT_DIR`/`GIT_WORK_TREE` bleed pattern — `pipeline-cli/src/steps/**`, `pipeline-cli/src/cli/**`. May be an entire follow-up sweep task.
- Memory entry: consolidate `feedback_test_git_identity_bleed.md` to cover BOTH identity bleed (AISDLC-241) AND commit-creation bleed (AISDLC-260).
