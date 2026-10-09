---
id: AISDLC-780
title: >-
  session load-once ledger for injected context
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
  - pipeline-cli/src/cli/index.ts
  - ai-sdlc-plugin/hooks/session-start.js
  - orchestrator/src/embedding/index.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the RFC-0053 session load ledger. A per-session jsonl file (for example `.ai-sdlc/context/sessions/<session-id>.jsonl`) records entry id, content hash, moment and injected tokens for every injection. `cli-context query --session` subtracts the ledger inside the query, so an entry is loaded once per session unless its content hash changed; a changed entry is injected again and the ledger notes the supersession. The ledger resets on `/clear` and is rebuilt from the compaction summary on `PreCompact`. CLAUDE.md and the memory index are pre-marked as loaded. Writes take a lock so concurrent hooks do not corrupt the file.

Sequencing: depends on AISDLC-775 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A second query in the same session omits an entry already injected with the same content hash (test).
- [ ] An entry whose content hash changed is injected again and the ledger records the supersession (test).
- [ ] The ledger resets on clear and a fresh session starts with an empty ledger apart from the pre-marked entries (test).
- [ ] After compaction, entries whose text survives the summary stay marked loaded and the rest become eligible again (test with a fixture summary).
- [ ] CLAUDE.md and the memory index are pre-marked as loaded and never re-injected (test).
- [ ] Concurrent appends from two processes leave a valid ledger (lock test).
- [ ] Each ledger row records injected tokens per entry per moment (test).
