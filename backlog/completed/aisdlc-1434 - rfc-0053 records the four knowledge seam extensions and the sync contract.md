---
id: AISDLC-1434
title: RFC-0053 records the four knowledge seam extensions and the sync contract
status: Done
priority: medium
labels:
  - docs
  - rfc
  - knowledge
  - enterprise
dependencies: []
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - docs/operations/knowledge-store.md
  - pipeline-cli/src/knowledge/retrieval/service.ts
  - pipeline-cli/src/knowledge/retrieval/sqlite-index.ts
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, item 9) on 2026-11-26; operator ruled 2026-11-26 through the decision rubric (decision record filing; cite as 'the item-9 decision record'). The DEC-0427 amendment (`RFC-0053-just-in-time-context-engine.md:427`) defines the seam; four extensions decided 2026-11-26 (items 6, 7, 9, 10: factory receives `projectRoot` and its config block; `localPaths`; the sync contract; `ontology()`) are not recorded in the RFC, so the seam has no single reference.
2. Delete: nothing.
3. Simplify: docs only. Add a dated amendment paragraph directly after the DEC-0427 amendment (after line 427) and a change-log row after line 525 listing the four extensions. The amendment states the sync contract: a backend sync writes the backend's own replica that `list()` reads, then calls `rebuildIndex` (`retrieval/service.ts:31`); nothing but rebuild writes the index; the index stays derived, so OQ-2 is unchanged. Add a "Sync contract" section to `docs/operations/knowledge-store.md` (between "Checks" and "Known gaps"). The RFC must not gain an OQ resolution marker, and no OQ text is touched; lifecycle and status are unchanged. Note: with a configured API embedder each rebuild re-embeds every entry (`sqlite-index.ts:67-68`, no cache); a `contentHash` embedding cache is a follow-up only if measured cost requires it, and is not in scope. Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment; the change is additive to the DEC-0427 seam. Write interface shape (OQ-A: async writes) is undecided; this task changes no `put`/`update` signature and does not make any write sync or async.
4. Accelerate: none.
5. Automate: the existing RFC lifecycle and docs gates.

## Acceptance Criteria
- [ ] #1 RFC-0053 has a dated (2026-11-26) amendment paragraph after the DEC-0427 amendment naming items 6, 7, 9 and 10 and the provisional-Product-review wording.
- [ ] #2 The amendment states the sync contract exactly: backend sync writes the replica `list()` reads, then calls `rebuildIndex`; nothing but rebuild writes the index; the index stays derived (OQ-2 unchanged).
- [ ] #3 A change-log row is added after the 2026-11-26 DEC-0427 row.
- [ ] #4 `docs/operations/knowledge-store.md` has a "Sync contract" section with the same statement.
- [ ] #5 `git diff` shows no OQ resolution marker added, no OQ text changed, and no lifecycle/status line changed.
- [ ] #6 No code changes; docs and RFC lifecycle gates, then `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
