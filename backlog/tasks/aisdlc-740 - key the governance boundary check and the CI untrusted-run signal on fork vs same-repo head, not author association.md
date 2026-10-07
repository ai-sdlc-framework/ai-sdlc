---
id: AISDLC-740
title: >-
  key the governance boundary check and the CI untrusted-run signal on fork vs same-repo head, not author association
status: To Do
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

Sequencing: after AISDLC-733.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The boundary check and the CI untrusted-run signal decide trust from head.repo.full_name vs base.repo.full_name, not author_association (test or workflow assertion).
- [ ] A same-repo PR by a maintainer reported as CONTRIBUTOR is treated as trusted; a fork PR is untrusted.
- [ ] The boundary check is not a required status until this lands (documented in the task close-out).
- [ ] Check-name collision: the result is published as a unique commit-status context or added to the ai-sdlc/pr-ready rollup.
- [ ] Race: changed files are read via the compare API or re-read against head.sha, not the event's changed_files.
- [ ] The boundary script and other trusted-context scripts are listed in the governance path list.
- [ ] The hook denies Bash writes to $GITHUB_ENV, and read-only COLLABORATORs are not treated as trusted.
