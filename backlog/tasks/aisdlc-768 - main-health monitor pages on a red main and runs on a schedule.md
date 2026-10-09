---
id: AISDLC-768
title: >-
  main-health monitor pages on a red main and runs on a schedule
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - ci
  - observability
dependencies: []
references:
  - .github/workflows/main-health-monitor.yml
  - .github/workflows/__tests__/
  - docs/operations/main-health-monitor.md
  - docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The main-health monitor (AISDLC-406) has never filed an issue. Its `gh issue create --label "ci,main-red"` step failed on every red run because neither label existed (`could not add label: 'ci' not found`, run 37957803001 at 4617753a on 2026-10-09). The labels were created by hand on 2026-10-09. The monitor also runs only on push to main, so a test that rots with the calendar is invisible until the next unrelated push. RCA: `docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md`.

## Scope

1. Add a `schedule` trigger (daily, 06:00 UTC) next to the push trigger; the scheduled run uses the current main head and the same issue step.
2. The issue step creates any missing label with `gh label create` before `gh issue create`, and if label creation is refused it files the issue without labels. A failed issue step must fail the job loudly with the reason in the summary.
3. A hermetic workflow test under `.github/workflows/__tests__/` asserts that every `--label` value the workflow passes is either created by the workflow or listed in a checked-in label manifest.
4. Update `docs/operations/main-health-monitor.md` for the schedule and the label behaviour.

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: A red scheduled run files a `[main-health]` issue even when the labels are absent.
- [ ] AC-2: The workflow runs daily with no push to main.
- [ ] AC-3: The workflow test fails when a label is referenced but neither created nor listed.
- [ ] AC-4: New and existing tests pass.
<!-- AC:END -->
