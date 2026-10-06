---
id: AISDLC-704.1
title: >-
  fix polynomial ReDoS regexes in pipeline-cli import-spec parser
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
Follow-up from AISDLC-704 (code-scanning triage). Rewrite the six polynomial-redos regex sites in `pipeline-cli/src/import-spec/parser.ts` (code-scanning alerts 137, 136, 44, 42, 41, 40: lines ~74, 75, 120, 137, 162, 178) with linear-time matching, with tests that pin the old behaviour and a pathological-input case.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
