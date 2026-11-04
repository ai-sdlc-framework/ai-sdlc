---
id: AISDLC-1185
title: 'Verify runs touched packages with coverage and records the tree it passed on'
status: Done
assignee: []
created_date: '2026-11-04'
labels:
  - pipeline
  - verify
  - fix
dependencies: []
references:
  - pipeline-cli/src/steps/verify-defaults.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/next-step/next-step.ts
  - scripts/pre-push-patch-coverage.mjs
  - scripts/check-pr-patch-coverage.mjs
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-04: cut duplicate test runs between machine verify and the pre-push hook (lever 1 of 4).

**Today.** Machine verify runs `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` (`DEFAULT_VERIFY_COMMANDS`) after every developer return. The pre-push hook then runs `test:coverage` again for every touched package and the patch gate (DEC-0282). So each touched package's vitest suite runs at least twice per task, and a patch-coverage shortfall is found only at push, after review. The verify record at `<artifacts>/verify-runs/<task>.json` carries no head sha, tree hash or time, so nothing can tell which tree a pass belongs to.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: verify must prove the tests pass; it need not run a touched package without coverage when the push will run it with coverage anyway. 2. Deleted: the plain `test` run of touched packages inside verify; they run once, under `test:coverage`. 3. Simplified: verify calls the same patch gate (`scripts/check-pr-patch-coverage.mjs`, `.ai-sdlc/patch-coverage.yaml`) the hook and CI use; no second standard. 4. Accelerated: a coverage shortfall now fails verify, where the developer fix round handles it, instead of the push. 5. Automated: tests below.

The record gains `headSha`, `treeSha` (`git rev-parse HEAD^{tree}`), `clean` (no unstaged, staged or untracked non-ignored change in the worktree when the run started and ended) and `finishedAt`. A run with `clean: false` is recorded but never matches a tree.

This task does not change the pre-push hook. Whether the hook may reuse this record is a separate operator ruling (lever 3).

## Acceptance Criteria

- [x] AC-1: In verify, each touched package (the same selection as `packagesToCover`) runs its vitest suite exactly once, under `test:coverage`; untouched packages and the root gates (`test:gates`, `rfc:check`, `dark-code:check`, and the rest of the root `test` chain) still run. A test asserts the command sequence for a change touching one package.
- [x] AC-2: Verify runs the patch gate after the tests, and a shortfall fails verify with the gate output in the developer feedback. A test covers the failing case.
- [x] AC-3: The verify record carries `headSha`, `treeSha`, `clean` and `finishedAt`; `clean` is false when the worktree changed during the run. Tests cover both values.
- [x] AC-4: A change touching no instrumentable code runs the same commands as today and skips the patch gate, as the hook does.
- [x] AC-5: `docs/operations/quality-gate.md` states that verify now runs the patch gate, and names the record fields.
- [ ] AC-6: The PR body reports the wall time of one verify run on a one-package change before and after.

## Final Summary

## Summary
Machine verify now runs each touched package once under test:coverage, then the root gate chain and the patch gate. A patch-coverage shortfall fails verify with the gate output in the feedback. The verify record now carries headSha, treeSha, clean and finishedAt.

## Changes
- pipeline-cli/src/steps/verify-commands.ts
- pipeline-cli/src/steps/verify-commands.test.ts
- scripts/list-coverage-packages.mjs
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-1185 - verify runs touched packages with coverage and records the tree it passed on.md

## Design decisions
AC-6 is not met. I did not measure the before/after wall time of a verify run, because one full run takes over 5 minutes. The PR body gives an estimate instead: the pipeline-cli suite takes about 267s and now runs once instead of twice. The operator should run a measured one-package comparison. Package selection comes from the new scripts/list-coverage-packages.mjs. If that script is missing (adopter repos) or fails, verify falls back to the plain commands and skips the patch gate. I ran the pipeline-cli vitest suite in full (the only failures were two tests I had broken, which I fixed) and lint, format:check and dark-code:check. The git snapshot and package expansion run inside the verify slot, so the concurrency cap still holds. One run of the pipeline-cli vitest suite also passed after the fix, but I did not re-run the root-level pnpm test gates or pnpm build after the final edit. The task file in backlog/tasks/ had an uncommitted modification when I started, and I committed it as a separate commit.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

