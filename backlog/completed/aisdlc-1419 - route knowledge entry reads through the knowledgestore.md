---
id: AISDLC-1419
title: Route every knowledge entry read through the KnowledgeStore
status: Done
priority: high
labels:
  - pipeline-cli
  - knowledge
  - refactor
  - enterprise
dependencies:
  - AISDLC-1418
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/knowledge/store.ts
  - pipeline-cli/src/knowledge/scope-check.ts
  - pipeline-cli/src/knowledge/retrieval/service.ts
  - pipeline-cli/src/knowledge/eval/golden.ts
  - pipeline-cli/src/cli/context.ts
  - pipeline-cli/src/dor/decision-point.ts
---

## Description

**Five-step review (requirements first).**
1. Question: this is the second half of the enterprise seam (RFC-0002 ENT-15/ENT-16). AISDLC-1418 routes the writes. This task makes the store the only reader, so another implementation would see every access. The behaviour does not change, and the entries on disk stay the source of truth (RFC-0053 OQ-2).
2. Delete: `readEntries(dir)` (`store.ts:39-46`) stops being a public directory-path API. Callers ask the store for `list(scope)`.
3. Simplify: add `list(scope: 'tracked' | 'protected' | 'all')` to `KnowledgeStore`. Also add `listRaw(scope)`, which returns each file's parse result or parse error, because `validateKnowledge` and `checkKnowledgeScope` must report unparseable files.
4. Accelerate: none.
5. Automate: none added.

**Readers to route.**
- `store.ts`: `validateKnowledge` :48-110 and `findProtectedCitations` :113-129.
- `scope-check.ts`: `checkKnowledgeScope` :58. `checkKnowledgeScopeRange` reads through git and stays as it is.
- `retrieval/service.ts`: `rebuildIndex` :34-35 and :115-116.
- `eval/golden.ts`: `liveEntryIds` :78.
- `cli/context.ts`: synthesize :255, coverage :541, export :627.
- `dor/decision-point.ts`: :110-111.

**Out of scope.**
- `ai-sdlc-plugin/scripts/lint-controls.mjs` :16-30 is a plain `.mjs` script that hardcodes `.ai-sdlc/knowledge` and cannot import TypeScript. File a separate task if it matters.
- `push-guard.ts` `hasKnowledgeStore` and doctor's existence check only test whether a root exists. They are not entry reads.
- `loadOntology`.

## Acceptance Criteria
- [ ] #1 `KnowledgeStore` gains `list(scope)` and `listRaw(scope)`, implemented by `FilesKnowledgeStore`.
- [ ] #2 None of the readers listed above calls `readEntries`, `listMarkdown` or `node:fs` on an entry path. `readEntries` is either removed or kept only as the files implementation's private helper.
- [ ] #3 Behaviour is unchanged. `knowledge.test.ts`, `retrieval/retrieval.test.ts`, `eval/eval.test.ts`, `push-guard.test.ts`, `cli/context.test.ts` and the DoR decision-point tests pass without editing their assertions. `validateKnowledge` still reports a malformed file with its path.
- [ ] #4 `pnpm dark-code:check` passes with no growth in the baseline. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
