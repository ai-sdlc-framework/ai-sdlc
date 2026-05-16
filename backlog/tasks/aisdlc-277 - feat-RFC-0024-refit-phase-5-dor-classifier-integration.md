---
id: AISDLC-277
title: 'feat: RFC-0024 Refit Phase 5 — DoR-classifier integration (OQ-11)'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-5
  - critical-path-rfc-0035
dependencies:
  - AISDLC-321
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 5. Closes the OQ-11 gap: when an operator answers a DoR Stage B refinement question, their answer may reveal a NEW concern (not just a clarification of the existing question). The 2026-05-15 resolution reuses the Phase 2 classifier on DoR clarification responses.

## Scope (OQ-11)

- Hook into RFC-0011 DoR Stage B clarification response handler.
- Each segment of an operator's answer evaluated by the Phase 2 classifier with classes `{clarification | new-concern | ambiguous}`.
- `new-concern` segments above threshold auto-extracted to capture records.
- Capture records reference the DoR thread by ID.
- Multi-segment answers can split capture from clarification (one DoR answer can produce N captures + the clarification answer).
- Operator confirms in TUI before commit; classifier-confidence visible.
- RFC-0011 rubric and admission semantics stay unchanged (this is a side-effect of clarification responses, not a new gate).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 DoR Stage B clarification response handler invokes Phase 2 classifier
- [ ] #2 Multi-class output: `clarification | new-concern | ambiguous` per segment
- [ ] #3 `new-concern` segments above threshold auto-extract to capture records
- [ ] #4 Capture records reference DoR thread by ID
- [ ] #5 Operator confirms in TUI before commit
- [ ] #6 RFC-0011 admission semantics unchanged (no new gate; side-effect only)
- [ ] #7 Integration test: DoR answer with mixed clarification + new-concern segments produces correct extraction
<!-- AC:END -->
