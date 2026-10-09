---
id: AISDLC-765
title: >-
  Usage audit cli and weekly idle-cost digest from claude code transcripts
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - token-cost
  - observability
dependencies: []
references:
  - docs/audits/scripts/2026-10-08-token-audit/audit8.mjs
  - pipeline-cli/src/cli/index.ts
  - orchestrator/src/cli/commands/doctor.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The audit was done with ad-hoc scripts; nobody saw $160 per hour of idle polling for 20 hours. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. `cli-usage audit --days N` reading ~/.claude/projects transcripts, grouping by project, loop body, role and model, and flagging idle noop-wakeup turns and sessions whose context exceeds a threshold with no clear.
2. A doctor check `idle-sessions` that warns when a hierarchy session has polled empty for over 30 minutes.
3. A weekly digest the planner can paste (the operator reads /usage for the real percentage).

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: `cli-usage audit --days 7` groups cost by project, loop body, role and model.
- [ ] AC-2: Idle noop-wakeup turns and no-clear large-context sessions are flagged.
- [ ] AC-3: `ai-sdlc doctor` reports idle-sessions as a warning after 30 minutes of empty polling.
- [ ] AC-4: The digest output is paste-ready text.
- [ ] AC-5: Hermetic tests cover the transcript parser.
<!-- AC:END -->
