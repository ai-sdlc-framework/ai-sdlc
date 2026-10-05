---
id: AISDLC-723
title: >-
  No opus security review for test-only and docs-adjacent changes
status: To Do
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
- [ ] The classifier marks a diff "test-only" when every changed path is a test file, fixture or snapshot (patterns: `*.test.*`, `*.spec.*`, `__tests__/**`, `**/fixtures/**`, `**/__snapshots__/**`), and "docs-adjacent" when every changed path is Markdown or a file already covered by the docs-only classifier in `scripts/is-docs-only-changeset.mjs`. The classification is path-based only: a comment-only change is not inferred. Mixed diffs are not downgraded.
- [ ] For such diffs the required reviewer set is the correctness reviewer alone; the security reviewer is not spawned. Any trust-chain path in the diff (same list as the two-reviewer task), any workflow file, any test under `ai-sdlc-plugin/hooks/**` or for attestation and signing code, or any file that changes a security test's expectations forces the full set.
- [ ] The CI verifier re-derives the classification from the diff; the signer cannot assert it.
- [ ] Config lets a repository keep the security review on everything; documented for adopters in `docs/operations/reviewer-set-flag.md`.
- [ ] The attestation records the classification and the reviewer set that applied.
- [ ] Tests: a test-only diff selects correctness only; a test file under hooks selects the full set; a mixed source and test diff is not downgraded; the verifier rejects a correctness-only attestation on a source diff.
- [ ] The pull request body carries a "Velocity impact" section with the measured share of recent pull requests that qualify and the opus runs saved.

## Out of scope
- Skipping review entirely for any code path; changing docs-only handling, which already skips the pipeline.
<!-- SECTION:DESCRIPTION:END -->
