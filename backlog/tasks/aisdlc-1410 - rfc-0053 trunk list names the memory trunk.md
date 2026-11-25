---
id: AISDLC-1410
title: 'RFC-0053 trunk list names the memory trunk'
status: To Do
assignee: []
created_date: '2026-11-24'
labels:
  - docs
  - knowledge
  - rfc
dependencies: []
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/knowledge/ontology.ts
  - docs/operations/knowledge-store.md
priority: low
---

## Description

**Five-step review (requirements first).** The code is right and needs no change: the default ontology (`ontology.ts`, about line 21) has seven trunks, and the seventh, `memory`, was added by AISDLC-783 under the RFC's own OQ-6 resolution ("Auto-memory is indexed as a `memory` trunk at `scope: protected`"). Only the RFC's trunk list (about lines 134-135) still names six. A reader of that list concludes the code and the RFC disagree; an adopter planner did (2026-11-24). Fix the list; change nothing else.

This is a consistency edit to match a resolution already recorded in the RFC. It resolves no Open Question and changes no decision.

## Fix

- In the RFC trunk list, add `memory`, with a short note that it holds auto-memory ingest only, at `scope: protected` (OQ-6).
- Add a revision-history line for the edit.
- `docs/operations/knowledge-store.md`: list the seven default trunks where the ontology is described.
- No code change. No `Resolution:` marker added or altered.

## Acceptance Criteria

- [ ] #1 The RFC trunk list and `DEFAULT` trunks in `ontology.ts` name the same seven trunks.
- [ ] #2 `docs/operations/knowledge-store.md` lists the default trunks.
- [ ] #3 `pnpm rfc:test` and `pnpm format:check` pass.
