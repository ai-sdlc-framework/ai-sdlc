---
id: AISDLC-1194
title: 'Verdict-check workflow passes --pull-request once the main CLI accepts it (RFC-0061 follow-up to AISDLC-1172)'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0061
  - attestation
  - ci
  - fix
dependencies:
  - AISDLC-1172
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - pipeline-cli/src/attestation/verdict-check.ts
  - pipeline-cli/src/attestation/verdict-cli.ts
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-06: land the AISDLC-1172 cutover (#2399) without the `--pull-request` flag in the workflow, then re-add it in a follow-up.

**Why it was dropped.** The `verdict-check` job in `ai-sdlc-gate.yml` checks out `github.event.pull_request.base.sha` and runs main's `cli-attestation`, so a PR cannot change the CLI that judges it. #2399 added the `--pull-request` option to `verdict-check` and passed it from the workflow in the same PR. Main's CLI rejected it (`Unknown arguments: pull-request, pullRequest`) and the job could never pass. The flag was removed from the workflow; the CLI option stayed in source.

**Effect while it is missing.** Without `--pull-request`, carry-forward (`listEarlierSubjects` in `verdict-check.ts`) does not filter earlier verdict records by pull request. A record for an identical tree from another PR can be carried forward. This is no looser than main before the cutover.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: carry-forward should only reuse a verdict from the same PR (RFC-0061 carry-forward design, AISDLC-1170). 2. Deleted: nothing. 3. Simplified: one workflow line, no CLI change. 4. Accelerated: none. 5. Automated: a workflow test pins the argument.

1. Confirm `cli-attestation verdict-check --help` on origin/main lists `--pull-request` (it does once AISDLC-1172 lands). If it does not, stop and report.
2. In the `verdict-check` job step of `ai-sdlc-gate.yml`, pass `--pull-request "$PR_NUMBER"` with `PR_NUMBER: ${{ github.event.pull_request.number }}` in the step env.
3. Add an assertion in `ai-sdlc-gate.test.mjs` that the step passes `--pull-request`.
4. Add a comment above the step: any new verdict-check argument must exist in main's CLI before the workflow passes it, because the job runs the base checkout.

## Acceptance Criteria

- [ ] AC-1: The `verdict-check` job passes `--pull-request` with the PR number, and the job is green on this task's own PR.
- [ ] AC-2: A workflow test fails if the argument is removed.
- [ ] AC-3: The step carries the base-checkout comment from Fix step 4.
- [ ] AC-4: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass.
