---
id: AISDLC-1266
title: 'Untrusted PR gate: no model spend without a maintainer action, and a hard cap on what one run can spend'
status: To Do
assignee: []
created_date: '2026-11-13'
labels:
  - ci
  - ucvg
  - cost
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
  - pipeline-cli/src/pipeline/reviewer-runner.ts
  - pipeline-cli/src/pipeline/reviewer-runner.test.ts
  - pipeline-cli/src/cli/ucvg.ts
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (finding D2) plus the operator ruling of 2026-11-13: the gate bills the API key against a 100 USD monthly credit, sparingly, and only for PRs from people outside the project. Workflow and runner changes with tests; no open design question.'
---

## Description

**Operator ruling (2026-11-13).** The gate bills `ANTHROPIC_API_KEY` against a monthly API credit of 100 USD. That credit must be used sparingly and only on PRs from people outside the project. The operator's own PRs and the subscription-billed workflows must never reach it.

**Gap.** `.github/workflows/untrusted-pr-gate.yml` as written can spend without limit once the flag is on:

- The trigger list includes `edited`, so changing a PR title or body reruns the full three-reviewer review.
- A `synchronize` event reruns it on every push from the fork.
- No job sets `timeout-minutes`.
- The diff sent to the reviewers has no size cap.
- The reviewer model comes from the `AI_SDLC_REVIEWER_MODEL` environment variable with a default, and `max_tokens` takes the caller's value (`pipeline-cli/src/pipeline/reviewer-runner.ts`).
- The job that holds the secret starts on the event alone; no maintainer action stands between an outsider's push and the spend.

**Shape.**

1. Remove `edited` from the trigger types.
2. Put a maintainer action in front of `sandbox-and-review`, the only job that reads the secret: the job runs only when a maintainer has applied a label (proposed name `ucvg:review`) to the PR. Stage 1 (trust classification and the path gate, no model call) keeps running on every fork PR event. A new push removes the label, so each reviewed head costs one deliberate maintainer action.
3. Set `timeout-minutes` on every job.
4. Refuse a diff over a byte cap before any model call, with a status that says so. Put the cap in `.ai-sdlc/untrusted-pr-gate.yaml` with a built-in default.
5. Pin the reviewer model in code for the gate path and clamp `max_tokens` to a fixed ceiling.
6. Write the token counts of each run to the job summary so the operator can see what a review cost.

The provider-side spend limit on the key is an operator setting and is not part of this task.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0043 asks for an automatic review of every untrusted PR; the operator ruling of 2026-11-13 narrows that to a review a maintainer asks for, because the credit is small. 2. Deleted: the `edited` trigger and the automatic start of the model stage. 3. Simplified or optimised: one label check in the job condition; no budget ledger. 4. Accelerated: n/a. 5. Automated: workflow tests for the trigger list, the label condition and the timeouts.

## Acceptance Criteria

- [ ] #1 The `pull_request_target` trigger types of `untrusted-pr-gate.yml` do not include `edited`.
- [ ] #2 `sandbox-and-review` and `clean-room-sign` do not start on a fork PR that lacks the maintainer label; Stage 1 still runs and reports. A workflow test asserts the condition.
- [ ] #3 The label is removed when the PR head changes, and only a user with write access can make the model stage run; a label applied by the PR author has no effect. The task documents how this is enforced.
- [ ] #4 Every job in `untrusted-pr-gate.yml` sets `timeout-minutes`; a workflow test asserts it.
- [ ] #5 A diff larger than the configured byte cap ends the run before any model call with a failing status that names the cap. Unit test in `reviewer-runner.test.ts` or the caller's test file.
- [ ] #6 On the gate path the reviewer model is fixed in code and `max_tokens` cannot exceed a fixed ceiling, whatever the environment or the request says.
- [ ] #7 The job summary of a review run lists input and output tokens per reviewer.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
