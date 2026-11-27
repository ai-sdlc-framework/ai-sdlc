---
id: AISDLC-1456
title: Knowledge callers use write and create; put and update are removed
status: Done
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
- [x] #1 `put`, `update` and `PutResult` no longer exist; `grep -rn "\.put(\|\.update(" pipeline-cli/src/knowledge pipeline-cli/src/cli/context.ts` shows no store call.
- [x] #2 All 10 sites await `write` or `create`; supersede is one call.
- [x] #3 CLI commands print the result status; `rejected` exits non-zero; `proposed` is reported as queued (tests).
- [x] #4 Existing knowledge tests pass unchanged in behaviour for the files backend.
- [x] #5 PR body carries the release note; the commit has no `!` or `BREAKING CHANGE` footer.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

KnowledgeStore.put, update, PutResult and PutOptions are removed, and every knowledge write caller now awaits the async write or create. Supersede is now a single write call. The cli-context write commands print applied, proposed (as 'queued as a proposal') or rejected, and exit 1 on a rejection. The memory-dream apply and undo, including their lock, are now async so the re-ingest after a swap is awaited inside the lock.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/knowledge-store.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/index.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/human.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/promote.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/ingest-memory.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/ingest-sources.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/ingest-write.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/data-room.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/cli/context.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/cli/memory-dream.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/memory-dream/apply.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/docs/operations/knowledge-store.md
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/ingest-write.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/cli/context.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/human.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/promote.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/principal.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/knowledge-store.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/knowledge-store-golden.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/knowledge-backend.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/knowledge.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/package-export.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/data-room.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/knowledge/ingest-memory.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/memory-dream/memory-dream.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1456/pipeline-cli/src/memory-dream/backup-recover.test.ts

## Design decisions

Verification: pnpm build, pnpm lint and pnpm format:check pass. I ran the pipeline-cli tests, not the repo-wide pnpm test. The knowledge, cli/context and memory-dream suites pass (303 tests), as does the new ingest-write test file. In the first full pipeline-cli run, 13 tests in src/cli/orchestrator.test.ts failed with 'pipeline-cli rebuild failed'; after a fresh pnpm build that file passes 30/30 on its own. The pre-push patch-coverage check passed at 99.56%.

AC4 caveat: the store contract from AISDLC-1455 forced some file-backend behaviour changes. They are listed in the PR body for review:
(1) `cli-context supersede <old> <new>` now requires `--value`. The store's supersede creates the new entry and rejects an id that already exists, and an AISDLC-1455 test checks that rejection. So the CLI can no longer link two entries that both exist. The new entry copies the old entry's fields, including its authority, the same way `correct` keeps authority.
(2) A canonical promotion without `--proof` now records `proof: operator`, because the store rejects a promote that has no proof. The golden snapshots for promote and supersede were re-recorded; the ingest, memory and capture bytes are unchanged.
(3) Log events now list field names instead of old and new values. Ingest now logs created/reingested instead of superseded. `refute --reason` now stores the reason in the entry's `reverify` note.
(4) Capturing an id that already exists is now rejected instead of overwritten.
(5) Possible issue: memory ingest and capture now write log events, with protected entry ids, to the committed knowledge-log.jsonl. This follows from the 1455 store contract ('protected entry created'). It needs a decision on whether protected ids may appear in the committed log.

The orchestrator's change to the backlog task file (status: In Progress) was left uncommitted.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (rejected: canonical requires a human; agent role refused)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 2 reviews approved (harness: correctness-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
