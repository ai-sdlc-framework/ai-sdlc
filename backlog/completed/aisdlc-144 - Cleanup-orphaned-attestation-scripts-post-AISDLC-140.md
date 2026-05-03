---
id: AISDLC-144
title: Cleanup orphaned attestation scripts post-AISDLC-140
status: Done
assignee: []
created_date: '2026-05-02 22:14'
labels:
  - cleanup
  - follow-up
dependencies: []
priority: low
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/ci-sign-attestation.mjs'
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/ci-sign-attestation.test.mjs'
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/post-attestation-comment.mjs'
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Cleanup follow-up to AISDLC-140 sub-4. After removing the CI-attestor signing step + verify-attestation post-status, three scripts are orphaned (no callers): `scripts/ci-sign-attestation.mjs`, `scripts/ci-sign-attestation.test.mjs`, `scripts/post-attestation-comment.mjs`.

## Acceptance criteria
1. Delete `scripts/ci-sign-attestation.mjs` + its test file
2. Delete `scripts/post-attestation-comment.mjs` (and any test file)
3. Remove the `ci-attestor` entry from `.ai-sdlc/trusted-reviewers.yaml` (no longer needed; cleaner state)
4. Search for any remaining references to these scripts in workflow YAMLs / package.json scripts / docs; remove
5. `pnpm test` still passes (existing test suites unaffected)
6. PR body lists every file deleted + every reference removed

Low priority — orphaned files are harmless (just dead code).</description>
<acceptanceCriteria>["Delete scripts/ci-sign-attestation.mjs + test", "Delete scripts/post-attestation-comment.mjs + test", "Remove ci-attestor entry from .ai-sdlc/trusted-reviewers.yaml", "No remaining references in workflow YAMLs or package.json scripts", "pnpm test passes", "PR body lists all deletions + reference removals"]</acceptanceCriteria>
</invoke>
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Cleanup of AISDLC-140 sub-4 leftovers. Deleted 4 orphaned files (ci-sign-attestation.mjs + .test.mjs, post-attestation-comment.mjs + .test.mjs), trimmed the ci-attestor placeholder block from .ai-sdlc/trusted-reviewers.yaml, and updated 2 doc comments in attestations.ts that referenced the deleted scripts.

## Verification
- pnpm build / test / lint / format:check — all pass
- Orphan claim verified: grep across .github/, .ai-sdlc/, package.json, src returned ZERO callers (only historical references in backlog/completed/ and CHANGELOG.md, which are intentionally untouched)
- 3 reviews APPROVED — 0c/0M/0m/2s (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable)

## Follow-up (deferred — code reviewer flagged)
- Root CLAUDE.md may have stale "## CI-side attestor" section (worktree's CLAUDE.md already migrated by sub-4 PR #183; if root is stale, it's a parent-dir state issue not code)
<!-- SECTION:FINAL_SUMMARY:END -->
