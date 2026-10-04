---
id: AISDLC-704
title: >-
  Fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - security
  - ci
dependencies: []
references:
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ai-sdlc-fix-ci.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
About 37 code-scanning alerts are open on main (2 critical, 25 high, 9 medium, 1 low as
of 2026-10-03). The two critical ones are DangerousWorkflow findings at
`.github/workflows/ai-sdlc-review.yml:298` and `.github/workflows/ai-sdlc-fix-ci.yml:47`.
Triage was waiting on the operator; under DEC-0039 it is agent work.

## Conventions
- Workflow edits are authorized for this internal, operator-overseen task.
- Never interpolate `github.event.*` values into a `run:` block; bind them to an
  environment variable and treat them as data.
- Security review runs on opus. The pull request stays a draft until CodeQL is clean.

## Acceptance Criteria
- [ ] Both critical alerts are fixed in code, not dismissed: no untrusted `github.event.*` value is interpolated into a `run:` block and no untrusted ref is checked out with secrets in scope. The alerts read `fixed` after merge.
- [ ] Every other open alert is fixed, or dismissed with a recorded reason, or filed as its own follow-up task when the fix is larger than this pull request. A table in the pull request body lists alert number, rule, path and disposition.
- [ ] Dismissals of high alerts are recorded as one decision in the catalog (class per AISDLC-703, or "for operator review" if 703 has not landed).
- [ ] Security review on opus; draft pull request until CodeQL is clean.

## Out of scope
- Dependabot alerts.
<!-- SECTION:DESCRIPTION:END -->
