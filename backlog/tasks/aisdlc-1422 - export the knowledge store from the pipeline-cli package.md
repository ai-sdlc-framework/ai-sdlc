---
id: AISDLC-1422
title: Export the knowledge store and backend registry from the pipeline-cli package
status: To Do
priority: high
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1421
references:
  - pipeline-cli/package.json
  - pipeline-cli/src/knowledge/knowledge-store.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the enterprise package for ENT-15 (ai-sdlc-enterprise RFC-0002 OQ-R6) has to type-check against the `KnowledgeStore` interface and the registry from AISDLC-1418 and AISDLC-1421, from a published `@ai-sdlc/pipeline-cli`. Today the package `exports` map (`pipeline-cli/package.json`) has no knowledge subpath, so the seam cannot be imported once it is released. Requested by the operator on 2026-11-26, together with a release.
2. Delete: none.
3. Simplify: add one subpath, `./knowledge`, pointing at a small barrel. The barrel exports only the seam's public surface: the `KnowledgeStore` type, the `KnowledgeEntry`/entry field types it uses, `registerKnowledgeBackend`, `openKnowledgeStore`, `KnowledgeBackendError`, the `knowledge-log` event type, and the type of the argument passed to `registerKnowledgeBackends(registry)`. It exports no internals (ingest, promote, retrieval).
4. Accelerate: none.
5. Automate: none added.

## Acceptance Criteria
- [ ] #1 `pipeline-cli/package.json` `exports` has `./knowledge` with `types` and `import` entries, following the existing subpaths.
- [ ] #2 A test imports `@ai-sdlc/pipeline-cli/knowledge` by package name from the built `dist` (or resolves it with the package's own `exports`), and asserts that the listed names are exported and that no ingest, promote or retrieval symbol is.
- [ ] #3 `pnpm pack --dry-run` in `pipeline-cli` lists the barrel's `.js` and `.d.ts` files.
- [ ] #4 `pnpm dark-code:check` passes with no growth in the baseline. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
