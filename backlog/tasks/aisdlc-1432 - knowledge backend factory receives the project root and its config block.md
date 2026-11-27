---
id: AISDLC-1432
title: Knowledge backend factory receives the project root and its config block
status: In Progress
priority: high
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies: []
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/config.ts
  - pipeline-cli/src/knowledge/ingest-sources.ts
  - pipeline-cli/src/knowledge/ingest-memory.ts
  - pipeline-cli/src/knowledge/promote.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/data-room.ts
  - pipeline-cli/src/cli/context.ts
  - pipeline-cli/src/knowledge/knowledge-backend.test.ts
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, item 6) on 2026-11-26; operator ruled 2026-11-26 through the decision rubric (decision record filing; cite as 'the item-6 decision record'). A registered backend gets `(cfg, projectRoot)` (`KnowledgeBackendFactory`, `knowledge-store.ts:237-240`) but no backend-specific settings, so a remote backend has nowhere to read its endpoint or credentials reference from. And `projectRoot` is not reliably passed: these `openKnowledgeStore` calls omit it, so a relative root and `backendModule` resolve against `process.cwd()` (`knowledge-store.ts:335`): `ingest-sources.ts:245`, `ingest-memory.ts:117`, `promote.ts:180`, `:239`, `:265`, `human.ts:23`, `:50`, `:74`, `data-room.ts:117`, `cli/context.ts:383`, and `cli/context.ts:572` (not in the brief; found by re-grep). Calls that already pass it: `context.ts:124`, `:274`, `:669`, `store.ts:41`, `:95`, `scope-check.ts:54`, `dor/decision-point.ts:109`, `eval/golden.ts:77`, `retrieval/service.ts:34`, `:113`.
2. Delete: the optional `projectRoot?` parameter of `openKnowledgeStore` for non-files backends, i.e. a backend can no longer be opened without knowing the project.
3. Simplify: the factory type becomes `(cfg, { projectRoot, options }) => KnowledgeStore`, where `options` is the raw `knowledge.<backend>` block of `.ai-sdlc/context.yaml` (for `backend: remote`, the `knowledge.remote` mapping). `loadKnowledgeConfig` (`knowledge/config.ts:36`) carries it through unvalidated as one new field (`backendOptions: unknown | null`, `null` when absent); the backend owns validation. `backendSelection` (`knowledge-store.ts:97`) carries it so call sites that spread the selection need no other change. `files` receives none and ignores it. Every `openKnowledgeStore` call passes `projectRoot`; re-grep before editing. Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment; the change is additive to the DEC-0427 seam. Write interface shape (OQ-A: async writes) is undecided; this task changes no `put`/`update` signature and does not make any write sync or async.
   Release note (breaking change to the 0.45.0 factory type): the commit must NOT use `!` or a `BREAKING CHANGE` footer. pipeline-cli is in a release-please linked-versions group without bump-minor-pre-major, so a `!` could cut 1.0.0 across the group. Put the release note in the PR body instead: "the registered backend factory is now `(cfg, { projectRoot, options })`; replace `(cfg, projectRoot)`".
   Overlap with AISDLC-1426: it also passes `projectDir` in `ingestMemoryTrunk` (`ingest-memory.ts:117`). No dependency; whichever lands second rebases onto the other.
4. Accelerate: none.
5. Automate: tests (AC #1 to #4).

## Acceptance Criteria
- [ ] #1 `KnowledgeBackendFactory` is `(cfg, { projectRoot, options })`; a test in `knowledge-backend.test.ts` registers a factory and asserts it receives the project root and the exact `knowledge.<backend>` mapping from a written `context.yaml` (unvalidated: unknown keys and nested values arrive unchanged), and `null`/undefined options when the block is absent.
- [ ] #2 `loadKnowledgeConfig` carries the block through; the `files` store is constructed with no options and the files tests pass unchanged. No `put`/`update` signature or write sync/async-ness changes.
- [ ] #3 Every `openKnowledgeStore` call site passes `projectRoot` (the sites listed in Question plus any a re-grep finds); a test run from a different working directory shows a registered backend receives the project root for `ingest`, `promote`, `human` and `data-room` operations.
- [ ] #4 `docs/operations/knowledge-store.md` documents the new factory signature, the options block and the release note; the commit message carries no `!` and no `BREAKING CHANGE` footer.
- [ ] #5 Targeted `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/knowledge/knowledge-backend.test.ts src/knowledge/ingest-sources.test.ts src/knowledge/promote.test.ts src/knowledge/human.test.ts src/knowledge/data-room.test.ts` and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
