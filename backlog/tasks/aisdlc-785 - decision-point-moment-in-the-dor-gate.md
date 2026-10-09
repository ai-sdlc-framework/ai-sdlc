---
id: AISDLC-785
title: >-
  decision-point moment in the DoR gate
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-775
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - pipeline-cli/bin/cli-decisions.mjs
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deliver the decision-point moment of the RFC-0053 surfacing protocol. Before dispatch, the DoR gate asks retrieval for open questions and contradictions on the task's references and routes each one through the Decision Catalog (RFC-0035) with `cli-decisions`, to the person who can answer. Each routed question emits an event. The engine blocks nothing itself: routing follows the existing upstream-OQ gate behavior and `blocked.reason` override.

Sequencing: depends on AISDLC-775 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] For a fixture task, the DoR gate queries retrieval with the task's references and body and receives open questions and contradictions (test with a stub index).
- [ ] Each open question or contradiction is filed through `cli-decisions` with a context reference to the entry (test).
- [ ] An event is emitted for each routed question (test).
- [ ] Retrieval failure or an empty index leaves the DoR result unchanged (test).
- [ ] The existing upstream-OQ gate tests still pass unchanged.
