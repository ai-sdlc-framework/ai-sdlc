---
id: AISDLC-214
title: >-
  AISDLC-211 #3 — eliminate docs-only fallback workflow race via predicate
  short-circuit in regular workflow
status: Done
assignee: []
created_date: '2026-05-06 13:54'
labels:
  - bug
  - ci
  - attestation
  - merge-queue
  - framework-bug
dependencies:
  - AISDLC-206
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Decomposed from AISDLC-211 (root cause #3)

`paths-ignore` doesn't apply to `merge_group` events, so on the merge queue both the regular `verify-attestation.yml` AND the `verify-attestation-docs-only.yml` fallback fire. They race; one cancels. The CANCELLED status blocks auto-merge — every PR in the queue tonight required `gh run rerun` to flip CANCELLED → SUCCESS to unblock the queue.

## Fix

Make the regular `verify-attestation.yml` do its own docs-only detection at job-start using the shared predicate that AISDLC-206 just shipped (`scripts/is-docs-only-changeset.mjs`). If the merge_group commit only touches docs paths, short-circuit and post `success` directly without needing an envelope.

Same fix for `ai-sdlc-review.yml` so the corresponding fallback can also be retired.

After this, the docs-only fallback workflows (`verify-attestation-docs-only.yml`, `ai-sdlc-review-docs-only.yml`) can be DELETED — the regular workflows handle both pull_request (via paths-ignore) AND merge_group (via short-circuit) correctly.

## Implementation sketch

```yaml
# verify-attestation.yml — first step of the verify job
- name: Detect docs-only changeset
  id: docs_only
  run: |
    FILES=$(git diff --name-only ${{ github.event.merge_group.base_sha }}...${{ github.event.merge_group.head_sha }})
    ALL_DOCS=$(printf '%s\n' "$FILES" | node scripts/is-docs-only-changeset.mjs)
    echo "all_docs=$ALL_DOCS" >> $GITHUB_OUTPUT

- name: Short-circuit on docs-only
  if: steps.docs_only.outputs.all_docs == 'true'
  uses: actions/github-script@v7
  with:
    script: |
      await github.rest.repos.createCommitStatus({
        owner: context.repo.owner, repo: context.repo.repo,
        sha: context.sha,
        state: 'success',
        context: 'ai-sdlc/attestation',
        description: 'docs-only changeset — attestation N/A'
      });

- name: Verify envelope (skipped if docs-only)
  if: steps.docs_only.outputs.all_docs != 'true'
  run: ...existing verify steps...
```

Dependencies: AISDLC-206 must be merged (it is — merged tonight via #352).

## permittedExternalPaths
This task edits 4 workflow files (regular + fallback for both attestation + review). Frontmatter needs `permittedExternalPaths: ['.github/workflows/']`.

## Acceptance Criteria
- [ ] #1 `.github/workflows/verify-attestation.yml` short-circuits with success on docs-only merge_group commits using `scripts/is-docs-only-changeset.mjs`
- [ ] #2 `.github/workflows/ai-sdlc-review.yml` does the same for its required check
- [ ] #3 Both fallback workflows (`verify-attestation-docs-only.yml`, `ai-sdlc-review-docs-only.yml`) are deleted (or stubbed if backwards compat needed)
- [ ] #4 Hermetic test in `pipeline-cli/` or `scripts/` simulates a merge_group commit on a docs-only diff, asserts the regular workflow's logic returns success
- [ ] #5 No regression: code PRs still require valid envelope; mixed PRs (code + docs) require valid envelope
- [ ] #6 Documentation in CLAUDE.md updated to reflect the simplified workflow architecture
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Implementation shipped via PR #358. The lifecycle close was lost when the now-retired `.github/workflows/backlog-task-complete.yml` workflow's chore-close PR (#360/#362/#367/#368) failed to auto-merge (one of the orphan-PR cases that motivated AISDLC-220). Moving to `backlog/completed/` retroactively as part of the post-AISDLC-220 sync sweep.
