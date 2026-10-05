---
id: AISDLC-722
title: >-
  Two reviewers by default for pull requests that touch no trust-chain path
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - review
  - cost
dependencies: []
references:
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - scripts/verify-attestation.mjs
  - docs/operations/reviewer-set-flag.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every code pull request runs three reviewer agents (code, test, security). Backlog task
617 added an opt-in two-reviewer set: a combined correctness reviewer plus the security
reviewer. Per DEC-0055 (operator-approved 2026-10-04) the two-reviewer set becomes the
default for pull requests that touch no trust-chain path, which removes one agent run
from most pull requests.

How the opt-in set is selected today: `resolveReviewerSetMode()` and
`resolveReviewerSet()` in `pipeline-cli/src/steps/reviewer-set.ts`, with the mode taken
from `AI_SDLC_REVIEWER_SET` or from `reviewerSet: code-test-merged` in
`.ai-sdlc/review-config.yaml` read from `origin/main` (never from the pull request's own
worktree). The `/ai-sdlc execute` skill body (`ai-sdlc-plugin/commands/execute.md`, Steps
7a-pre and 7a-post) mirrors it. The reconcile path takes an explicit override,
`RunReconcileOptions.reviewers` (`RECONCILE_REVIEWERS_MERGED`) in
`pipeline-cli/src/orchestrator/reconcile.ts`. No required-reviewer-set check was found
in `scripts/verify-attestation.mjs` or `pipeline-cli/src/attestation`; the implementer
locates where the verifier counts reviewer leaves and states what it found.

## Conventions
- Trust-sensitive: this changes a review requirement. Security review on the strongest
  reviewer model, and this task's own pull request gets the full three-reviewer set.
- The reviewer set is derived from the diff by a deterministic classifier and re-derived
  by the CI verifier from the same diff. It is never read from a field the signer writes.
- TypeScript strict, ESM, Vitest; `node --test` for scripts; 80% line coverage on new
  code. Tests use `mkdtemp`, never a shared `/tmp` path.

## Acceptance Criteria
- [ ] A single list defines trust-chain paths (at least: `ai-sdlc-plugin/hooks/**`, attestation and signing code under `pipeline-cli/src/attestation/**` and `scripts/verify-attestation.mjs`, `scripts/check-attestation-sign.sh`, merge and release path code, the governance resolver and `spec/schemas/agent-role.schema.json`, `.ai-sdlc/**` config files, `.github/workflows/**`, reviewer agent definitions). It lives in one module that the pipeline and the verifier both import; a test fails if they diverge.
- [ ] `/ai-sdlc execute`, the orchestrator tick reconcile path and the headless reviewer runner select the two-reviewer set when the diff touches none of those paths, and the three-reviewer set otherwise. The choice is logged with the paths that triggered the full set.
- [ ] The CI verifier re-derives the required reviewer set from the pull request diff and rejects an attestation whose leaves do not cover it. The set is never read from a field the signer wrote (a self-asserted claim is forgeable).
- [ ] A repository can require three reviewers always through config; the default with nothing configured is the new behaviour. Documented for adopters in `docs/operations/reviewer-set-flag.md`, with the changelog entry produced by the release tooling describing the changed default.
- [ ] The attestation records which set applied and the classifier's reason, so an auditor can see it.
- [ ] Comparison window before the default flips for this repository: for the first 20 pull requests, or one week, both sets' verdicts are compared on a sample (reuse the comparison machinery of the staged-review work if it is on main; otherwise a simple log of disagreements); the results are reported in the decision digest. The window does not block pull requests.
- [ ] Tests: an ordinary source diff selects two; a diff touching a hook selects three; the verifier rejects a two-leaf attestation on a trust-chain diff; opt-out config selects three.
- [ ] The pull request body carries a "Velocity impact" section with the measured agent runs and tokens saved per pull request.

## Out of scope
- Staged review (the staged review pipeline RFC); changing what each reviewer checks.

## Notes
This is itself a trust-chain change, so its own pull request gets the full three-reviewer
set with security on opus.
<!-- SECTION:DESCRIPTION:END -->
