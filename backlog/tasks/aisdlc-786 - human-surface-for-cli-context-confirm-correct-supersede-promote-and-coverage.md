---
id: AISDLC-786
title: >-
  human surface for cli-context: confirm, correct, supersede, promote and coverage
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-4
dependencies:
  - AISDLC-776
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/cli/index.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the RFC-0053 human surface. `cli-context` gains `confirm`, `correct`, `supersede` and `promote` subcommands that apply the OQ-3 rules: confirm moves confidence 30 percent toward the new value and never changes authority, supersede links the old entry and keeps it, and `canonical` promotion requires a human. A coverage score (required x 0.6 + enriching x 0.25 + count x 0.15) maps to blocked, draft or ready and is presented as a gap list. A plain-text dashboard prints the gaps and the staleness queue.

Sequencing: depends on AISDLC-776 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `confirm` moves confidence 30 percent toward the supplied value and leaves authority unchanged (test).
- [ ] `supersede` creates the relation, keeps the old entry and moves the head of the chain in retrieval (test).
- [ ] `promote` to `canonical` is refused for an agent caller and accepted for a human caller (test).
- [ ] Every confirm, correct, supersede and promote writes a knowledge-log event (test).
- [ ] The coverage score maps fixture inputs to blocked, draft and ready at the documented thresholds (test per band).
- [ ] The plain-text dashboard lists gaps tagged owner, research or analysis (test on output).
