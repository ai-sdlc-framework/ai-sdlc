---
id: AISDLC-147
title: >-
  Cost-savers — attestation precheck skip + Anthropic budget circuit breaker for
  CI reviewers
status: Done
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

> **AISDLC-157 update (2026-05-02):** the "all 3 budget-exhausted" gate above was broadened to "every NON-OK reviewer is budget-exhausted" (i.e. ≥1 budget-exhausted AND 0 other-failure). This was forced by the AISDLC-141 conditional classifier going LIVE in CI (AISDLC-156): when the classifier AUTO_APPROVES an unselected reviewer, that reviewer's stub verdict counts as `ok`, so a truly credit-exhausted run can have count<3 even when there's nothing real to surface. Mixed budget+other-failure still falls through to proceed-as-normal (the other-failure carries a real signal). See AISDLC-157 task file for the full truth table.

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
2. All-3-budget-exhausted → success status + idempotent comment, no CHANGES_REQUESTED *(broadened to "every non-OK reviewer is budget-exhausted" by AISDLC-157)*
3. Mixed → current behavior preserved *(AISDLC-157 refinement: "mixed budget+ok" now skips, "mixed budget+other-failure" still proceeds — see addendum above)*
4. Idempotent PR comment marker `<!-- ai-sdlc:reviewer-skipped-by-budget -->`
5. Hermetic Vitest test for the classifier in `pipeline-cli/src/classifier/budget-classifier.test.ts`

## Out of scope

- Refactoring the report job into a TS module (current github-script body stays inline)
- Adding budget-exhaustion telemetry / Slack alert (separate task if desired)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Shipped both AISDLC-147 cost-saver patches in a single PR. Patch 1 restores the attestation-skip soft signal (3 reviewer-agent invocations saved per push when a valid local DSSE envelope is present); patch 2 adds an Anthropic API budget circuit breaker so a $0 credit balance no longer posts CHANGES_REQUESTED noise on every PR. Both patches integrate cleanly with the AISDLC-141 conditional classifier and the AISDLC-142 incremental review (rebased onto origin/main with both features active).

## Changes
- `.github/workflows/ai-sdlc-review.yml` (modified): added `attestation-precheck` job + `post-skip-results` job (patch 1); added `Classify reviewer outputs` step in analyze + `Post budget-skip status + comment` step in report + Slack-notify gating (patch 2)
- `pipeline-cli/src/classifier/budget-classifier.ts` (new): pure-function classifier — per-reviewer rule + aggregate decision
- `pipeline-cli/src/cli/classify-budget.ts` + `bin/cli-classify-budget.mjs` (new): tiny CLI wrapper the workflow invokes via `pnpm exec`
- `.github/workflows/__tests__/ai-sdlc-review.test.mjs` (new): 16 workflow-structure tests (PyYAML-based, mirrors `ai-sdlc-gate.test.mjs` pattern)
- `pipeline-cli/src/{classifier/budget-classifier,cli/classify-budget}.test.ts` (new): 22 hermetic Vitest tests
- `pipeline-cli/src/{index,classifier/index}.ts` (modified): re-export new public surface
- `pipeline-cli/package.json` (modified): wire `cli-classify-budget` bin
- `package.json` (modified): wire `pnpm test:review-workflow` into the root test pipeline
- `ai-sdlc-plugin/mcp-server/dist/bin.js` (modified): build artifact — picks up the new pipeline-cli barrel exports during MCP bundle build
- `backlog/tasks/aisdlc-147-...md` → `backlog/completed/...` (this commit): task closure

## Design decisions
- **Budget-exhaustion AND-of-two-substrings match** (`"credit balance is too low"` AND `"invalid_request_error"` both required): defends against false positives — `invalid_request_error` alone fires on schema-rejection bugs that should still surface CHANGES_REQUESTED; `credit balance is too low` alone could in principle appear in PR commentary.
- **All-3-budget gate (not 2-of-3)**: mixed failures could be transient API issues affecting one reviewer's connection; the surviving reviewers' verdicts still warrant CHANGES_REQUESTED. Only a uniform credit-exhaustion is the unambiguous "API key is dead" signal. *(Superseded by AISDLC-157 once AISDLC-141's classifier started writing AUTO_APPROVED stubs — the old gate then misclassified valid skip cases as proceed-as-normal. New rule: "all NON-OK reviewers are budget-exhausted." See AISDLC-157.)*
- **Classifier in pipeline-cli (not inline github-script)**: pure functions get hermetic Vitest coverage (100% lines on budget-classifier.ts) and the workflow YAML stays a thin adapter.
- **`post-skip-results` job posts `Post Review Results` status via API even though the `report` job emits the job-level check**: defense-in-depth — if a future restructuring renames/removes the report job, the status check still lands and branch protection doesn't deadlock.

## Verification
- `pnpm build` — clean (all 10 workspace packages)
- `pnpm test` — all suites green (840 pipeline-cli tests + 16 new workflow tests + the rest of the repo)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 100% line + 95.45% branch coverage on `budget-classifier.ts` (above 80% threshold)

## Follow-up
- (none) — the patches are self-contained. If reviewer cost re-spikes, candidates are: (a) widen the budget-exhaustion regex to additional Anthropic error variants, (b) add a per-PR cost-tracking signal to the PR body alongside the AISDLC-141 classifier decision.
<!-- SECTION:FINAL_SUMMARY:END -->
