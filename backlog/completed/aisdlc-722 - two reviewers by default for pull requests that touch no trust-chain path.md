---
id: AISDLC-722
title: >-
  Two reviewers by default for pull requests that touch no trust-chain path
status: Done
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
- [x] A single list defines trust-chain paths (at least: `ai-sdlc-plugin/hooks/**`, attestation and signing code under `pipeline-cli/src/attestation/**` and `scripts/verify-attestation.mjs`, `scripts/check-attestation-sign.sh`, merge and release path code, the governance resolver and `spec/schemas/agent-role.schema.json`, `.ai-sdlc/**` config files, `.github/workflows/**`, reviewer agent definitions). It lives in one module that the pipeline and the verifier both import; a test fails if they diverge.
- [x] `/ai-sdlc execute`, the orchestrator tick reconcile path and the headless reviewer runner select the two-reviewer set when the diff touches none of those paths, and the three-reviewer set otherwise. The choice is logged with the paths that triggered the full set.
- [x] The CI verifier re-derives the required reviewer set from the pull request diff and rejects an attestation whose leaves do not cover it. The set is never read from a field the signer wrote (a self-asserted claim is forgeable).
- [x] A repository can require three reviewers always through config; the default with nothing configured is the new behaviour. Documented for adopters in `docs/operations/reviewer-set-flag.md`, with the changelog entry produced by the release tooling describing the changed default.
- [x] The attestation records which set applied and the classifier's reason, so an auditor can see it.
- [x] Comparison window before the default flips for this repository: for the first 20 pull requests, or one week, both sets' verdicts are compared on a sample (reuse the comparison machinery of the staged-review work if it is on main; otherwise a simple log of disagreements); the results are reported in the decision digest. The window does not block pull requests.
- [x] Tests: an ordinary source diff selects two; a diff touching a hook selects three; the verifier rejects a two-leaf attestation on a trust-chain diff; opt-out config selects three.
- [x] The pull request body carries a "Velocity impact" section with the measured agent runs and tokens saved per pull request.

## Out of scope
- Staged review (the staged review pipeline RFC); changing what each reviewer checks.

## Notes
This is itself a trust-chain change, so its own pull request gets the full three-reviewer
set with security on opus.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Two reviewers (correctness + security) are now the default when a diff touches no trust-chain path; three otherwise. After AISDLC-723 landed its own classifier, this task was rebased onto it and its duplicate module was deleted: ONE module (`pipeline-cli/attestation-core/review-scope-core.mjs`) now holds the trust-chain list and the classifier, with three reviewer kinds (`correctness-only` for test-only and docs-adjacent diffs from 723, `two`, `three`). The pipeline, signer and CI verifier all import it. The verifier (`enforceReviewScope`) re-derives the required kind from the PR diff (never from a signer-written field) and rejects attestations whose Merkle-proven leaves do not cover it. `reviewerSet: three` (read from the base commit) forces three always, including for test-only diffs.

## Changes
- `pipeline-cli/attestation-core/review-scope-core.mjs` (modified): the one trust-chain list now carries 722's extra surfaces (governance resolver, agent-role schema, merge and release code, reviewer selection code, push gates), runtime-artifact exemptions, `requiredReviewerKind`, `checkReviewerKindCoverage`, `parseReviewerSetConfig`; `DOCS_ONLY_PATTERN` re-synced with `scripts/is-docs-only-changeset.mjs` after AISDLC-534 drifted it.
- `pipeline-cli/attestation-core/reviewer-set-core.mjs` (deleted): 722's own list and classifier, replaced by the above.
- `pipeline-cli/attestation-core/verify-core.mjs`: `enforceReviewScope` requires the re-derived kind; the separate step 7d and `deriveReviewerSetRequirement` are gone.
- `pipeline-cli/src/attestation/review-scope.ts`, `sign-v6.ts`: one audit record (`reviewScope.requiredSet`, `reason`, `triggeringPaths`); 722's separate `reviewerSet` envelope field is gone.
- `pipeline-cli/src/steps/reviewer-set.ts`, `07-build-review-prompts.ts`, `reviewer-set-comparison.ts`, `orchestrator/reconcile.ts`, `cli/attestation.ts`: selection, logging, comparison window, `reviewer-set` and `reviewer-set-window` subcommands; the correctness-only reduction is skipped when the repository requires three.
- `docs/operations/reviewer-set-flag.md`, `ai-sdlc-plugin/commands/execute.md`: docs and skill wiring.

## Design decisions
- Legacy `reviewerSet: code-test-merged` now means the default; only `three` forces three.
- Unreadable or empty diff, quoted, control-character and `..` paths fail closed to three.
- `.ai-sdlc/_decisions/` stays docs-equivalent data (AISDLC-723 stance on main); 722's earlier "always three" treatment of decision records is dropped.
- The whole `ai-sdlc-plugin/` directory is trust-chain (AISDLC-723 stance), which is stricter than 722's earlier narrower list.

## Verification
- `pnpm build` - clean
- affected vitest suites + `scripts/verify-attestation.test.mjs` pass; dark-code check OK
- `pnpm lint` / `pnpm format:check` - clean
- 3 reviewers re-run on the reworked diff after the rebase onto AISDLC-723

## Follow-up
- declined: minor security suggestions (list `.claude/**` whole, `**/CLAUDE.md`, root package.json, non-ASCII paths suspect, reviewerSet trailing-comment parse) - tracked in the PR body for the planner to file
<!-- SECTION:FINAL_SUMMARY:END -->
