---
id: AISDLC-783
title: >-
  auto-memory trunk ingest adapter
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-774
  - AISDLC-780
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - backlog/tasks/aisdlc-729 - memory dream an internal process that consolidates prunes and refines agent memory.md
  - pipeline-cli/src/cli/index.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ingest the Claude auto-memory folder as a `memory` trunk, as resolved by OQ-6. The folder keeps its file format and remains the harness's write target. Each note becomes an entry at `scope: protected` with authority from the note type (`user` and `feedback` map to `specialist` with the operator as source, `project` and `reference` to `inferred`) and the note file as the citation. The memory dream (AISDLC-729) stays the hygiene pass for that folder and its folder swap triggers a re-ingest under the lock AISDLC-729 specifies. Harness recall stays on, and the load-once ledger marks a note loaded whenever either path surfaces it.

Sequencing: listed in `dependencies:` (AISDLC-774, AISDLC-780).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] Every note in a fixture memory folder becomes a `memory` trunk entry at `scope: protected` with the note file as citation (test).
- [ ] `user` and `feedback` notes map to `specialist` with the operator as source and `project` and `reference` notes to `inferred` (test per type).
- [ ] A folder swap by the dream triggers a re-ingest under the dream's lock and removed notes are superseded, not deleted (test).
- [ ] The ledger marks a note loaded when the harness recall path surfaces it, and the engine does not inject it again (test).
- [ ] Memory entries never appear in a tracked root or a PR body (test against the protected-scope check).
