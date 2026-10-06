---
id: AISDLC-720.1
title: >-
  CI trust marker: workflow half of AISDLC-720
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - governance
dependencies:
  - AISDLC-721
references:
  - .github/workflows/ai-sdlc.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/untrusted-pr-gate.yml
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - .github/workflows/__tests__/fork-pr-safety.test.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Why this is its own task: the executor's stale-dispatch check stops on any task whose id already has a merged implementation commit, so AISDLC-720 (whose hook and resolver half merged in PR #1211) cannot be re-dispatched for its second half. This task carries the remaining half under a fresh id. Rule going forward: a task that will ship in halves is split when filed.

The hook and resolver half shipped in PR #1211 and plugin 0.23.0 (fail-closed: a run is untrusted when `AI_SDLC_UNTRUSTED_RUN` is truthy, or when `GITHUB_ACTIONS` is truthy and `AI_SDLC_INTERNAL_RUN` is not truthy). Do NOT redo it. Only the workflow half remains.

Workflows involved: `.github/workflows/ai-sdlc-review.yml` and `.github/workflows/untrusted-pr-gate.yml` (external pull request review), and `.github/workflows/ai-sdlc.yml` (the issue-triggered run, `on: issues: types: [labeled]`).

- Set `AI_SDLC_INTERNAL_RUN` only in step-level `env:` on steps of trusted jobs, never via `$GITHUB_ENV` or job-level or workflow-level `env:`, because a later step could inherit it (Opus security finding on #1211).
- Set `AI_SDLC_UNTRUSTED_RUN` explicitly on every job that takes outside input (external PR review, issue-triggered runs).
- Add a test or lint that fails if `AI_SDLC_INTERNAL_RUN` appears at job or workflow level or in a `$GITHUB_ENV` write.

Sequencing: AISDLC-721 (which removes `.github/workflows/**` from `blockedPaths`) merges first, and the workflow edit follows.

## Conventions
- Trust-chain change: the security review runs on opus, and the PR stays a draft until CodeQL is clean.
- The security reviewer confirms that the untrusted signal cannot be cleared from inside an untrusted run and that no later step can inherit `AI_SDLC_INTERNAL_RUN`.

## Acceptance Criteria
- [ ] In `.github/workflows`, `AI_SDLC_INTERNAL_RUN` is set only in step-level `env:` on steps of trusted jobs, never through `$GITHUB_ENV` or job-level or workflow-level `env:`.
- [ ] `AI_SDLC_UNTRUSTED_RUN` is set explicitly on every job that takes outside input (external PR review, issue-triggered runs).
- [ ] A test or lint under `.github/workflows/__tests__/` fails if `AI_SDLC_INTERNAL_RUN` appears at job or workflow level or in a `$GITHUB_ENV` write; the failure message names the step-level form as the fix.
- [ ] PR body carries a "Velocity impact" section (DEC-0048): zero new prompts on the happy path (trusted internal runs behave as today), and the refusal an untrusted run sees names the step-level form of the marker.
<!-- SECTION:DESCRIPTION:END -->
