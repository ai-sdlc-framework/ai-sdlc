---
id: AISDLC-1426
title: Memory re-ingest after a dream swap is skipped on a non-files knowledge backend
status: To Do
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - bug
dependencies: []
references:
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/knowledge/ingest-memory.test.ts
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/cli/memory-dream.ts
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
---

## Description

**Five-step review (requirements first).**
1. Question: reported by the ai-sdlc-enterprise planner on 2026-11-26 as B3 against 0.45.0 (`ingest-memory.js:151`). Confirmed. `reingestAfterSwap` (`pipeline-cli/src/knowledge/ingest-memory.ts:186-195`) runs under the dream lock on apply and undo (`cli/memory-dream.ts:122`, `:140`) and returns early on `!existsSync(join(root, MEMORY_TRUNK))` (`:192`), a local-disk probe. Under a registered non-files backend (DEC-0427) the memory entries live in the backend, the directory never exists, and the swapped folder is never re-ingested. RFC-0053 OQ-6 requires the swap to trigger a re-ingest (`spec/rfcs/RFC-0053-just-in-time-context-engine.md:464`). The opt-in (do nothing for a project that never ingested memory) is right and stays. A second defect in the same path: `ingestMemoryTrunk` opens the store with no `projectRoot` (`ingest-memory.ts:117-121`), so `knowledge.backendModule` resolves from `process.cwd()` (`knowledge-store.ts:335`, `projectRoot ?? process.cwd()`) and a relative `protectedRoot` resolves against the working directory. `memory-dream` passes `--project-dir`, so a run from another directory loads the wrong module or none.
2. Delete: the `existsSync` probe of the backend's storage.
3. Simplify: planner decision: ask the store, not `existsSync`, whether the memory trunk has entries. Open it with the project's backend selection, protected root and `projectDir` (as `ingestMemoryForProject` does, plus the project root) and test `store.list({ scope: 'protected', trunk: MEMORY_TRUNK }).length > 0`. Pass `projectDir` to the store opened in `ingestMemoryTrunk` too (`MemoryIngestOptions` already carries `projectDir`). For the files backend this differs from today only when `memory/` exists but is empty (the files store returns `[]` for a missing trunk); the PR says so. If the backend cannot be opened, the hook raises `KnowledgeBackendError` (fail closed) rather than skipping in silence.
4. Accelerate: none.
5. Automate: tests (AC #1 to #4).

## Acceptance Criteria
- [ ] #1 A test registers an in-memory backend (`registerKnowledgeBackend`, as `knowledge-backend.test.ts` does) that holds one protected `memory` entry. With no `<protectedRoot>/memory` directory on disk, `reingestAfterSwap(projectDir)(liveDir)` writes the notes of `liveDir` through that backend. It fails on main.
- [ ] #2 With the same backend holding no memory entries, the hook writes nothing.
- [ ] #3 An unregistered backend makes the hook throw `KnowledgeBackendError`. No filesystem probe decides whether memory was ingested.
- [ ] #4 `ingestMemoryTrunk` opens the store with `projectDir`; a test with a `backendModule` run from a different working directory resolves it from the project.
- [ ] #5 The existing files-backend `reingestAfterSwap` tests (`ingest-memory.test.ts:86-113`) pass unchanged.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
