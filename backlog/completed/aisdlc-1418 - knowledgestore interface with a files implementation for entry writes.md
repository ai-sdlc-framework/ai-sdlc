---
id: AISDLC-1418
title: KnowledgeStore interface with a files implementation, routing every entry write through it
status: Done
priority: high
labels:
  - pipeline-cli
  - knowledge
  - refactor
  - enterprise
dependencies: []
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/knowledge/store.ts
  - pipeline-cli/src/knowledge/promote.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/ingest-sources.ts
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/knowledge/data-room.ts
  - pipeline-cli/src/cli/context.ts
  - pipeline-cli/src/knowledge/retrieval/types.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the enterprise RFC-0002 (ai-sdlc-enterprise, signed off) needs a seam in RFC-0053's knowledge store. Its tasks ENT-15 and ENT-16 are blocked on that seam. The requirement is a refactor with no change in behaviour. RFC-0053 OQ-2 stands: "the entries on disk remain the source of truth". This task adds **no** second implementation, **no** `knowledge.backend` key and **no** registration hook. Those wait on a separate operator decision about amending RFC-0053.
2. Delete: the read-modify-write helpers `findEntryFile` and `rewrite` (`promote.ts:161-187`) move into the files store. No caller keeps a direct `node:fs` call on an entry file.
3. Simplify: one interface in `pipeline-cli/src/knowledge/knowledge-store.ts`, modelled on the `RetrievalIndex` precedent (`retrieval/types.ts:40-48`). It is **synchronous**, as every caller is today. Whether it becomes asynchronous is part of the RFC-0053 amendment decision and is out of scope here.
4. Accelerate: none.
5. Automate: none added.

**Scope (writes; AISDLC-1419 routes the reads).** Every entry write goes through `KnowledgeStore`:
- `promote.ts`: `promoteEntry` :196, `reobserveEntry` :249, `refuteEntry` :274.
- `human.ts`: `confirmEntry` :13, `correctEntry` :40, `supersedeEntry` :64.
- `ingest-sources.ts`: `ingestSource` :240-268, including the existing-entry read and hash compare at :247.
- `ingest-memory.ts`: `writeEntry` :93 and the soft-supersede in `ingestMemoryTrunk` :99-149.
- `data-room.ts`: `captureFact` :96-117, which writes to the protected root.
- `cli/context.ts`: the `ingest-sections` handler :351-369, which writes inline today.

Minimum methods: `get(id)` returning fields, body and scope (or null); `put(entry, { scope })` to create or overwrite; `update(id, edit)` returning the fields as they were before (today's `rewrite` contract). Callers obtain the store from one factory `openKnowledgeStore(cfg)` that takes the existing `KnowledgeConfig` (`config.ts:13-24`). The factory returns the files implementation unconditionally.

**Keep as-is (do not normalize in this task).**
- The three supersession shapes stay exactly as they are today: `supersedes` on the new entry in `human.ts`, `id@hash` in `ingest-sources`, and `status: superseded` in `ingest-memory`. A follow-up can decide whether to unify them.
- The writers that log nothing today still log nothing.

**Out of scope.** `knowledge-log` I/O (AISDLC-1420 covers the event fields), `loadOntology`, the duplicate config parsers in `orchestrator/.../doctor-checks.ts:3287` and `enforce-blocked-actions.js:718`, and `lint-controls.mjs`.

## Acceptance Criteria
- [ ] #1 `pipeline-cli/src/knowledge/knowledge-store.ts` exports the `KnowledgeStore` interface, `FilesKnowledgeStore` and `openKnowledgeStore`. The JSDoc cites RFC-0053 OQ-2 and states that files are the only implementation.
- [ ] #2 No module listed under Scope calls `writeFileSync`, `readFileSync` or `readdirSync` on an entry path. `grep` over those files shows entry I/O only in `knowledge-store.ts`.
- [ ] #3 Behaviour is unchanged. The existing tests pass without editing their assertions: `promote.test.ts`, `human.test.ts`, `ingest-sources.test.ts`, `ingest-memory.test.ts`, `ingest-sections.test.ts`, `data-room.test.ts` and `cli/context.test.ts`. Bytes on disk for a promoted, superseded and ingested entry are identical before and after (one golden-file test).
- [ ] #4 A `knowledge-store.test.ts` covers `get`/`put`/`update` on the tracked and protected roots, including `get` of a missing id and `update` returning the prior fields.
- [ ] #5 No `knowledge.backend` key, no adapter registry and no second implementation is added.
- [ ] #6 `pnpm dark-code:check` passes with no growth in the baseline. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
