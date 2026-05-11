---
id: AISDLC-257
title: AISDLC-253 leak fix incomplete — worktree-pool.integration.test.ts still uses test@example.com without env GIT_ENV
status: To Do
assignee: []
created_date: '2026-05-10 10:30'
labels:
  - bug
  - infrastructure
  - test-pollution
  - rfc-0015
  - regression
dependencies: []
priority: high
references:
  - orchestrator/src/runtime/worktree-pool.integration.test.ts
  - pipeline-cli/src/__test-helpers/git-env.ts
  - pipeline-cli/src/orchestrator/checkpoint.test.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-253 (PR #429, merged 2026-05-10) hardened `pipeline-cli/src/orchestrator/checkpoint.test.ts` and `loop.resume.test.ts` against GIT_DIR / GIT_WORK_TREE env-bleed via the new `makeGitEnv()` helper. **The fix missed `orchestrator/src/runtime/worktree-pool.integration.test.ts`**.

## Evidence (2026-05-10 10:22 PT, AFTER AISDLC-253 merged)

The 178.7 dev subagent ran `pnpm test` in its worktree (created from main AT a SHA that already had AISDLC-253 merged). 9 leak commits landed on top of its work:

```
b0d1ae57 wip(checkpoint): step 2 (AISDLC-242)
c2fd5ed1 wip(checkpoint): step 1 (AISDLC-242)
c78d9ed0 wip(checkpoint): word word ... (AISDLC-242)
cb59c37f wip(checkpoint): edited `file.ts` & more; $(echo pwned) (AISDLC-242)
c4a63064 wip(checkpoint): captured untracked (AISDLC-242)
21e360bf wip(checkpoint): after editing 3 files (AISDLC-242)
0e7430f2 wip(checkpoint): after editing new-file.ts (AISDLC-242)
4b292fe5 wip(checkpoint): no changes (AISDLC-242)
1a2421e5 wip(checkpoint): test annotation (AISDLC-242)
```

Author on every commit: `Test User <test@example.com>` — exact match for AISDLC-253's checkpoint.test.ts identity. But that file was hardened. So why?

`grep -rln "test@example.com" pipeline-cli/src/ orchestrator/src/` reveals:
- `pipeline-cli/src/orchestrator/checkpoint.test.ts` — hardened (env: GIT_ENV)
- `pipeline-cli/src/orchestrator/loop.resume.test.ts` — hardened
- **`orchestrator/src/runtime/worktree-pool.integration.test.ts:58`** — NOT hardened. Calls `git config user.email test@example.com` without `env: GIT_ENV`.

When the 178.7 dev's `pnpm test` ran, this integration test executed git commands that inherited the dev subagent's `GIT_DIR` env (operator's bash session pre-pollution), wrote the polluted identity into the host worktree's `.git/config`, and subsequent test commits cascaded the leak commits onto the worktree's branch.

## Recovery

Already done by main session 2026-05-10 10:30 PT: `git reset --hard 7d38a816 && git push --force-with-lease` on PR #434.

## Fix

Apply the AISDLC-253 hardening pattern to `orchestrator/src/runtime/worktree-pool.integration.test.ts`:
- Import `makeGitEnv` from a shared helper (the existing helper at `pipeline-cli/src/__test-helpers/git-env.ts` is in pipeline-cli; either import cross-package or duplicate the helper into `orchestrator/src/__test-helpers/`)
- Pass `env: makeGitEnv()` to every `execFile` / `execSync` git command in this test
- Remove `git config user.email "test@example.com"` write (provide identity via `GIT_AUTHOR_*` env vars)

Also: **audit ALL test files in `orchestrator/src/`** for the same pattern. The AISDLC-253 sweep stopped at `pipeline-cli/`.

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Audit all `orchestrator/src/**/*.test.ts` files for `execSync('git ...')` / `execFile('git', ...)` calls without `env:` override
- [ ] #2 Either share the `git-env.ts` helper across packages OR duplicate it into `orchestrator/src/__test-helpers/git-env.ts`
- [ ] #3 Apply `env: makeGitEnv()` to every git-shelling test in orchestrator/, starting with `worktree-pool.integration.test.ts:58`
- [ ] #4 Remove `git config user.email/user.name` writes in favor of `GIT_AUTHOR_*` env (matches AISDLC-253 / AISDLC-241 / AISDLC-246 pattern)
- [ ] #5 Extend the AISDLC-253 e2e leak-reproduction test (or add a sibling in orchestrator/) that pollutes `process.env.GIT_DIR` and asserts no leak from any orchestrator/ test
- [ ] #6 Cross-link the regression in CLAUDE.md feedback section so future test additions remember to use makeGitEnv()
<!-- SECTION:ACCEPTANCE:END -->

## Severity

**HIGH.** The leak still wipes worktree state on dev-subagent dispatch. Until this lands, every `pnpm test` from a worktree (which the dev subagent runs at Step 5 verification) risks the same data loss as AISDLC-253. Recovery requires force-push-with-lease (operator-approval-gated destructive op).
<!-- SECTION:DESCRIPTION:END -->
