---
id: AISDLC-1128
title: 'Fixture teardowns never delete a path outside tmpdir: shared guard and sweep of the ten git-derived roots'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - testing
  - incident
  - safety
dependencies: []
references:
  - pipeline-cli/src/__test-helpers/make-task.ts
  - pipeline-cli/src/cli/attestation.test.ts
  - pipeline-cli/src/steps/03-setup-worktree.test.ts
  - pipeline-cli/src/steps/00-sweep.test.ts
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: high
dispatchable: true
---

## Description

The deleter in the 2026-10-30 incident was `rmSync(join(gitCommonDir, '..'), { recursive: true, force: true })` in a test teardown: the path came from a git answer, and nothing checked where it pointed. The fix PR guarded that one test. The incident record lists ten test files that `rmSync` a root derived from git or from a computed parent; each one is a repeat of the same hazard.

**Five-step review.**
1. Requirement questioned: teardowns must clean up; yes.
2. Delete: nothing.
3. Simplify: one helper, `removeFixtureDir(path)` in `pipeline-cli/src/__test-helpers/`, that `realpath`s both the path and `tmpdir()` and refuses (throws, deletes nothing) unless the path is strictly inside the tmpdir. Every teardown calls it instead of `rmSync`.
4. Accelerate: none needed.
5. Automate: the gate from AISDLC-1127 (or a line in it) flags a test file that calls `rmSync(..., { recursive: true })` directly.

Velocity impact: neutral.

## Acceptance Criteria

- [ ] AC-1: `removeFixtureDir()` exists in the shared test helpers, is `sep`-aware, treats the tmpdir itself as outside, and has its own tests (inside, outside, symlink into tmpdir, nonexistent path).
- [ ] AC-2: The ten files named in the incident record's bisect (every test that `rmSync`s a git-derived or computed root) use the helper; `grep -rn "rmSync(.*recursive" pipeline-cli/src --include='*.test.ts'` returns only the helper's own tests.
- [ ] AC-3: With a leaked `GIT_DIR` and the vitest setup layer disabled, the ten files fail closed against a sacrificial repository instead of deleting it (same experiment as the incident reproduction, documented in the PR body).

## Notes

Origin: incident record 2026-10-30, follow-up list. Complements AISDLC-1127 (prevention at the spawn) with prevention at the delete.
