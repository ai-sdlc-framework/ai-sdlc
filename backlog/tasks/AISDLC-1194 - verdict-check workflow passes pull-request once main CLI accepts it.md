---
id: AISDLC-1194
title: 'Verdict-check workflow drops the --pull-request feature probe and always passes it (RFC-0061 follow-up to AISDLC-1172)'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0061
  - attestation
  - ci
  - fix
dependencies:
  - AISDLC-1170
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

**Source.** Operator in the planner session, 2026-11-06: land the AISDLC-1172 cutover (#2399), then follow up on the `--pull-request` flag.

**Why a probe exists.** The `verdict-check` job in `ai-sdlc-gate.yml` checks out `github.event.pull_request.base.sha` and runs main's `cli-attestation`, so a PR cannot change the CLI that judges it. #2399 added the `--pull-request` option and first passed it unconditionally; main's CLI rejected it (`Unknown arguments: pull-request, pullRequest`). The repair commit d3473ff2 made the step probe `verdict-check --help` and pass the flag only when the base CLI lists it.

**Why remove it.** With AISDLC-1172 on main the probe always succeeds and is dead code. It also fails open: if the help text ever stops printing `--pull-request`, carry-forward silently stops filtering earlier verdicts by pull request (`listEarlierSubjects` in `verdict-check.ts`) and the job still passes.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: carry-forward reuses a verdict only from the same PR (RFC-0061 carry-forward, AISDLC-1170); that must not depend on help text. 2. Deleted: the help-text probe and the `PR_ARGS` array. 3. Simplified: one unconditional argument. 4. Accelerated: none. 5. Automated: a workflow test pins it.

1. Confirm `cli-attestation verdict-check --help` on origin/main lists `--pull-request`. If it does not, stop and report.
2. In the `verdict-check` step of `ai-sdlc-gate.yml`, delete the probe and pass `--pull-request "$PR_NUMBER"` unconditionally.
3. Keep one comment above the step: any new verdict-check argument must exist in main's CLI before the workflow passes it, because the job runs the base checkout.
4. Add an assertion in `ai-sdlc-gate.test.mjs` that the step passes `--pull-request` and contains no `--help` probe.

## Acceptance Criteria

- [ ] AC-1: The `verdict-check` step passes `--pull-request "$PR_NUMBER"` with no conditional, and the job is green on this task's own PR.
- [ ] AC-2: A workflow test fails if the argument is removed or made conditional again.
- [ ] AC-3: The step carries the base-checkout comment from Fix step 3.
- [ ] AC-4: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass.
