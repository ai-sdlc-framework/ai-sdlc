---
id: AISDLC-692
title: >-
  RFC-0052 Stage 1: tree-sitter StructuralProvider (changed symbols, callers, callees, tests) and the trace probe's dependency query
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - rfc-0052
  - review
  - pipeline-cli
  - dependency
dependencies:
  - AISDLC-675
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - pipeline-cli/src/review-risk-map/structural.ts
  - pipeline-cli/src/review-risk-map/build.ts
  - pipeline-cli/src/review-risk-map/types.ts
  - pipeline-cli/package.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0052 Stage 1 needs, per changed file, the changed symbols, their callers and
callees, and the tests that exercise them. AISDLC-672 found that the two inputs the
RFC names are a protected-path gate and the backlog task graph, so it shipped the
`StructuralProvider` seam with a default that returns `unavailable`, which ranks every
hunk as high risk. AISDLC-675 has the same gap for the `trace` probe and refuses trace
probes until a code dependency query is wired.

Operator decision, 2026-10-03 (decision rubric, recorded in the Decision Catalog with
the DEC-0025 follow-up): the extractor is **tree-sitter with WASM grammars**, chosen
over the TypeScript compiler API (TypeScript and JavaScript only), a regex import graph
(no symbols or callers) and deferring to replay data. Reason: the framework is used by
adopters whose code is not all TypeScript, and this repository ships Python and Go
SDKs. Accepted tradeoff: callers are matched by name, not by type, so some callers are
false positives; that raises a hunk's risk rank, which is the safe direction.

## Conventions
- Design source: `spec/rfcs/RFC-0052-staged-review-pipeline.md`. Do not edit its Open
  Questions section.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- Tests never call a model or the network. Grammar files used in tests are loaded from
  the installed package, not downloaded.
- The developer agent never writes under `.ai-sdlc/`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`).

## Scope
1. **Dependency.** Add the tree-sitter WASM runtime and grammars for TypeScript (with
   TSX), JavaScript, Python and Go as runtime dependencies of `pipeline-cli`. Record in
   the PR body the added install size and each package's licence. A language with no
   grammar installed yields `unavailable` for that file, never an error.
2. **Provider.** A `StructuralProvider` implementation that, for a set of changed
   files and line ranges at a given commit, returns: the declarations whose range
   intersects a changed range (functions, methods, classes, exported constants); for
   each, callers and callees found by name within the tracked files of the same
   language; and test files that reference the symbol. File content is read from the
   git object at the given commit, tracked files only, the same rule AISDLC-675 applies
   to probe targets.
3. **Bounds.** Caps on files parsed, bytes per file, and results per symbol, each with a
   recorded truncation marker. A parse error or a cap makes that file's facts
   `unavailable` with a reason; it never throws out of the provider. Parsing runs with a
   wall-clock budget.
4. **Wiring.** `buildRiskMap` uses the provider when the caller supplies it; the
   default stays the `unavailable` provider, so behaviour is unchanged for a caller that
   passes nothing. The same provider backs the dependency query hook that the review
   executor (AISDLC-675) calls for `trace` probes: with it wired, a trace probe receives
   the callers and callees as fenced data and is no longer refused.
5. **Docs.** A short section in the staged-review operator doc, or a new file under
   `docs/operations/` when that doc does not exist yet, covering supported languages,
   name-matched callers and their limits, and how to add a grammar.

## Acceptance Criteria
- [x] For a TypeScript fixture, a changed function is reported with its callers and callees from other tracked fixture files, and a test file referencing it is listed.
- [x] The same holds for a Python fixture and a Go fixture.
- [x] A file in a language with no installed grammar yields `unavailable` with a reason and does not fail the risk map.
- [x] A file over the byte cap, a syntax error, and an exceeded wall-clock budget each yield `unavailable` with a distinct reason, asserted in tests.
- [x] An untracked or gitignored file is never read (fixture `.env` next to the sources).
- [x] `buildRiskMap` with the provider attaches structural facts to hunks; without it, output equals today's.
- [x] With the provider wired as the dependency query, a `trace` probe in the review executor is executed and its evidence contains the callers; with no query wired it is still refused.
- [x] The PR body lists added install size and licences.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added a tree-sitter (WASM) `StructuralProvider` for TypeScript/TSX, JavaScript, Python and Go. It reports changed declarations with name-matched callers, callees and referencing tests, read from tracked git objects at a commit. `buildRiskMap` uses it when supplied (default unchanged), and `createTreeSitterDependencyQuery` backs the trace-probe dependency query hook.

## Changes
- `pipeline-cli/src/review-risk-map/tree-sitter-provider.ts` (new): provider, caps, wall-clock budget, distinct unavailable reasons.
- `pipeline-cli/src/review-risk-map/tree-sitter-extract.ts` (new): declaration, call and test-reference extraction per language.
- `pipeline-cli/src/review-risk-map/tree-sitter-languages.ts` (new): grammar registry.
- `pipeline-cli/src/review-risk-map/tree-sitter-provider.test.ts` (new): fixtures for TS, Python, Go, untracked `.env`, caps and executor wiring.
- `pipeline-cli/src/review-risk-map/index.ts`, `pipeline-cli/package.json`, `pnpm-lock.yaml` (modified): barrel export and two runtime dependencies.
- `docs/operations/staged-review-structural-provider.md` (new): languages, name-matched caller limits, adding a grammar.

## Design decisions
- **Git object reads**: `git ls-tree`, `git cat-file`, one `git grep -F -w`; untracked and ignored files are never listed or opened.
- **Reasons via `provider.report()`**: the risk-map schema has no reason field, so unavailable reasons and truncation markers live on the provider report; risk map JSON is unchanged.
- **web-tree-sitter pinned to 0.25.x**: 0.27.1 cannot load tree-sitter-wasms 0.1.13 grammars.

## Verification
- `pnpm build` — clean
- `pnpm test` — new tests pass (25); 14 failures in 4 files (tui app, use-terminal-dimensions, bin-invocation, verify-runtime) also fail identically on the main checkout (environmental, not from this change)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm dark-code:check` — clean
- Reviews: code-reviewer and security-reviewer approved (Codex reviewer unavailable on usage limit; Claude-native used)

## Follow-up
declined: ship only the five .wasm grammar files instead of all of tree-sitter-wasms (about 49 MB installed); share the grammar loader across queries; re-validate the commit as a full SHA in the provider constructor (security reviewer minor).
<!-- SECTION:FINAL_SUMMARY:END -->
