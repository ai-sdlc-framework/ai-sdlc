---
id: AISDLC-704.2
title: >-
  fix polynomial ReDoS regexes in orchestrator cycle-utils and review-agent
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
Follow-up from AISDLC-704 (code-scanning triage). Rewrite the polynomial-redos regexes at `orchestrator/src/cycle-utils.ts` (alert 168, tag-strip in sanitizeTemplate) and `orchestrator/src/runners/review-agent.ts` (alert 134) with linear-time logic and tests including a pathological input.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
