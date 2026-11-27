---
id: AISDLC-1435
title: A knowledge backend may supply the ontology
status: In Progress
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1432
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/ontology.ts
  - pipeline-cli/src/knowledge/store.ts
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/cli/context.ts
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, item 10) on 2026-11-26; operator ruled 2026-11-26 through the decision rubric (decision record filing; cite as 'the item-10 decision record'). `loadOntology(trackedRootAbs)` (`ontology.ts:51`) reads `<trackedRoot>/ontology.yaml`, so a remote backend cannot supply a shared ontology; each clone would need its own file. Callers: `cli/context.ts:90`, `:376`, `:408`; `ingest-memory.ts:177`; `store.ts:34`.
2. Delete: the direct `loadOntology` calls outside the store seam.
3. Simplify: add optional `ontology?(): Ontology` to `KnowledgeStore`. A backend without it, including `files`, reads `<trackedRoot>/ontology.yaml` exactly as `loadOntology` does today (the default is replaced wholesale when the file exists, `ontology.ts:51-54`, unchanged). One helper returns `store.ontology?.() ?? loadOntology(trackedAbs)` (same `{ ontology, errors }` shape); the callers above go through it (re-grep; `store.ts:34` runs before the store is opened at `:41`, so open first). Needs AISDLC-1432 so the store opens with `projectRoot` and its options. Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment; the change is additive to the DEC-0427 seam. Write interface shape (OQ-A: async writes) is undecided; this task changes no `put`/`update` signature and does not make any write sync or async.
4. Accelerate: none.
5. Automate: tests (AC #1 to #3).

## Acceptance Criteria
- [ ] #1 `KnowledgeStore.ontology?(): Ontology` is optional; a registered test backend that supplies one is used by `validateKnowledge`, `ingest-memory` and the `cli-context` commands.
- [ ] #2 `files` and a backend without `ontology` behave byte-identically to today, including the whole-default replacement when `ontology.yaml` exists and the malformed-file errors; existing ontology tests pass unchanged.
- [ ] #3 No `loadOntology` caller outside the helper remains (grep in the PR body); no `put`/`update` signature changes.
- [ ] #4 `docs/operations/knowledge-store.md` (Ontology section) documents the hook.
- [ ] #5 Targeted `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/knowledge/knowledge.test.ts src/knowledge/knowledge-backend.test.ts src/knowledge/ingest-memory.test.ts` and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
