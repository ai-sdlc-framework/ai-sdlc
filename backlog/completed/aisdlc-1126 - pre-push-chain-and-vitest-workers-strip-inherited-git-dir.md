---
id: AISDLC-1126
title: 'Pre-push chain and vitest workers strip the inherited GIT_DIR (incident 2026-10-30: parent checkout deleted)'
status: Done
assignee: []
created_date: '2026-10-31'
updated_date: '2026-10-31'
labels:
  - hooks
  - incident
  - security
  - testing
dependencies: []
references:
  - .husky/pre-push
  - scripts/pre-push-patch-coverage.mjs
  - vitest.shared.mjs
  - vitest.git-env.setup.mjs
  - pipeline-cli/src/cli/attestation.test.ts
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: critical
dispatchable: false
---

## Description

On 2026-10-30 23:57Z the pre-push patch-coverage gate (AISDLC-1119, #2168) ran the pipeline-cli vitest suite from a linked worktree. Git exports `GIT_DIR` (an absolute path into the shared `.git`) and `GIT_PREFIX` to hooks in a linked worktree, the hook never unset them, and the fixture tests acted on the real repository: 47 test files flip `core.bare`, 39 otherwise mutate it, and the teardown of one test in `pipeline-cli/src/cli/attestation.test.ts` resolved `rev-parse --git-common-dir` to the real `.git` and deleted the directory above it. The parent checkout and all 45 worktrees were lost. Reproduced end to end in a sacrificial repository; record in `docs/operations/incidents/`.

**Five-step review.**
1. Requirement questioned: the gate is sound; the hazard is the environment it inherits. Nothing about the gate's purpose changes.
2. Delete: nothing to delete.
3. Simplify: one `unset` line at the top of the hook is the whole fix. The other layers are defence in depth because 81 of 87 git-spawning tests do not use `makeGitEnv()`.
4. Accelerate: no runtime cost.
5. Automate: follow-up, a check that fails any test spawning `git` without the stripped environment.

Velocity impact: positive. The hierarchy cannot be brought back up until this lands.

## Acceptance Criteria

- [x] AC-1: `.husky/pre-push` unsets `GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES` before the first gate; a test asserts the line, its position and its behaviour under `sh`.
- [x] AC-2: `scripts/pre-push-patch-coverage.mjs` spawns every child with `gitSafeEnv()`; a test pollutes `GIT_DIR` and asserts no child env carries the variables.
- [x] AC-3: `vitest.git-env.setup.mjs` is the first setup file of `vitest.shared.mjs` and deletes the same list in every worker; tests cover position, behaviour and list parity.
- [x] AC-4: The `emit-leaf — worktree layout end to end` fixture refuses a root outside the realpath of `tmpdir()` on both setup and teardown.
- [x] AC-5: The full pipeline-cli suite run with a leaked `GIT_DIR` at a fresh victim repository passes and leaves the victim untouched (before: victim deleted, 612 tests failing).
- [x] AC-6: Incident record, index row and recurring-mistakes ledger row under `docs/operations/incidents/`.

## Notes

Also regenerates the standing-rules blocks in `commands/executor.md` and `commands/operator-dispatch.md` (drifted when the decision catalog event log landed in #2190, red on `main` since ed50f6ba). Follow-up tasks are listed in the incident record.
