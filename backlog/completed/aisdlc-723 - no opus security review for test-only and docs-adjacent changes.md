---
id: AISDLC-723
title: >-
  No opus security review for test-only and docs-adjacent changes
status: Done
assignee: []
created_date: '2026-10-04'
labels:
  - review
  - cost
dependencies: []
references:
  - pipeline-cli/src/steps/reviewer-set.ts
  - scripts/is-docs-only-changeset.mjs
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - docs/operations/reviewer-set-flag.md
priority: high
dispatchable: true
updated_date: '2026-10-10 21:03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every code pull request gets a security review on opus, including changes that only
touch tests or documentation that sits next to code. Per DEC-0055 (operator-approved
2026-10-04) those changes run the correctness reviewer only.

This builds on the reviewer-set classifier and the shared trust-chain path list from
backlog task 722 (two reviewers by default) and should land with or after it. Reviewer
selection today lives in `pipeline-cli/src/steps/reviewer-set.ts`; the docs-only
classifier is `scripts/is-docs-only-changeset.mjs`. No required-reviewer-set check was
found in `scripts/verify-attestation.mjs`; the implementer locates where the verifier
counts reviewer leaves and states what it found.

## Conventions
- Trust-sensitive: this loosens a review requirement. Security review on the strongest
  reviewer model; the pull request gets the full three-reviewer set.
- The classification is derived from the diff and re-derived by the CI verifier. It is
  never read from a field the signer writes.
- TypeScript strict, ESM, Vitest; `node --test` for scripts; 80% line coverage on new
  code. Tests use `mkdtemp`, never a shared `/tmp` path.

## Acceptance Criteria
- [x] The classifier marks a diff "test-only" when every changed path is a test file, fixture or snapshot (patterns: `*.test.*`, `*.spec.*`, `__tests__/**`, `**/fixtures/**`, `**/__snapshots__/**`), and "docs-adjacent" when every changed path is Markdown or a file already covered by the docs-only classifier in `scripts/is-docs-only-changeset.mjs`. The classification is path-based only: a comment-only change is not inferred. Mixed diffs are not downgraded.
- [x] For such diffs the required reviewer set is the correctness reviewer alone; the security reviewer is not spawned. Any trust-chain path in the diff (same list as the two-reviewer task), any workflow file, any test under `ai-sdlc-plugin/hooks/**` or for attestation and signing code, or any file that changes a security test's expectations forces the full set.
- [x] The CI verifier re-derives the classification from the diff; the signer cannot assert it.
- [x] Config lets a repository keep the security review on everything; documented for adopters in `docs/operations/reviewer-set-flag.md`.
- [x] The attestation records the classification and the reviewer set that applied.
- [x] Tests: a test-only diff selects correctness only; a test file under hooks selects the full set; a mixed source and test diff is not downgraded; the verifier rejects a correctness-only attestation on a source diff.
- [x] The pull request body carries a "Velocity impact" section with the measured share of recent pull requests that qualify and the opus runs saved.

## Out of scope
- Skipping review entirely for any code path; changing docs-only handling, which already skips the pipeline.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Diffs whose changed paths are all tests/fixtures/snapshots (test-only) or all Markdown/docs-only (docs-adjacent) now require only the correctness reviewer; the security reviewer is not required. A shared path-based classifier (`pipeline-cli/attestation-core/review-scope-core.mjs`) is used by the signer-side selection and re-derived by the CI verifier (`verify-core.mjs` `enforceReviewScope`) from the git diff; the envelope's `reviewScope` field is informational and never trusted. Trust-chain paths, workflows, hooks, agent-instruction files (.claude/, CLAUDE.md, AGENTS.md, SKILL.md), attestation/signing tests and security-named tests force the full set; `securityReview: always` in `.ai-sdlc/review-config.yaml` (read from the base ref) keeps security review on everything.

## Changes
- `pipeline-cli/attestation-core/review-scope-core.mjs` (+ `.d.mts`) (new): shared classifier + trust-chain path list (lockstep surface with AISDLC-722).
- `pipeline-cli/attestation-core/verify-core.mjs` (modified): re-derives classification; reviewer names now bound to Merkle-proved on-disk leaves; duplicate leafIndex rejected.
- `pipeline-cli/src/attestation/review-scope.ts`, `sign-v6.ts`, `src/steps/reviewer-set.ts`, `07-build-review-prompts.ts` (modified/new): signer-side selection and informational `reviewScope` record.
- `docs/operations/reviewer-set-flag.md` (modified): adopter docs for the opt-out.
- Tests: `review-scope.test.ts`, `sign-v6.test.ts`, `07-build-review-prompts.test.ts`, `scripts/verify-attestation.test.mjs`.

## Design decisions
- **Verifier counts reviewer leaves**: v6 verification previously required no reviewer role; the three-role check ran only on v3-v5. Added `enforceReviewScope` after a valid v6 result.
- **Conservative classifier**: path-keyword false positives force the full set (safe direction).
- **Tier-1 skill bodies** (execute.md, orchestrator-tick.md) still run the full set; the reduction is wired into the Tier-2 prompt builder only.

## Verification
- `pnpm build` — clean
- `pnpm test` — new tests pass; 7 pipeline-cli tests (verify-runtime, bin-invocation) fail identically on main
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- declined: wiring the reduction into the Tier-1 skill bodies, deferred to the operator/planner (scope).
- declined: binding the leaf set to the PR diff/patch-id in the signed payload (predates this task; flagged by security review).
