---
id: AISDLC-1459
title: Knowledge backend optional sync() and status(), with cli-context sync and status
status: Done
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
- [x] #1 Optional `sync`/`status` on `KnowledgeStore`, documented; files backend unchanged.
- [x] #2 `cli-context sync` runs sync then `rebuildIndex` and writes the stamp file (time, counts, error); a sync error is recorded and exits non-zero (tests).
- [x] #3 `cli-context status` prints queued, rejected, last sync time and last error (test).
- [x] #4 Both commands report `supported:false` and exit 0 on the files backend (test).
- [x] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

Added optional sync() and status() methods to KnowledgeStore, with the files backend unchanged. New cli-context sync runs sync() then rebuildIndex and records the outcome in .ai-sdlc/state/knowledge-sync.json; a failed sync is recorded and exits non-zero. New cli-context status prints status() merged with that file. Both commands print supported:false and exit 0 on a backend without the method.

## Changes

- pipeline-cli/src/knowledge/knowledge-store.ts
- pipeline-cli/src/knowledge/sync.ts
- pipeline-cli/src/knowledge/sync.test.ts
- pipeline-cli/src/cli/context.ts
- pipeline-cli/src/cli/context.test.ts
- docs/operations/knowledge-store.md
- backlog/tasks/AISDLC-1459 - knowledge backend optional sync and status with cli-context commands.md

## Design decisions

I put the stamp file at .ai-sdlc/state/knowledge-sync.json because .ai-sdlc/state/ is already in the runtime gitignore list, so no gitignore change was needed; AISDLC-1460 should read that path. In cli-context status, the stamp's time and error take precedence over the backend's own lastSyncAt and lastError when a CLI sync has run. A status() that throws prints {ok:false,supported:true,error} and exits 1. The rebase onto AISDLC-1455 (#3134) hit a mechanical conflict in the KnowledgeStore interface: I placed the new optional methods after write() and added create and write to the test stub. The full pnpm test passed before the rebase. After the rebase I re-ran build, lint, format:check and the pipeline-cli knowledge and context tests (269 passed), not the full suite. During verification I mistakenly wrote one test log outside the worktree and deleted it right away.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (error: entry 'nope' not found)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 2 reviews approved (harness: correctness-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
