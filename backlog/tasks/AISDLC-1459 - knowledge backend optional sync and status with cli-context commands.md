---
id: AISDLC-1459
title: Knowledge backend optional sync() and status(), with cli-context sync and status
status: In Progress
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies: []
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/cli/context.ts
  - pipeline-cli/src/knowledge/retrieval/service.ts
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 OQ-J, N1 and N2; their D5 names `cli-context sync`), provisional on their signers. Operator ruled 2026-11-27 through the decision rubric: DEC-0444 option a. DEC-0430 option b fixed the contract (a sync writes the replica `list()` reads, then `rebuildIndex`, `retrieval/service.ts:31-48`); no trigger exists today (`cli-context` has no sync subcommand).
2. Delete: nothing.
3. Simplify: `KnowledgeStore` gains optional `sync?(): Promise<{ pulled: number; pushed: number }>` and `status?(): Promise<{ queued: number; rejected: number; lastSyncAt?: string; lastError?: string }>`; the files backend omits both. `cli-context sync` calls `sync()` then `rebuildIndex`, prints one JSON line and records the outcome (time, counts, error) in a stamp file under the knowledge state directory that AISDLC-1460 reads; with no `sync()` it prints `{"ok":true,"supported":false}` and exits 0. `cli-context status` prints `status()` merged with the stamp file, or `supported:false`.
4. Accelerate: none.
5. Automate: tests with a stub backend implementing both, and with the files backend.

## Acceptance Criteria
- [ ] #1 Optional `sync`/`status` on `KnowledgeStore`, documented; files backend unchanged.
- [ ] #2 `cli-context sync` runs sync then `rebuildIndex` and writes the stamp file (time, counts, error); a sync error is recorded and exits non-zero (tests).
- [ ] #3 `cli-context status` prints queued, rejected, last sync time and last error (test).
- [ ] #4 Both commands report `supported:false` and exit 0 on the files backend (test).
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
