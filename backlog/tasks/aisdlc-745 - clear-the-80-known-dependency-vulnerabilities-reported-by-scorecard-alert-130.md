---
id: AISDLC-745
title: >-
  clear the 80 known dependency vulnerabilities reported by Scorecard (alert 130)
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - security
  - deps
dependencies: []
references:
  - pnpm-lock.yaml
  - package.json
  - .github/workflows/scorecard.yml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Scorecard `Vulnerabilities` alert 130 reports 80 OSV/GHSA advisories in the pnpm lockfile tree. Fix direction: run `pnpm audit` and `osv-scanner` on the lockfile, bump or add `pnpm.overrides` for the affected transitive packages, verify the test suite, and leave a short table in the PR body of advisory to package to resolution. Split into halves if a bump needs a major upgrade; file the remainder as a follow-up rather than overriding without upgrade.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] osv-scanner on pnpm-lock.yaml reports 0 advisories, or lists only ones with a written justification.
- [ ] The test suite is green and the PR body has the advisory to package to resolution table.
- [ ] Scorecard alert 130 closes on the next Scorecard run.
