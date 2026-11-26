---
id: AISDLC-1427
title: pipeline-cli declares the Node version that loading an ES-module knowledge backend needs
status: In Progress
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - release
dependencies: []
references:
  - pipeline-cli/package.json
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/knowledge-backend.test.ts
  - package.json
  - .nvmrc
  - .github/workflows/ci.yml
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: requested by the ai-sdlc-enterprise planner on 2026-11-26 (item 12). `loadBackendModule` loads `knowledge.backendModule` with `createRequire(...)` then `req(req.resolve(spec))` (`pipeline-cli/src/knowledge/knowledge-store.ts:285-291`). For an ES-module backend that is `require(esm)`, which runs without a flag only from Node 20.19.0 and from 22.12.0; Node 22.0 to 22.11 need `--experimental-require-module`, so the reporter's `>=20.19` would admit them. Older Node fails closed with `KnowledgeBackendError ... failed to load` (`:292-297`) that is hard to read. No published package declares `engines`; only the private root `package.json` does (`node >=22.22.1`), and `.nvmrc` is 22.23.2. CI tests Node 22 only (`ci.yml:101`, `ai-sdlc-gate.yml:340`). The `ci.yml:98-100` comment says "engines.node ^22 across all packages", which is false. Other `createRequire` sites load CommonJS or only resolve (`hierarchy/lease-preflight.ts:87`, `orchestrator/src/state/store.ts:63`, `review-risk-map/tree-sitter-languages.ts:70`), so `pipeline-cli` is the only package that needs a floor. The backend-module tests use a CommonJS fixture (`knowledge-backend.test.ts:26-27`), so an ES-module backend is never tested.
2. Delete: the false `ci.yml:98-100` claim (rewrite it to match what lands).
3. Simplify: planner decision: pipeline-cli only gets `"engines": {"node": ">=22.12.0"}` (Node 20 is end-of-life; 22.0-22.11 cannot require ESM without a flag). Other packages are out of scope. Document the floor for an ES-module `backendModule` in `docs/operations/knowledge-store.md`.
4. Accelerate: none.
5. Automate: an ES-module fixture test, and a test that fails if the `engines.node` minimum drops below 22.12.0.

**Note for the planner, not in scope.** The `./knowledge` export in `pipeline-cli/package.json` has only an `import` condition, so `require('@ai-sdlc/pipeline-cli/knowledge')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. This matters only if the enterprise backend is CommonJS; confirm with the reporter.

## Acceptance Criteria
- [ ] #1 `pipeline-cli/package.json` declares `"engines": { "node": ">=22.12.0" }`. No other package's `engines` changes.
- [ ] #2 The `ci.yml` comment states the policy that is actually in the manifests.
- [ ] #3 A test in `knowledge-backend.test.ts` writes an ES-module backend fixture (`"type": "module"`, `export function registerKnowledgeBackends`) in a temporary project, selects it through `knowledge.backendModule`, and opens the store. It passes on the CI Node.
- [ ] #4 A test reads `pipeline-cli/package.json` and asserts `engines.node` has a minimum of at least 22.12.0.
- [ ] #5 `docs/operations/knowledge-store.md` states the Node floor for an ES-module `backendModule`.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
