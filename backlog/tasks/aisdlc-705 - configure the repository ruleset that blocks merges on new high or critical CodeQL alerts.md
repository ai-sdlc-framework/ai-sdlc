---
id: AISDLC-705
title: >-
  Configure the repository ruleset that blocks merges on new high or critical CodeQL alerts
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - governance
  - ci
dependencies:
  - AISDLC-704
references: []
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The operator chose this ruleset on 2026-10-03 and it was waiting for him to click it.
Under DEC-0039 administration is agent work: configure it through the GitHub API with the
repository's existing credentials.

Sequenced after the task that fixes the two critical alerts (listed under dependencies): the two critical alerts must be fixed first, or the ruleset blocks
every pull request.

## Acceptance Criteria
- [ ] A script or documented `gh api` call creates or updates a repository ruleset on `main` with the code-scanning rule (CodeQL, security alerts threshold high or higher; errors threshold as GitHub recommends), idempotently.
- [ ] The applied ruleset is exported to a file in the repo (for example under `.github/rulesets/`) so drift is reviewable.
- [ ] If the token lacks admin rights the task stops and records exactly which permission is missing as an operator-only item; it does not look for another way in.
- [ ] A test pull request or the next real pull request shows the rule evaluating.
- [ ] docs/operations notes the ruleset and how to change it.

## Out of scope
- Other branch protection changes.
<!-- SECTION:DESCRIPTION:END -->
