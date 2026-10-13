---
id: AISDLC-824
title: >-
  CI review tier runs only for untrusted contributor PRs: trusted PRs never enter ai-sdlc-review.yml
status: Done
assignee: []
created_date: '2026-10-12'
labels:
  - ci
  - velocity
  - root-cause
dependencies: []
references:
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/untrusted-pr-gate.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (verified 2026-10-12, last 40 runs of `ai-sdlc-review.yml`).** The workflow fires on both `pull_request` and `pull_request_target` under one `cancel-in-progress` concurrency group, so the two runs race and one cancels the other (25 of 40 runs cancelled). The `attestation-precheck` job checks out `main` (no `ref:`) and fetches only `.ai-sdlc/attestations/<HEAD_SHA>.dsse.json`; the signer writes `<patch-id>.v6.dsse.json`, so under `pull_request_target` the precheck never finds the PR's envelope, reports `status=invalid`, and the `analyze` job runs the CI reviewers (`ANTHROPIC_API_KEY`) on a trusted, locally attested PR. Every reviewer run on an executor PR today was waste; the `ai-sdlc/pr-ready` rollup does not consume this workflow, so it blocks nothing for trusted PRs. With the API key removed the reviewer jobs still go green but post a REQUEST_CHANGES review. Dependabot PRs (#1441, #1443, #1445, #1446) are the untrusted case and currently fail in the same workflow.

**Operator statement (Dominique, 2026-10-12):** the workflow exists for unverified contributor PR reviews, not for regular reviews of trusted contributor PRs. Trusted PRs are reviewed locally by `/ai-sdlc execute` and attested; that is the control.

**Five-step review (requirements first).** Delete: the `pull_request` trigger and the attestation precheck of ai-sdlc-review.yml (step 2).
1. Requirement questioned: "CI reviewers run whenever the local attestation cannot be verified" (an accident of the precheck, never a stated requirement; the stated requirement, by the operator, is review of untrusted PRs only).
2. Delete: the `pull_request` trigger, the `attestation-precheck` job, and every branch in `ai-sdlc-review.yml` that exists to decide whether a trusted PR needs CI review. Trusted PRs never enter the workflow.
3. Simplify: one `pull_request_target` trigger and one job-level condition, the same trust predicate `untrusted-pr-gate.yml` already uses (head repo is a fork, or author is not a collaborator / is a bot other than release-please). Dependabot counts as untrusted and is reviewed here, nowhere else.
4. Accelerate: trusted PRs lose two workflow runs each; the concurrency race disappears.
5. Automate: nothing new.

**Velocity impact.** Positive: removes two runs per trusted PR, the cancel race, the stray REQUEST_CHANGES reviews, and unblocks the Dependabot PRs once they pass their own review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc-review.yml` has a single `pull_request_target` trigger; the `pull_request` trigger and the `attestation-precheck` job are deleted
- [x] #2 The `analyze` and `report` jobs run only when the trust predicate says untrusted (fork head repo, non-collaborator author, or a bot other than release-please); the predicate is shared with or identical to the one in `untrusted-pr-gate.yml`
- [x] #3 A trusted-author PR (collaborator, same repo) produces no `Analyze PR`, `Post Review Results` or `Attestation precheck` check at all
- [x] #4 A Dependabot PR runs the review and the reviewers run with the configured secret; when the secret is absent the job fails loudly (`::error::`) instead of posting a REQUEST_CHANGES review
- [x] #5 Workflow test in `.github/workflows/__tests__/` asserts the single trigger, the absence of the precheck job, and the trust condition on `analyze`
- [x] #6 CLAUDE.md "Review attestations" paragraph no longer describes `Post Review Results` as a fallback review tier for trusted PRs
- [x] #7 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` and `pnpm lint && pnpm format:check`
- After landing: one trusted PR and one Dependabot PR show the expected check sets
