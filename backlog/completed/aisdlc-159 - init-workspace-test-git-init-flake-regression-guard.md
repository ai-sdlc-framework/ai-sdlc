---
id: AISDLC-159
title: >-
  init-workspace.test.ts — re-apply / harden AISDLC-189 helper
  guard against git-init flake regression
status: Done
assignee:
  - '@dominique'
created_date: '2026-05-02 21:14'
updated_date: '2026-05-02 21:14'
labels:
  - orchestrator
  - test
  - regression
  - bug
dependencies:
  - AISDLC-134
  - AISDLC-189
references:
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - backlog/completed/aisdlc-134 - init-workspace.test.ts-falls-back-to-your-org-placeholder-is-git-origin-sensitive-fails-inside-any-worktree-with-a-real-origin.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Background.** AISDLC-189 (PR #189, commit `2ed1039`) replaced
`execSync('git init --quiet')` inside `initBareRepo` in
`orchestrator/src/cli/commands/init-workspace.test.ts` with direct
`mkdirSync + writeFileSync` of the minimal `.git/` layout. The original
failure shape was 10 of 14 tests failing deterministically with
`initBareRepo: \`git init\` did not create .git/config in <dir>` under
heavy parallel CPU contention (e.g. `pnpm -r test:coverage` running every
package's coverage suite concurrently) — the `git init` subprocess was
exiting 0 without writing `.git/config`.

**Reported regression.** The same `initBareRepo: git init did not create
.git/config` failure shape was flagged again during the RFC-0016 v3
update push, suggesting either the fix was reverted, a different test
re-introduced the pattern, or an in-flight worktree predated the fix.

## Investigation findings

1. **AISDLC-189 fix is intact in `main` and in this worktree** — the
   `initBareRepo` helper at `orchestrator/src/cli/commands/init-workspace.test.ts`
   uses direct fs writes (no `git init`).
2. **No other test in `orchestrator/src` reproduces the same flake** —
   `git-env.test.ts` does spawn `gitExecFile(['init', ...])` but it is
   the deliberate subject of that test (verifying `cleanGitEnv` strips
   leaked `GIT_DIR`); replacing it would lose coverage and is not the
   reported failure source.
3. **Root cause of the report**: the failure surfaced from a worktree
   that had not yet rebased onto `main` (predated commit `2ed1039`).
   The runtime `existsSync` belt-and-braces (added in AISDLC-134) catches
   the silent flake but only AFTER a contention-affected test has
   already run — the operator only sees the failure deep inside a
   `pnpm -r test:coverage` log.
4. **Gap**: there is no source-level guarantee that future edits won't
   re-introduce `git init` (or any other git subprocess) into the
   `initBareRepo` helper. The next maintainer who refactors this file
   could trivially regress AISDLC-189.

## Fix

1. **Hermetic source-level regression test** (`initBareRepo source shape
   — AISDLC-159 regression guard`, two new `it()` blocks at the bottom
   of `init-workspace.test.ts`) that:
   - reads its own source via `fileURLToPath(import.meta.url)`;
   - locates the body of `function initBareRepo(...)`;
   - asserts the body contains NONE of: `git init` substring,
     `execSync('git ...')`, `execFile(Sync)?('git', ...)`, `gitExecFile(...)`,
     `spawn(Sync)?('git', ...)`;
   - failure message names AISDLC-189 + AISDLC-159 so the next
     maintainer can find the history without digging.
2. **Behavioral guard** that calls `initBareRepo` against a fresh
   tmpdir and asserts the post-state matches what `git init` would have
   produced (HEAD, config, refs/heads, objects/info, objects/pack) —
   catches any regression that satisfies the source-level pattern check
   but silently no-ops at runtime.
3. **Tightened helper assertion**: post-write `existsSync` now checks
   BOTH `.git/config` and `.git/HEAD` (was config-only).

The test fails at vitest collect time, BEFORE any test runs, the moment
a future edit reintroduces `git init`, with a precise message pointing
at the AISDLC-189 fix.

## Verification

- `pnpm --filter @ai-sdlc/orchestrator test src/cli/commands/init-workspace.test.ts` →
  16/16 pass (was 14, +2 regression-guard tests).
- Verified the guard FIRES when broken: temporarily replaced
  `initBareRepo` body with `execSync('git init --quiet', ...)` →
  test failed with the precise AISDLC-189 + AISDLC-159 message.
  Restored cleanly.
- `pnpm --filter @ai-sdlc/orchestrator test` → 156 files / 2997 tests pass.
- `pnpm -r test:coverage` (full parallel coverage matrix — the
  AISDLC-189 contention scenario) → exit 0; orchestrator 156 files /
  2997 tests, all 9 packages green.
- `pnpm lint` clean, `pnpm format:check` clean,
  `pnpm --filter @ai-sdlc/orchestrator build` clean.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Root cause identified + documented (worktree predated `2ed1039`; no live regression on `main`; no other test file affected).
- [x] #2 Fix applied: hermetic source-level regression guard + behavioral guard + tightened helper assertion.
- [x] #3 Hermetic regression test fails if `git init` ever silently no-ops in this test suite again — fails at vitest collect time at the helper level, with precise AISDLC-189 message.
- [x] #4 `pnpm --filter @ai-sdlc/orchestrator test src/cli/commands/init-workspace.test.ts` passes (16/16, 14 original + 2 new regression guards).
- [x] #5 `pnpm -r test:coverage` (full parallel coverage matrix) passes — exit 0, all 9 packages green.
<!-- AC:END -->

## Final summary

<!-- SECTION:FINALSUMMARY:BEGIN -->
## Summary

Hardened the AISDLC-189 fix with a hermetic source-level regression
guard that fails at vitest collect time the moment a future edit
reintroduces `git init` (or any git subprocess) into the `initBareRepo`
helper. The original fix is intact on `main`; the reported regression
came from a worktree that predated commit `2ed1039`. The new guard
prevents the same regression from being silently re-introduced.

## Changes

- `orchestrator/src/cli/commands/init-workspace.test.ts` (modified):
  - Added `fileURLToPath` import.
  - Tightened the `initBareRepo` post-write assertion to also check
    `.git/HEAD` (was config-only).
  - Appended a new describe-block (`initBareRepo source shape —
    AISDLC-159 regression guard`) with two `it()` tests:
    1. Source-level: reads own source, locates `initBareRepo` body,
       asserts it contains none of `git init`, `execSync('git ...')`,
       `execFile(Sync)?('git', ...)`, `gitExecFile(...)`,
       `spawn(Sync)?('git', ...)`. Failure message names AISDLC-189 +
       AISDLC-159 for trace-back.
    2. Behavioral: invokes `initBareRepo` against a tmpdir + asserts
       the post-state matches what `git init` would have produced.
- `backlog/tasks/aisdlc-159-*.md` -> `backlog/completed/aisdlc-159-*.md`
  (new): this task file.

## Design decisions

- **Source-level meta-test over runtime detector**: the runtime
  `existsSync` belt-and-braces (AISDLC-134) catches the flake but only
  AFTER a test has already failed. A source-level pattern check fails
  at vitest collect time, before any subprocess runs, so the operator
  sees the regression in seconds with a precise actionable message
  rather than minutes of `pnpm -r test:coverage` noise.
- **Pattern list errs on the side of false positives**: there is NO
  legitimate reason for `initBareRepo` to spawn ANY git subprocess; it
  exists specifically to avoid the AISDLC-189 contention flake. A
  future maintainer adding e.g. `git config user.email` inline would
  also trip the guard, which is correct — they should use a separate
  helper.
- **Did not modify `git-env.test.ts`**: that file deliberately spawns
  `gitExecFile(['init', ...])` to verify `cleanGitEnv()` strips leaked
  `GIT_DIR`. Replacing the spawn would lose the actual subject under
  test. The reported regression is specific to `initBareRepo`, not the
  general subprocess flake — `git-env.test.ts` has run cleanly under
  every coverage matrix to date.

## Verification

- `pnpm build` — clean (workspace-wide)
- `pnpm --filter @ai-sdlc/orchestrator test` — 156 files / 2997 tests
  (was 2995, +2 regression guards)
- `pnpm -r test:coverage` — exit 0, all 9 packages green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Guard-fires-when-broken check: temporarily reverted `initBareRepo` to
  `execSync('git init --quiet', ...)`; the source-level guard failed
  with the precise AISDLC-189 + AISDLC-159 diagnostic. Restored cleanly.

## Follow-up

(none)
<!-- SECTION:FINALSUMMARY:END -->
