---
id: AISDLC-1187
title: 'Pre-push hook recomputes the patch gate from verify coverage on an exact tree match'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - hooks
  - verify
  - fix
dependencies:
  - AISDLC-1185
  - AISDLC-1186
references:
  - scripts/pre-push-patch-coverage.mjs
  - scripts/pre-push-patch-coverage.test.mjs
  - scripts/check-pr-patch-coverage.mjs
  - pipeline-cli/src/steps/verify-commands.ts
  - .ai-sdlc/gates.yaml
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Description

**Source.** DEC-0371, operator answer 2026-11-04 (`reuse-recompute`), amending DEC-0282. Lever 3 of the duplicate-test-run work.

**Today.** After AISDLC-1185, machine verify runs each touched package under `test:coverage` and the patch gate, and records `headSha`, `treeSha`, `clean` and `finishedAt` in `<project>/.ai-sdlc/artifacts/verify-runs/<task>.json`. The pre-push hook then runs the same suites and the same gate again on the same tree.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the hook exists to catch a coverage shortfall before CI (DEC-0282); when verify already produced coverage for this exact tree, rerunning the suites adds no information. 2. Deleted: the hook's `test:coverage` runs on an exact match. 3. Simplified: the gate itself still runs, on the coverage files verify left in the worktree, so no pass flag is trusted (DEC-0371 rejected `skip-on-record`). 4. Accelerated: one coverage run per push saved. 5. Automated: tests below.

**Match rule (all must hold, else the hook runs exactly as today).**
- A verify record exists whose `treeSha` equals `git rev-parse HEAD^{tree}`, with `ok: true` and `clean: true`.
- The record names the `origin/main` sha its patch gate ran against, and it equals the hook's current `origin/main`. AISDLC-1185 adds this field if it does not already record it; otherwise this task adds it.
- The worktree is clean now.
- Every touched package's `coverage/coverage-final.json` exists and has an mtime not older than the record's start and not newer than its `finishedAt`.

On a match the hook prints one line naming the record and runs `scripts/check-pr-patch-coverage.mjs` only. The gate's existing forgery check (tracked coverage files rejected) is unchanged. The skip variables keep their meaning.

**Hook-spawned processes (AISDLC-1129).** New `git` calls use `sessionScrubbedEnv()`; the PR body states it.

## Acceptance Criteria

- [ ] AC-1: On an exact match the hook runs no `test:coverage` and runs the patch gate once. A test with an injected runner asserts the call list.
- [ ] AC-2: Each failed condition of the match rule (tree, `ok`, `clean`, base sha, dirty worktree now, missing or out-of-window coverage file) makes the hook run as today. One test per condition.
- [ ] AC-3: A failing recomputed gate fails the push.
- [ ] AC-4: `.ai-sdlc/gates.yaml` keeps the pre-push entry and cites DEC-0371 next to DEC-0282; `docs/operations/quality-gate.md` describes the match rule.
- [ ] AC-5: The PR body reports push wall time on a one-package change with and without a matching record.
