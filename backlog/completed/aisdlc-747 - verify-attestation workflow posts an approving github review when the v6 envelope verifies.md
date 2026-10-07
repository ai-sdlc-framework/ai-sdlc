---
id: AISDLC-747
title: >-
  verify-attestation workflow posts an approving GitHub review when the v6 envelope verifies
status: Done
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
updated_date: '2026-10-07 02:43'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to DEC-0065 (operator, 2026-10-06): a verified AI attestation should register as a GitHub review, not only a commit status, so GitHub, Scorecard and adopters see "reviewed".

Step 1 (this task): the Verify attestation workflow, on a verified envelope, submits a pull-request review with event APPROVE from the Actions token. The body is the reviewer verdict summary plus a link to the envelope and the nonce-bound transcripts. It is idempotent per head SHA: do not re-approve the same SHA, and dismiss its own stale approval when the head changes. It requires the repo setting "Allow GitHub Actions to create and approve pull requests" (the operator flips it); the job must fail loudly naming that setting if the API returns 403. It must not approve when verification fails or when the PR is from a fork.

After merge, read the next Scorecard run and record in the PR whether the Code-Review score moved. Step 2 (a GitHub App identity for adopters) is a separate follow-up to be filed after measurement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] An approving review appears on a PR with a verified attestation.
- [x] No review is posted on verification failure or for a fork PR.
- [x] Reruns are idempotent per head SHA, and a stale own approval is dismissed when the head changes.
- [x] A 403 from the API produces a clear error naming the "Allow GitHub Actions to create and approve pull requests" setting.
- [ ] The Scorecard Code-Review observation after merge is recorded in the PR.

## Final Summary

## Summary
The Verify attestation workflow now has an `approve` job that submits an APPROVE pull-request review from the Actions token when the verifier reports `valid`. It runs only on `pull_request_target`, from a default-branch checkout with persist-credentials false. It skips fork PRs, soft-fail/spot-check results and failed verification. It is idempotent per head SHA, dismisses its own stale approvals (bot author plus body marker) and turns a 403 into an error naming "Allow GitHub Actions to create and approve pull requests".

## Changes
- `scripts/post-attestation-review.mjs` (new): review posting logic with injected API; idempotency, stale dismissal, 403 wrapping.
- `scripts/post-attestation-review.test.mjs` (new): hermetic tests.
- `.github/workflows/verify-attestation.yml` (modified): `approve` job (only job with `pull-requests: write`), verify job outputs, concurrency group keyed by event name.
- `.github/workflows/__tests__/verify-attestation.test.mjs` (modified): assertions for the job gating, checkout ref and bootstrap skip.
- `docs/operations/quality-gate.md` (modified): operator setting and 403 behaviour.
- `package.json` (modified): `test:post-attestation-review` wired into `test`.

## Design decisions
- **pull_request_target only**: on the transitional `pull_request` trigger the checkout is the PR merge ref, so a same-repo PR could forge a pass and an approval; both reviewers flagged it in round 1.
- **Own reviews recognised by bot author plus marker**, so human reviews are never dismissed and a forged marker is ignored.
- **Soft-fail/spot-check "valid" results are not approved** (Merkle proof skipped).

## Verification
- `pnpm build` — clean
- `node --test` script tests (12) and workflow tests (18 + 5) — pass; `check-dark-code` OK
- `pnpm lint` — clean; `pnpm format:check` — clean
- Round 2 reviews approved (security-reviewer, code-reviewer; codex hit its usage limit, so code review ran Claude-native)

## Follow-up
- declined: a verifier-emitted `schemaVersion` output so the job can require v6 (touches the blocked verifier driver; legacy-schema envelopes can currently be approved)
- declined: dismissing the bot's old approval when a later head fails verification (merge stays blocked by the failing status; the "Dismiss stale approvals" branch setting covers it, documented behaviour wording is slightly broad in quality-gate.md)
- declined: AC 5 (Scorecard Code-Review observation) can only be read after merge; it is recorded in the PR body as pending post-merge
