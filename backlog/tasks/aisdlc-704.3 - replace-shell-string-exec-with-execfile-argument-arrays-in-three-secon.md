---
id: AISDLC-704.3
title: >-
  replace shell-string exec with execFile argument arrays in three second-order injection sites
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
Follow-up from AISDLC-704 (code-scanning triage). Fix code-scanning alerts 180 (`pipeline-cli/src/steps/11-late-rebase.ts`), 176 (`orchestrator/src/runtime/git-env.ts`) and 167 (`orchestrator/src/execute.ts`): pass values as argument arrays (no shell interpolation), review each site, add tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
