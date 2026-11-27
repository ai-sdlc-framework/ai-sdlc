---
id: AISDLC-1456
title: Knowledge callers use write and create; put and update are removed
status: In Progress
priority: high
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1455
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/promote.ts
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/knowledge/ingest-sources.ts
  - pipeline-cli/src/knowledge/data-room.ts
  - pipeline-cli/src/cli/context.ts
---

## Description

**Five-step review (requirements first).**
1. Question: DEC-0443 option a (operator, 2026-11-27): shape B replaces the sync `put`/`update` contract. AISDLC-1455 adds `write`/`create`; this task moves the callers and removes the old methods so there is one write path, which is why the operator chose a over the additive option.
2. Delete: `KnowledgeStore.put`, `KnowledgeStore.update` and `PutResult` (`knowledge-store.ts:56-74`) and their files-backend implementations.
3. Simplify: move the 10 non-test write sites (re-grep before editing): `put` at `cli/context.ts:385`, `ingest-memory.ts:104`, `data-room.ts:122`, `ingest-sources.ts:271` (re-ingest of an existing entry is `write` with `reingest`, a new one is `create`; keep the `.created` counter); `update` at `human.ts:25` (confirm), `:64` (correct), `:97` (supersede, now one `write` call), `promote.ts:208` (promote), `:239` (reobserve), `:265` (refute). Each awaits its result; the `cli-context` subcommands that reach them become async. Each CLI command prints the `status` and exits non-zero on `rejected`; `proposed` prints "queued as a proposal", never "done".
   Release note (breaking change to the 0.45.0 `KnowledgeStore` interface): no `!` and no `BREAKING CHANGE` footer (AISDLC-1432); put it in the PR body: "a registered knowledge backend implements async `write`/`create` instead of `put`/`update`".
4. Accelerate: none.
5. Automate: the files backend resolves `write`/`create` asynchronously, so an un-awaited call in a caller fails that caller's existing test.

## Acceptance Criteria
- [ ] #1 `put`, `update` and `PutResult` no longer exist; `grep -rn "\.put(\|\.update(" pipeline-cli/src/knowledge pipeline-cli/src/cli/context.ts` shows no store call.
- [ ] #2 All 10 sites await `write` or `create`; supersede is one call.
- [ ] #3 CLI commands print the result status; `rejected` exits non-zero; `proposed` is reported as queued (tests).
- [ ] #4 Existing knowledge tests pass unchanged in behaviour for the files backend.
- [ ] #5 PR body carries the release note; the commit has no `!` or `BREAKING CHANGE` footer.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
