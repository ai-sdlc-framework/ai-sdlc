---
id: AISDLC-655.2
title: >-
  RFC-0050: document the reviewer replay sandbox and the spend confirmation flag
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
dependencies:
  - AISDLC-655
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The RFC and operator docs still show the original replay command line. Describe the sandbox (read-only tools, user settings only, throwaway clone, removal of commit-supplied configuration), the explicit spend confirmation flag, the capped cost printout, the off-peak window flags and the labelling rule for known-defect and clean items.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] The replay section of the RFC and the operator docs show the current command line, the sandbox guarantees and the spend confirmation flag.
- [ ] pnpm docs:check passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
