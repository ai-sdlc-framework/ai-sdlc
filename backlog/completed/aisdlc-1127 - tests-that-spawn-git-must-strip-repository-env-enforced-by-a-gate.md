---
id: AISDLC-1127
title: 'Tests that spawn git must strip the repository environment, enforced by a gate (incident 2026-10-30 follow-up)'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - testing
  - hooks
  - incident
  - gate
dependencies: []
references:
  - pipeline-cli/src/__test-helpers/git-env.ts
  - vitest.git-env.setup.mjs
  - scripts/check-dark-code.mjs
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: high
dispatchable: true
---

## Description

The 2026-10-30 incident record shows 81 of 87 pipeline-cli test files that shell out to git do not use `makeGitEnv()`, and the `node --test` suites under `scripts/` and `ai-sdlc-plugin/hooks/` sit outside the vitest setup layer entirely. Today only convention keeps a fixture's git calls away from an inherited `GIT_DIR`; the incident showed what one leak costs. The fix PR added defence in depth at the hook and the vitest worker; this task makes the test-side rule mechanical so a new test, a new runner or an IDE task cannot reintroduce the exposure.

**Five-step review.**
1. Requirement questioned: do tests need to spawn git at all? Many do (worktree, attestation, rebase paths); the requirement stands.
2. Delete: nothing.
3. Simplify: one static check over test files, same shape as the dark-code gate: a test file that calls `execFileSync`/`execSync`/`spawnSync` with `git` and passes no `env` built from `makeGitEnv()` (or runs under a runner that loads `vitest.git-env.setup.mjs`) fails the gate.
4. Accelerate: static scan, no test execution.
5. Automate: wire into `pnpm test` beside `dark-code:check`; a shrinking baseline for the current offenders, never growing.

Velocity impact: neutral per PR (static scan), positive overall.

## Acceptance Criteria

- [ ] AC-1: `scripts/check-git-env-hygiene.mjs` scans `**/*.test.{ts,mjs,js}` and reports every git spawn whose `env` is not derived from `makeGitEnv()` and whose file is not run under a vitest config that loads `vitest.git-env.setup.mjs`.
- [ ] AC-2: The `node --test` suites (`scripts/*.test.mjs`, `ai-sdlc-plugin/hooks/*.test.mjs`, `ai-sdlc-plugin/scripts/*.test.mjs`) get an equivalent preload (`--import`) that strips the same variable list, registered in their package scripts.
- [ ] AC-3: A `.ai-sdlc/git-env-hygiene-baseline.json` lists today's offenders; the check fails on any file not in the baseline, and the baseline only shrinks (same rule as the dark-code baseline).
- [ ] AC-4: Wired into root `pnpm test` and documented in `docs/operations/pre-push-and-ci-reference.md`.
- [ ] AC-5: Tests cover: detection of a bare `execFileSync('git', ...)`, acceptance of `makeGitEnv()` usage, acceptance under a config that loads the setup file, baseline-shrink enforcement.

## Notes

Origin: incident record 2026-10-30, follow-up list. The security reviewer of the fix PR asked for the `node --test` suites to be included.
