---
id: AISDLC-686
title: >-
  Patch coverage gate: diff from the merge-base, not the base tip (behind-main PRs fail on files they do not touch)
status: To Do
assignee:
  - dispatch-executor-delta
created_date: '2026-10-03'
labels:
  - ci
  - coverage
dependencies: []
references:
  - scripts/check-pr-patch-coverage.mjs
  - scripts/check-pr-patch-coverage.test.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`scripts/check-pr-patch-coverage.mjs` computes the patch with a two-dot diff
`git diff <base>..<head>`, where CI passes `base` = `github.event.pull_request.base.sha`
(the base branch TIP) and `head` = the PR head. When the PR branch is behind the base
branch, every file that landed on the base after the PR forked appears as "changed by the
PR" (in reverse). Those files have no coverage data, because `scripts/pr-coverage.sh`
runs on the merge ref against `HEAD^1` and instruments only the PR's own files, so the
gate fails with "N changed file(s) have NO coverage data" for files the PR never touched.

Incident: CI run 37137246710 on PR #1165. The log shows the Coverage job
checked out `refs/remotes/pull/1165/merge`, `pr-coverage.sh` reported
"changed-only run vs d608f94c... OK (2 source file(s))", and the patch gate then listed
five files from commits that landed on main after the branch forked
(`routing/artifacts-dir.ts`, `routing/resolve-model.ts`, `usage/replay-commands.ts`,
`usage/replay-corpus.ts`, `usage/scorecard-commands.ts`) as MISSING, with the PR's own
files at 100% (137/156 lines, 87.8%). AISDLC-662.1 fixed the coverage RUN's base but left
the gate's diff range as the base tip.
<!-- SECTION:DESCRIPTION:END -->

## Conventions
- Node built-in `node --test` for scripts; Prettier, ESM.
- `.github/workflows/**` is out of scope: fix the script, not the workflow arguments.

## Scope
1. At both diff sites in `scripts/check-pr-patch-coverage.mjs` (`listChangedFiles` and
   `changedLinesForFile`), diff from `git merge-base <base> <head>` to `<head>` instead of
   the two-dot `<base>..<head>`.
2. When no merge-base can be resolved (unrelated or shallow history), fall back to the
   given base so behaviour is no worse than today.
3. Add regression tests to `scripts/check-pr-patch-coverage.test.mjs`.

## Acceptance Criteria
- [ ] A regression test where the base tip is ahead of the PR's merge-base, on files the PR doesn't touch, passes with those files excluded.
- [ ] A PR that genuinely lacks coverage on its own changed file still fails.
- [ ] `pnpm test:patch-coverage-gate` and `pnpm test:pr-coverage-gate` pass.
