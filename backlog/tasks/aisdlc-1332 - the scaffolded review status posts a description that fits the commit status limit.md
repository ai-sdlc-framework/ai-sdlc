---
id: AISDLC-1332
title: 'The scaffolded review status posts a description that fits the commit status limit'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - init
  - adopter
dependencies: []
references:
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/init-features.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one string in one template and one test over the scaffolded workflow text.'
---

## Description

**Gap.** `ai-sdlc init` scaffolds `.github/workflows/ai-sdlc-review.yml` with a `Post Review Results` job. When the repository variable `AISDLC_REVIEW_STUB_AUTOPASS` is not `true`, the job tries to post a failure status whose description is 146 characters long. GitHub allows 140. The status API answers 422 "Description is too long", the script stops under `set -e`, and no status is posted at all. The job fails with an API error instead of the message it was written to show.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): every pull request showed a failed "Post Review Results" check, and the job log held the 422 error, not the "stub not wired" message.

**Cause (read from the source).**

- `orchestrator/src/cli/commands/init-templates.ts:735`: `DESC='Review stub not wired. Either replace this workflow step with your reviewers OR set repo var AISDLC_REVIEW_STUB_AUTOPASS=true (acknowledged risk).'` is 146 characters.
- `init-templates.ts:729` sets `set -euo pipefail`, so the rejected `gh api` call at lines 737-741 ends the step before the `echo` at line 742.
- The other two descriptions in the template (`init-templates.ts:695` and `:732`) are under 140 characters.
- `orchestrator/src/cli/commands/init-features.test.ts:631` only checks that the review workflow contains the text `Post Review Results`. Nothing checks a description length.

**Shape.** Every status description written by a scaffolded workflow is at most 140 characters, so the stub posts its status and shows its message. A test over the scaffolded workflow text fails when any description literal is longer than 140.

**Control.** No control changes. The stub keeps its current default, its state and its meaning; only the failure description is shortened so that the status is posted.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the status must be postable; a message that GitHub rejects tells the reader nothing. 2. Deleted: the words that push the text over the limit. 3. Simplified or optimised: one sentence that keeps the two ways out (wire reviewers, or set the variable). 4. Accelerated: the reader sees the reason in the status row, not an API error in the job log. 5. Automated: a test measures every description literal in the scaffolded workflows, so a longer one cannot return.

- **Description.** Replace the failure description at `init-templates.ts:735` with a text of at most 140 characters that still names `AISDLC_REVIEW_STUB_AUTOPASS=true` and says the stub is not wired.
- **Test.** In `init-features.test.ts`, read each scaffolded workflow, collect every `description=` or `DESC=` string literal, and assert each is at most 140 characters.

Out of scope: whether the stub should exist, pass on a valid review record, or be left out of projects that review locally (a design question for the operator); the `verify-attestation.yml` template and its skipped `approve` job; an init or doctor line that says which review path is installed.

## Acceptance Criteria

- [ ] #1 A test collects every `description=` and `DESC=` string literal from the files in `WORKFLOWS_TEMPLATES` and fails when one is longer than 140 characters.
- [ ] #2 The test fails on the template as it stands on `main` (the 146 character description) and passes after the change.
- [ ] #3 The failure description still contains `AISDLC_REVIEW_STUB_AUTOPASS=true` and `not wired`.
- [ ] #4 The stub's state, context name and default behaviour are unchanged: a test asserts `STATE=failure` is still the default branch and `STATE=success` the autopass branch.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
