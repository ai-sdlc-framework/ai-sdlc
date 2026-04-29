---
id: AISDLC-80
title: >-
  cli-sdlc complexity convention detector: false positives on React naming,
  multi-test-dir, Vite path aliases
status: Done
assignee: []
created_date: '2026-04-29 01:53'
updated_date: '2026-04-29 06:55'
labels:
  - bug
  - complexity-detector
  - user-feedback
  - alex
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

User feedback (Alex / neuralcartographer, 2026-04-28). The complexity detector ran against his repo and produced three false-positive convention warnings. Hotspot detection itself was excellent — re-discovered all 5 of his sacred files independently — so the FP problem is isolated to convention scanning.

## Three false positives

### 1. Naming flagged as "mixed"

Reality: PascalCase for components, camelCase for hooks/stores/utils, ALL-CAPS for constants. This is React community convention, NOT inconsistency.

Examples in Alex's repo: `useSimilarity.js` (hook, camelCase) + `SimpleGrid.jsx` (component, PascalCase) + `gameplayStore.js` (store, camelCase) + `EventBus.js` (singleton class, PascalCase).

**Fix**: detect "React mode" by presence of `react`/`react-dom` in `package.json`. In React mode, treat the (PascalCase for `.jsx`/`.tsx` components) + (camelCase for everything else) pattern as the EXPECTED convention. Only flag deviations FROM this pattern, not the pattern itself.

### 2. Testing reported as "test/" — picked one path, missed the others

Repo has THREE distinct test directories: `tests/`, `tests/e2e/`, `src/tests/`. Detector reports just one — likely picked the first match in some ordering.

**Fix**: scan for ALL of: `__tests__/`, `tests/`, `test/`, `src/tests/`, `e2e/`, `cypress/`, `*.test.{ts,js,tsx,jsx}`, `*.spec.{ts,js,tsx,jsx}` (collocated). Report the FULL set as "Testing strategy: collocated + tests/ + tests/e2e/" rather than picking one.

### 3. Imports reported as "Relative imports, barrel re-exports via index.ts" — missed Vite path aliases

Repo uses `@systems`, `@engine`, `@components`, `@hooks`, `@utils` aliases defined in `vite.config.js`. Detector parsed import statements but didn't read `vite.config.js`'s `resolve.alias` map.

**Fix**: detect Vite (`vite.config.{js,ts}`), TypeScript path aliases (`tsconfig.json` `compilerOptions.paths`), webpack aliases, jsconfig.json, and treat alias-prefixed imports (`@foo/`) as a separate category. Report as "Imports: Vite aliases (@systems, @engine, ...) + relative within modules" or similar.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Naming detector recognizes "React mode" via `package.json` `dependencies.react`. In React mode, the dual PascalCase/camelCase pattern is treated as the convention; only deviations from this pattern are flagged.
2. Testing detector enumerates ALL test directory patterns + collocated `*.test.*` / `*.spec.*` files. Reports the complete set, not the first match.
3. Imports detector reads `vite.config.{js,ts}`, `tsconfig.json`, `jsconfig.json`, and `webpack.config.*` to extract path aliases. Alias-prefixed imports are categorized separately and surfaced in the report.
4. Regression tests: each fix has at least one fixture repo (or synthetic project) that exercises the false-positive case and asserts the corrected behavior.
5. Re-run the detector against Alex's repo after fix (or a fixture mirroring it) — all three false positives gone.
6. CHANGELOG entry under the package owning the complexity detector
7. All new code: 80%+ patch coverage, build/test/lint/format clean

## Out of scope

- Adding new convention categories beyond naming/testing/imports
- React Server Components heuristics
- TS-specific monorepo aliasing (project references)
- Generic "framework mode" beyond React (Vue, Svelte, etc — file follow-ups)

## References

- User report (Alex Kline / neuralcartographer, 2026-04-28)
- The complexity detector source (likely under `cli-sdlc` or `orchestrator/src/analysis/`)
- React naming conventions: PascalCase components, camelCase hooks/utils, ALL_CAPS constants
- Vite resolve.alias docs
- TypeScript paths docs
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Naming detector recognizes React mode via `package.json` `dependencies.react`; in React mode the dual PascalCase-for-components / camelCase-for-rest pattern is treated as the expected convention
- [x] #2 Testing detector enumerates ALL test directory patterns (`__tests__/`, `tests/`, `tests/e2e/`, `src/tests/`, etc.) plus collocated `*.test.*` and `*.spec.*` files; reports the complete set
- [x] #3 Imports detector parses `vite.config.{js,ts}`, `tsconfig.json` `compilerOptions.paths`, `jsconfig.json`, and `webpack.config.*` to extract path aliases; alias-prefixed imports are categorized and surfaced separately
- [x] #4 Regression tests: each fix has a fixture (or synthetic project) exercising the FP case + asserting the corrected behavior
- [x] #5 Re-run against Alex's repo (or a mirroring fixture) shows all three false positives gone
- [x] #6 CHANGELOG entry under the owning package
- [x] #7 All new code: 80%+ patch coverage; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Eliminated 3 false-positive convention warnings from Alex Kline's React/Vite repo:

1. **Naming**: detect React mode via `package.json.dependencies.react`. PascalCase for `.jsx`/`.tsx` + camelCase for `.js`/`.ts` is now the expected pattern, not flagged as "mixed".
2. **Testing**: enumerate ALL test directories (`__tests__/`, `tests/`, `test/`, `src/tests/`, `e2e/`, `cypress/`, `tests/e2e/`, `tests/integration/`, `tests/unit/`) plus collocated `*.test.*` / `*.spec.*`. Reports complete set, not first match.
3. **Imports**: parse path aliases from `vite.config.{js,ts,mjs,cjs}`, `tsconfig.json` `compilerOptions.paths` (with comment + trailing-comma tolerance), `jsconfig.json`, and `webpack.config.*`. Alias-prefixed imports categorized separately.

## Changes
- `orchestrator/src/analysis/convention-detector.ts`: 3 fixes + new helpers (`detectReactProject`, `loadProjectAliases`, `parseTsConfigAliases`, `parseViteOrWebpackAliases`, `enumerateTestLocations`). `detectConventions` is now async and accepts optional `{ repoPath }`.
- `orchestrator/src/analysis/analyzer.ts`: awaits the now-async `detectConventions`, threads `repoPath` through.
- `orchestrator/src/analysis/convention-detector.test.ts`: 32 tests including a synthetic React/Vite fixture mirroring Alex's repo that asserts all 3 FPs are gone.
- `orchestrator/src/analysis/index.ts` + `orchestrator/src/index.ts`: barrel exports for new helpers.
- `orchestrator/CHANGELOG.md`: entry.

## Design decisions
- **Async migration with optional `repoPath`**: legacy file-only signature still works (used by some tests). Production caller (`analyzer.ts`) passes the new option through.
- **Text-only parsing of JS configs**: vite/webpack configs are READ as text and matched via regex — no `eval`, no `import()`, no `require()`. Bounded regex (non-greedy or negated character classes only), no DoS risk.
- **Filesystem reads bounded to 10 hardcoded filenames** under `repoPath`. No path traversal possible.

## Verification
- `pnpm build` — clean
- `pnpm test` — 4849 tests across all packages, all green (orchestrator 2764, +sibling packages)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 3 minor + 3 suggestion; test: 1 minor + 3 suggestion; security: 0)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- Reviewer suggestions (deferrable): Cypress regex omits `.mjs/.cjs` extensions; `tests/setup.js` and similar non-test helpers caught by broad `tests/*.{js,ts}` regex (over-inclusion tradeoff); vite alias regex stops at first `}` so nested-object alias values get truncated; `loadProjectAliases` doesn't follow tsconfig `extends` (monorepo base configs); React detection only checks `react` (not `preact`/`solid-js`); long alias lists could truncate with `+N more` for readability; alias precedence edge case lacks dedicated test; vite/webpack `.ts/.mjs/.cjs` config extensions exercised only via `.js` fixture; `stripJsonComments` string-literal preservation not directly tested.
<!-- SECTION:FINAL_SUMMARY:END -->
