---
id: AISDLC-704.4
title: >-
  pin pip build dependencies in release.yml and fix identity-replacement in blast-radius-overlap
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). Two small leftovers from AISDLC-704: alert 175 (PinnedDependenciesID, `.github/workflows/release.yml`: hash-pin the pip build requirements) and alert 61 (js/identity-replacement, `pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts:345`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
