---
id: AISDLC-297
title: 'feat: RFC lifecycle promotion gate — enforce Draft → Ready for Review → Signed Off → Implemented ladder'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-governance
  - ci-lint
  - governance-gap
  - critical
dependencies: []
references:
  - spec/rfcs/README.md
  - scripts/check-rfc-docs.mjs
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Enforce the 4-step RFC lifecycle ladder. Operators have been flipping `Draft → Implemented` in a single PR (e.g. RFC-0024, RFC-0031), bypassing the two intermediate gates that exist precisely to prevent ship-before-decisions-are-final.

## Intended ladder

| State | Gate to enter |
|---|---|
| `Draft` | Initial — no gate |
| `Ready for Review` | All §OQ entries have `Resolution:` markers |
| `Signed Off` | Sign-off table complete (per `project_team_roles.md` — Engineering + Product + Operator as applicable) |
| `Implemented` | Implementation shipped + verified |

## Forbidden transitions

- `Draft → Signed Off` (skips Ready for Review)
- `Draft → Implemented` (skips both intermediate gates)
- `Ready for Review → Implemented` (skips sign-off)

## Scope

- New CI lint script `scripts/check-rfc-lifecycle-transitions.mjs` that compares the current PR's RFC frontmatter `lifecycle:` field against the prior commit's value.
- Detect forbidden transitions; fail CI with clear message + correct path.
- Allow legitimate jumps via PR-body marker: `<!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->` (operator override, audit-trail preserving).
- Wire into the existing `check-rfc-docs.mjs` test runner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `scripts/check-rfc-lifecycle-transitions.mjs` detects forbidden transitions in PR diff
- [ ] #2 Allowed transitions: Draft → Ready for Review → Signed Off → Implemented (sequential only)
- [ ] #3 Forbidden transitions fail CI with diagnostic message + suggested correct path
- [ ] #4 PR-body operator-override marker honored (audit-trail preserving)
- [ ] #5 Wired into the existing `check-rfc-docs.mjs` runner
- [ ] #6 Test coverage: each forbidden transition + allowed transition + override marker
<!-- AC:END -->
