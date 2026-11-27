---
id: AISDLC-1455
title: Knowledge store writes are async named operations (write and create)
status: To Do
priority: high
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1432
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/log.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/promote.ts
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, items 1-5 and 8, their OQ-A shape B, provisional on their RFC-0002 signers). Operator ruled 2026-11-27 through the decision rubric: DEC-0443 option a (full shape B plus the optional concurrency token; the token is AISDLC-1457). `KnowledgeStore.update(id, edit)` (`knowledge-store.ts:70-74`) takes an opaque edit function, so a remote server cannot tell a confirm from a correct or a supersede and cannot authorize or audit by operation. The interface is sync "because every caller is" (`knowledge-store.ts:10`), which a network backend cannot honour.
2. Delete: nothing in this task. `put`/`update` are removed in AISDLC-1456 once callers move.
3. Simplify: add two async methods to `KnowledgeStore`, implement them in the `files` backend, and keep reads (`get`, `list`, `listRaw`) sync.
   - `create(entry: { fields, body }, opts: PutOptions & { principal: string }): Promise<WriteResult>`.
   - `write(id, op: { kind: WriteKind; fields: Record<string, unknown>; principal: string }, opts?: { scope? }): Promise<WriteResult>`.
   - `WriteKind` is a closed, exported, documented union derived from today's call sites (`human.ts:25,64,97`, `promote.ts:208,239,265`, the re-ingest overwrite in `ingest-sources.ts:271`) plus `excise`: at minimum `confirm | correct | supersede | promote | reobserve | refute | reingest | excise`. Adding a kind later is an interface change.
   - Enterprise conditions, each covered by a test: (1) `supersede` is ONE call: `write(oldId, { kind: 'supersede', fields: <new entry fields> })` creates the new entry and marks the old one superseded, returning the new id and path; (2) the kind set is closed; (3) `promote` fields carry the target authority and the proof; (4) `WriteResult` is `{ id, path, created, status: 'applied' | 'proposed' | 'rejected', reason? }`, where `proposed` means queued as a proposal (the files backend always returns `applied`, or `rejected` for `excise`, which it does not support); (5) the contract states that `promote`, `supersede`, `confirm` and `excise` are never deferred offline: a backend applies, proposes or rejects them synchronously with the call; (6) `principal` is recorded in the local knowledge log only; a server backend takes the principal from its own credential.
   - Every `write` and `create` appends a knowledge log event, including kinds that change no field (`confirm`). Extend `KnowledgeEventKind` (`log.ts`) with `created`, `reingested` and `excised`. A protected entry's event still carries no value and no hash of one (AISDLC-1424).
   - Release note (breaking only when AISDLC-1456 removes `put`/`update`; this task is additive): no `!` and no `BREAKING CHANGE` footer (release-please linked-versions group, see AISDLC-1432).
   - Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment (AISDLC-1458).
4. Accelerate: none.
5. Automate: unit tests for each condition against the files backend.

## Acceptance Criteria
- [ ] #1 `KnowledgeStore` exports async `create` and `write`, the closed `WriteKind` union and `WriteResult` with the four fields above; reads stay sync.
- [ ] #2 The files backend implements both; `write` with `supersede` creates the new entry and marks the old one in one call (test).
- [ ] #3 `promote` without target authority or proof is rejected (test); `excise` on files returns `status: 'rejected'` with a reason (test).
- [ ] #4 Every `write` and `create` appends exactly one knowledge log event with its kind and principal, including `confirm`; protected entries carry no value or hash (tests).
- [ ] #5 The contract (kinds, statuses, never-deferred kinds, principal rule) is documented in `docs/operations/knowledge-store.md`.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
