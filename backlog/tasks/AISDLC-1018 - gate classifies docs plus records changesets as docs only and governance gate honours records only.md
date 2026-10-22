---
id: AISDLC-1018
title: >-
  Gate classifies docs-plus-records changesets as docs-only and the governance gate honours records_only
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - ci
  - velocity
  - root-cause
dependencies: []
references:
  - scripts/is-docs-only-changeset.mjs
  - scripts/check-pr-governance.mjs
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator fast-track, 2026-10-22).** A collaborator's docs PR (#1860: `docs/**`, two RFCs, one completed task file, and one example identifier in `spec/glossary.md`) was classified `code` by `scripts/is-docs-only-changeset.mjs`: `spec/glossary.md` is on the records-only allowlist but not the docs-only one, and `docs/**` is on the docs-only allowlist but not the records-only one, so a changeset mixing the two matches neither and falls through to `code`. The attestation gate and the governance gate's reviewer check then demanded a review envelope for a PR with no code. The planner had to split the glossary line into #1861, and that records-only PR still fails the governance gate, because `governance-gate` in `ai-sdlc-gate.yml` passes only `--docs-only` to `check-pr-governance.mjs` and never `records_only`, while `attestation-gate` and `issue-link` already skip on both outputs.

**Root cause.** Two disjoint allowlists with a fall-through to `code`, and one consumer (the governance gate) that reads only one of the two outputs.

**Five-step review (requirements first).**
1. Requirement questioned: "a changeset is docs-only, records-only or code". Kept, with the rule that docs plus records contains no code and is docs-only for every gate.
2. Delete: the governance gate's reviewer check on records-only PRs (it already does not run on docs-only ones).
3. Simplify: `classify` returns `docs-only` when every file matches the union of the docs-only and records-only allowlists (trust-chain paths still excluded); `records-only` stays for pure records. `governance-gate` passes `--records-only "$RECORDS_ONLY"` and `checkReviewers` returns early on it, the same shape as `docsOnly`.
4. Accelerate: a mixed docs-plus-records PR and a glossary-only PR go green on the first run; no split, no envelope.
5. Automate: unit tests for `classify` (docs+records = docs-only; docs+records+code = code; glossary alone = records-only) and for `checkReviewers` with `recordsOnly: true`; a workflow assertion that every job skipping on `docs_only` also skips on `records_only` where the comment says it should.

**Velocity impact.** Positive: one red gate and one manual split per mixed docs PR removed; no control loosened for code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `is-docs-only-changeset.mjs --class` returns `docs-only` for the #1860 file list (docs, RFCs, a completed task file and `spec/glossary.md`) and `code` once any non-allowlisted file is added
- [ ] #2 `governance-gate` in `ai-sdlc-gate.yml` passes `records_only` to `check-pr-governance.mjs`, and `checkReviewers` returns no finding when it is true
- [ ] #3 PR #1861 (glossary only) passes `Governance gate` without an attestation envelope once this lands (rerun or rebase)
- [ ] #4 `docs/operations/quality-gate.md` states that docs plus records is docs-only and lists the governance gate among the jobs that skip the reviewer check on records-only PRs
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test scripts/is-docs-only-changeset.test.mjs scripts/check-pr-governance.test.mjs`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
