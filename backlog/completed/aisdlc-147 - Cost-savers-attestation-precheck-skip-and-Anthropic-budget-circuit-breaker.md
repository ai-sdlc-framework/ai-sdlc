---
id: AISDLC-147
title: >-
  Cost-savers — attestation precheck skip + Anthropic budget circuit breaker for
  CI reviewers
status: In Progress
assignee: []
created_date: '2026-05-02 23:00'
labels:
  - ci
  - cost-optimization
dependencies: []
references:
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/verify-attestation.yml
  - scripts/verify-attestation.mjs
  - pipeline-cli/src/classifier/classifier.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Two cost-saving patches to `.github/workflows/ai-sdlc-review.yml`** in response to a $0 Anthropic API credit balance. Reviewer agents started failing on every PR with HTTP 400 invalid_request_error ("credit balance is too low"). Both patches ship in the SAME PR.

### Patch 1 — Restore attestation-skip SOFT signal (cost-saver)

The DSSE attestation was demoted to audit-only as a MERGE GATE per AISDLC-140 sub-4. We are NOT undoing that. We ARE restoring the COST-SAVING side: when a valid `.ai-sdlc/attestations/<HEAD-sha>.dsse.json` exists at HEAD, skip the 3 CI reviewer agent invocations (since the operator already ran them locally via `/ai-sdlc execute` and signed the envelope).

Implementation:
- Add an `attestation-precheck` job BEFORE the `analyze` job that runs the same verifier `verify-attestation.yml` uses (`scripts/verify-attestation.mjs`) and outputs `skip: true|false`
- `analyze` job gains `if: needs.attestation-precheck.outputs.skip != 'true'`
- New `post-skip-results` job (when `skip == 'true'`) posts auto-approved verdicts via APPROVE PR review + posts `Post Review Results: success` status + posts idempotent PR comment marker `<!-- ai-sdlc:reviewer-skipped-by-attestation -->`
- `verify-attestation.yml`'s audit-only role is unchanged

### Patch 2 — Anthropic API budget circuit breaker

When ALL 3 reviewer agents fail with credit-exhaustion (substring match: `"credit balance is too low"` AND `"invalid_request_error"` both present in the failure message):
- Post idempotent PR comment `<!-- ai-sdlc:reviewer-skipped-by-budget -->` explaining the skip
- Post `Post Review Results: success` with description "skipped (budget exhausted)"
- DO NOT post a CHANGES_REQUESTED review (current behavior would post one because parsed verdicts are unparseable)
- Job exits 0

When only 1-2 fail with budget exhaustion (mixed), preserve current behavior — mixed could be transient.

Classifier lives in pipeline-cli (`src/classifier/budget-classifier.ts` exporting `classifyReviewerOutputs()`) so it has hermetic Vitest coverage.

## Acceptance criteria

### Patch 1
1. New job `attestation-precheck` outputs `skip: true|false`
2. `analyze` (and Slack notify) conditional on `skip != 'true'`
3. `post-skip-results` job posts auto-approved verdicts + Post Review Results status + idempotent PR comment
4. Respect AISDLC-141 classifier decision — when classifier would skip ALL three, attestation skip is moot (functionally equivalent outputs, no behavioral conflict)
5. `verify-attestation.yml` audit-only role unchanged

### Patch 2
1. New step in report job classifies all reviewer outputs into `{ok, budget-exhausted, other-failure}` via pipeline-cli `classifyReviewerOutputs()`
2. All-3-budget-exhausted → success status + idempotent comment, no CHANGES_REQUESTED
3. Mixed → current behavior preserved
4. Idempotent PR comment marker `<!-- ai-sdlc:reviewer-skipped-by-budget -->`
5. Hermetic Vitest test for the classifier in `pipeline-cli/src/classifier/budget-classifier.test.ts`

## Out of scope

- Refactoring the report job into a TS module (current github-script body stays inline)
- Adding budget-exhaustion telemetry / Slack alert (separate task if desired)
<!-- SECTION:DESCRIPTION:END -->
