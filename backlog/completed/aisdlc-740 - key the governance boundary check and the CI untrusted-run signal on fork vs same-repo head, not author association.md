---
id: AISDLC-740
title: >-
  key the governance boundary check and the CI untrusted-run signal on fork vs same-repo head, not author association
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security ci
dependencies:
  - AISDLC-733
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/ai-sdlc-admit.yml
  - .github/workflows/ai-sdlc-review.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Governance boundary check from AISDLC-720.1 and the CI untrusted-run signal key on `author_association`, but GitHub reported a maintainer as CONTRIBUTOR on same-repo PR #1233, so trusted same-repo PRs get treated as untrusted. Fix: key on whether the head repo is a fork of the base repo (head.repo.full_name != base.repo.full_name). The same applies to the CI side of AISDLC-730. Do NOT make the Governance boundary check a required status until this is fixed.

Also folds in the known follow-ups from PR #1229 (the AISDLC-720.1 boundary check): (1) check-name collision: a fork can define a job with the same name, so publish the result as a unique commit-status context or add it to the ai-sdlc/pr-ready rollup; (2) race between the event's changed_files and the files API: use the compare API or re-read against head.sha; (3) the boundary script and other trusted-context scripts do not cover themselves in the governance path list; (4) the hook does not deny Bash writes to $GITHUB_ENV, and read-only COLLABORATORs count as trusted.

Sequencing: lands after the pre-push gate follow-up listed under dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The boundary check and the CI untrusted-run signal decide trust from head.repo.full_name vs base.repo.full_name, not author_association (test or workflow assertion).
- [x] A same-repo PR by a maintainer reported as CONTRIBUTOR is treated as trusted; a fork PR is untrusted.
- [x] The boundary check is not a required status until this lands (documented in the task close-out).
- [x] Check-name collision: the result is published as a unique commit-status context or added to the ai-sdlc/pr-ready rollup.
- [x] Race: changed files are read via the compare API or re-read against head.sha, not the event's changed_files.
- [x] The boundary script and other trusted-context scripts are listed in the governance path list.
- [x] The hook denies Bash writes to $GITHUB_ENV, and read-only COLLABORATORs are not treated as trusted.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Governance boundary now trusts a PR by head repo vs base repo (fork or not), not author_association. Files are read via the compare API pinned to head.sha with a live head/count re-check, the result is published as the unique commit-status `ai-sdlc/governance-boundary`, the boundary and trusted-context scripts cover themselves, the hook denies untrusted writes to $GITHUB_ENV/$GITHUB_PATH, and comment trust drops COLLABORATOR.

## Follow-up
- declined: the Governance boundary check stays a non-required status and required checks are unchanged; the operator decides when to require the `ai-sdlc/governance-boundary` context.
- declined: the static job-level untrusted-run value in the CI workflows and the issue-sourced ai-sdlc-admit.yml have no head repo to key on, so they are unchanged.
<!-- SECTION:FINAL_SUMMARY:END -->
