---
id: AISDLC-747
title: >-
  verify-attestation workflow posts an approving GitHub review when the v6 envelope verifies
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - governance
  - ci
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - ai-sdlc-plugin/scripts/verify-attestation.mjs
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to DEC-0065 (operator, 2026-10-06): a verified AI attestation should register as a GitHub review, not only a commit status, so GitHub, Scorecard and adopters see "reviewed".

Step 1 (this task): the Verify attestation workflow, on a verified envelope, submits a pull-request review with event APPROVE from the Actions token. The body is the reviewer verdict summary plus a link to the envelope and the nonce-bound transcripts. It is idempotent per head SHA: do not re-approve the same SHA, and dismiss its own stale approval when the head changes. It requires the repo setting "Allow GitHub Actions to create and approve pull requests" (the operator flips it); the job must fail loudly naming that setting if the API returns 403. It must not approve when verification fails or when the PR is from a fork.

After merge, read the next Scorecard run and record in the PR whether the Code-Review score moved. Step 2 (a GitHub App identity for adopters) is a separate follow-up to be filed after measurement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] An approving review appears on a PR with a verified attestation.
- [ ] No review is posted on verification failure or for a fork PR.
- [ ] Reruns are idempotent per head SHA, and a stale own approval is dismissed when the head changes.
- [ ] A 403 from the API produces a clear error naming the "Allow GitHub Actions to create and approve pull requests" setting.
- [ ] The Scorecard Code-Review observation after merge is recorded in the PR.
