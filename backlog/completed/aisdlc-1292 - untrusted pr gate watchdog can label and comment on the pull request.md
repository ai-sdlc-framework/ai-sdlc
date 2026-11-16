---
id: AISDLC-1292
title: 'Untrusted PR gate watchdog can label and comment on the pull request when a later stage fails'
status: Done
assignee: []
created_date: '2026-11-16'
labels:
  - ci
  - untrusted-pr-gate
  - bug
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
priority: high
dispatchable: true
dispatchableReason: 'Observed on the first end-to-end gate run (fork PR #2634, run 43939762163, 2026-11-16): the watchdog job posted the failure status, then `POST /issues/2634/labels` and `POST /issues/2634/comments` both returned 403 "Resource not accessible by integration". The contributor has a red check with no label and no explanation. The operator approved filing this fix on 2026-11-16.'
---

## Description

**Gap.** When stage 2, 3 or 4 fails, the job `gate-failure-watchdog` in `.github/workflows/untrusted-pr-gate.yml` is meant to post a failure status, add the label `needs-maintainer-review` and post one comment. Only the status arrives.

- The job's token has `statuses: write` and `issues: write`.
- The target is a pull request. GitHub requires `pull-requests: write` to add a label or a comment to a pull request through the issues endpoints; `issues: write` covers issues only.
- The job `classify-and-gate` in the same workflow performs the same two calls for a stage 1 block and holds `pull-requests: write` and `issues: write`; its label and comment arrived on fork PR #2683.
- The watchdog catches both errors and logs a warning, so the job is green and nothing reports the missing comment.

**Shape.** The watchdog job holds the permission its two calls need, the same one the stage 1 job already holds for the same calls.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the contributor need the label and comment when the status is already red? Yes: the status says only that the gate failed; the comment says a maintainer will look, and the label is how the maintainer finds the PR. 2. Deleted: nothing. 3. Simplified or optimised: one permission line; no new step. 4. Accelerated: not applicable. 5. Automated: a workflow test on the job's permissions.

- **Permission.** Add `pull-requests: write` to the `permissions` block of `gate-failure-watchdog`. Keep `statuses: write` and `issues: write`. The job checks out nothing from the PR and runs only inline script from `main`; state this in the PR body.
- **Test.** `.github/workflows/__tests__/untrusted-pr-gate.test.mjs` asserts that every job of the workflow that calls `github.rest.issues.addLabels` or `github.rest.issues.createComment` holds `pull-requests: write`.

Out of scope: the comment text; the conditions under which the watchdog runs; the permissions of every other job.

## Acceptance Criteria

- [ ] #1 The `permissions` block of `gate-failure-watchdog` contains `pull-requests: write`, `issues: write` and `statuses: write`, and nothing else.
- [ ] #2 A test fails when a job of `.github/workflows/untrusted-pr-gate.yml` calls `github.rest.issues.addLabels` or `github.rest.issues.createComment` without `pull-requests: write`.
- [ ] #3 The diff changes no trigger, `if:` condition, secret or environment, and no permission of any other job; the PR body states this and names the one permission added.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
