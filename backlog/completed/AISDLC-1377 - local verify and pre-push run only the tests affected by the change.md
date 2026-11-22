---
id: AISDLC-1377
title: 'Local verify and pre-push run only the tests affected by the change'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - performance
  - pipeline-cli
  - verify
dependencies: []
references:
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/runtime/verify-slots.ts
  - scripts/pre-push-patch-coverage.mjs
  - scripts/run-gate-tests.mjs
  - package.json
  - pipeline-cli/package.json
  - .husky/pre-push
priority: high
---

## Description

**Gap.** On 2026-11-22 two executors verifying at once held the 12-core machine at load average 15 to 21: each ran the full pipeline-cli vitest suite (one under `--coverage`), with about 10 parallel `tsc` processes and the vitest worker pools, while dispatch's pacer reported `EXECUTOR CAP 0 (limited by load headroom)`. CI on GitHub runners runs the full suite before merge anyway, so the local full run duplicates it.

**Decision.** DEC-0423 (operator ruling 2026-11-22, option `affected-from-first-round`; extends DEC-0372).

**Facts read in code** (main at cd53eb237).

- `expandVerifyCommands` (`pipeline-cli/src/steps/verify-commands.ts:159`) on the first round runs `test:coverage` for touched packages and `pnpm -r --no-bail --filter '!./<touched>' test` for every other package, then the whole root gate chain `ROOT_TEST_CHAIN_REST` (`:147`).
- `affectedPackages` (`:191`) already narrows later rounds to packages changed since the last clean record plus dependents (`pnpm ls --filter ...[<sha>]`), failing closed on any doubt. It is used only when `narrowFrom` is set (round 2+).
- `pnpm test:gates` (`scripts/run-gate-tests.mjs`) runs all ~60 `node --test` gate scripts on every run; Node's runner has no dependency graph.
- `scripts/pre-push-patch-coverage.mjs` (AISDLC-1119) runs `test:coverage` for whole touched packages.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: local verify must catch what this change breaks before push; it does not need to re-prove untouched code, which CI's full suite does before merge (DEC-0423). 2. Deleted: the first-round plain run of untouched, non-dependent packages. 3. Simplified: one affected-set function used by every round and by pre-push, base `origin/main` (merge-base) on round 1. 4. Accelerated: vitest file-level narrowing inside affected packages. 5. Automated: tests for each narrowing and each forced-full trigger.

- Round 1 uses `affectedPackages` against the merge-base with `origin/main` instead of running every package; later rounds keep the DEC-0372 behaviour.
- Within an affected package, run only test files related to the changed files (`vitest run --changed <base>` or `vitest related <files>`). The patch-coverage run of a touched package may use the same narrowing as long as `check-pr-patch-coverage.mjs` still sees coverage for every changed line; if it cannot, keep that package's coverage run whole and say why in the PR.
- Gate tests: a path map (in `run-gate-tests.mjs` or beside it) from each gate script to the paths it guards; only gates whose paths changed run.
- Force the full run (fail closed) on: root `package.json`, any `package.json`, `pnpm-lock.yaml`, `tsconfig*`, `vitest.config*`, `vitest.git-env.setup.mjs`, `run-gate-tests.mjs` or the gate map itself, a changed path no package or gate claims, an unreadable record, or a git error.
- Treat a package's `bin/`, `dist/` and fixture directories as part of that package, so tests that spawn the CLI or read files by path are still selected.
- Build, lint, format and typecheck always run. CI keeps the full suite, the per-package coverage floors and the patch gate; no workflow change.
- Record `scope: affected` with the package and gate lists in the verify record (fields already exist, `verify-commands.ts:56-58`).
- Update CLAUDE.md "Testing and CI" and `docs/operations/quality-gate.md` to say local runs are affected-only per DEC-0423 and CI runs everything.

## Acceptance Criteria

- [x] #1 A test: a first-round change in one pipeline-cli source file runs vitest only for pipeline-cli and its dependents, not other packages.
- [x] #2 A test: inside the package, only related test files are passed to vitest.
- [x] #3 A test: a change under a gate's guarded path runs that gate and no unrelated gate.
- [x] #4 Tests: each forced-full trigger listed above produces the full command list.
- [x] #5 The pre-push patch-coverage copy narrows the same way and still fails on an uncovered changed line.
- [x] #6 CLAUDE.md and `docs/operations/quality-gate.md` state the DEC-0423 split; `scripts/check-claude-md-size.test.mjs` passes.
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Added --passWithNoTests to both related-coverage command builders (coverageCommand in verify-commands.ts and coverageArgs in pre-push-patch-coverage.mjs). Changed-file paths in coverageCommand are now single-quoted for sh -c. Tests assert the flag and the quoting.

## Changes
- pipeline-cli/src/steps/verify-commands.ts
- pipeline-cli/src/steps/verify-commands.test.ts
- scripts/pre-push-patch-coverage.mjs
- scripts/pre-push-patch-coverage.test.mjs

## Design decisions
Resumed round: commit only, not pushed, per instructions. The existing PR URL was not provided in the prompt.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

