---
id: AISDLC-509
title: 'feat(sandbox): RFC-0043 Phase 7 — differential test execution inside the container'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - sandbox
dependencies:
  - AISDLC-508
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/pipeline/sandbox-runner.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement `runDockerDifferentialTest` (W2): the actual work inside the container. Currently throws `"not yet implemented"`. Produces the real `DifferentialTestResult` that feeds the unsigned report.

The diff is applied as **data** (the fork-PR safety guard): clone the base, apply the PR diff, run the suite — never execute fork-provided workflow logic.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Inside the container: check out the base (`upstreamMainRef` = baseSha, NOT headSha — preserve the AISDLC-501 fix), apply the PR diff as data, install deps offline where possible
- [ ] #2 Run the test suite for base vs PR-head (differential), capture pass/fail counts + coverage delta into `DifferentialTestResult`
- [ ] #3 Per-test + wall-clock timeouts honored (compose with AISDLC-508 enforcement); a hung test → breach, not a stuck runner
- [ ] #4 Test output parsing is resilient to missing/garbage output (fail-closed: unparseable → treated as failure, not pass)
- [ ] #5 Real-container integration test (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`) on a small fixture repo proves a passing PR and a failing PR are distinguished; ≥80% patch coverage on parsing logic
<!-- AC:END -->
