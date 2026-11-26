---
id: AISDLC-1425
title: A data-room capture writes an entry that cli-context validate rejects
status: To Do
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - bug
dependencies: []
references:
  - pipeline-cli/src/knowledge/data-room.ts
  - pipeline-cli/src/knowledge/data-room.test.ts
  - pipeline-cli/src/knowledge/store.ts
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/knowledge/ontology.ts
  - pipeline-cli/src/cli/context.ts
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
---

## Description

**Five-step review (requirements first).**
1. Question: reported by the ai-sdlc-enterprise planner on 2026-11-26 as B2 against 0.45.0 (`data-room.js:91`, the `put` call in `captureFact`). Confirmed. `captureFact` (`pipeline-cli/src/knowledge/data-room.ts:96-122`) writes with `{ scope: 'protected', path: \`${input.id}.md\` }` (`:117-120`), the top of the protected root. `validateKnowledge` requires `<root>/<trunk>/<topic>.md` and reports `path must be <root>/memory/<topic>.md (trunk directory mismatch)` (`store.ts:72-79`). The trunk defaults to `memory` (`data-room.ts:103`) and `cli-context capture` has no `--trunk` option (`cli/context.ts:639-660`), so every CLI capture fails `validate`. The existing test checks fields with `validateEntryFields` only (`data-room.test.ts:80-88`), never the layout. RFC-0053 OQ-7 requires captured facts "under the full schema, hygiene and decay" (`:472`).
2. Delete: the explicit flat `path`, so the store default `<trunk>/<id>.md` applies (`knowledge-store.ts:177`).
3. Simplify: that alone moves captures into `protected/memory/`, where the memory re-ingest sweep marks `status: superseded` every entry whose file name is not a note in the memory folder (`ingest-memory.ts:148-151`, the loop over `store.list({ scope: 'protected', trunk: MEMORY_TRUNK })`). Planner decision: captured facts must pass validate and must not be marked superseded by the memory sweep. Evidence for the pick: option (a), a dedicated capture trunk, is out. `loadOntology` replaces the default wholesale when an adopter has `ontology.yaml` (`ontology.ts:56-60`, and `parseOntology` requires all four lists), and `validateEntryFields` rejects a trunk not in that list (`entry.ts:108-121`). A new trunk in `DEFAULT_ONTOLOGY` would therefore make capture fail for every adopter with their own ontology until they edit it. So take option (b): captures stay in the `memory` trunk at `memory/<id>.md`, and the sweep skips entries whose `source` starts with `data-room:` (captures set `source: data-room:<doc>`, `data-room.ts:110`; memory notes use a file path, `ingest-memory.ts:citation`). If the sweep also finds a memory note whose id equals a captured id, the ingest keeps writing that note as today (same file name); say so in the PR body.
4. Accelerate: none.
5. Automate: an end-to-end test, capture then `validateKnowledge`, and capture then re-ingest.

## Acceptance Criteria
- [ ] #1 A test runs `captureFact` through the CLI's code path in a temporary project, then `validateKnowledge(projectDir)`, and gets zero errors. It fails on main with the trunk-directory error.
- [ ] #2 The captured file sits at `<protectedRoot>/<trunk>/<id>.md` and `captureFact` returns that path (the `captured <file>` CLI output names it).
- [ ] #3 After a capture, `ingestMemoryForProject` with a memory folder that does not contain the captured id leaves the entry without `status: superseded`, while a memory-ingested entry no longer in the folder is still superseded.
- [ ] #4 `validateKnowledge`, its layout rule (`store.ts:72-79`) and `DEFAULT_ONTOLOGY` are unchanged.
- [ ] #5 The PR body gives adopters the shell command that moves existing captures from the top of the protected root into `memory/` (the root is git-ignored, so a plain `mv`).
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
