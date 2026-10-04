---
id: AISDLC-715
title: >-
  Clear the stale open pull requests: four Dependabot PRs, #1096 and #1102
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - ci
  - deps
dependencies: []
references:
  - .github/dependabot.yml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Six pull requests have been open from four to thirteen days with failing checks, several
armed for auto-merge that can never fire: #1085 (dev-dependencies group, 9 updates), #1088
(typescript 6.0.3 to 7.0.2), #1091 (@linear/sdk 37 to 96), #1092 (ink 6.8.0 to 7.1.1),
#1096 (four token optimization strategies, attestation content hash mismatch), #1102
(opencode v2 support, backlog task 660, CodeQL failing). They add noise to every status survey
and hide real failures. The Dependabot settings live in `.github/dependabot.yml`.

## Acceptance Criteria
- [ ] Each of the six ends in exactly one state: merged through the normal gates, or closed with a comment giving the reason and the follow-up, or actively owned with a named next step and green or explained checks. A table in the PR (or the task's final summary) lists PR, verdict, reason, follow-up task id if any.
- [ ] Dependabot minor and patch updates (#1085 and any within the others): ask Dependabot to rebase or recreate, fix what the update breaks if the fix is small, and let them land through the Dependabot-authored bypass. Major version bumps (TypeScript 7, @linear/sdk 96, ink 7): attempt the upgrade on the branch only if the build and tests pass with small changes; otherwise close the PR, add an `ignore` rule for that major version to `.github/dependabot.yml` with a comment naming the follow-up task, and file one follow-up task per deferred major upgrade.
- [ ] #1096 and #1102: first establish who authored each (`gh pr view <n> --json author,headRepositoryOwner,isCrossRepository`). A PR from an outside contributor is never closed silently: diagnose the failing checks, push the fix if maintainer edits are allowed or leave a specific, courteous review comment saying what is needed, and report the state to the planner session before any close. An internally authored PR is fixed (re-review and re-sign where the attestation content hash no longer matches) or closed with the reason.
- [ ] Auto-merge is disarmed on any PR left open with failing required checks, with a comment saying why, so "armed with red checks" stops appearing in status surveys.
- [ ] Any change to `.github/dependabot.yml` goes through the normal review and attestation path (it is a code PR when authored by an agent).
- [ ] The Dependabot configuration is reviewed so that major version bumps arrive as separate, clearly labelled PRs or are routed to tasks, and the PR body carries a "Velocity impact" section.

## Out of scope
- Performing deferred major upgrades; changing review requirements for outside contributors.
<!-- SECTION:DESCRIPTION:END -->
