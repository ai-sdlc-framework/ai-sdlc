---
id: AISDLC-547
title: >-
  chore(deps): migrate vitest 3 → 4 across the workspace (supersedes Dependabot
  PR #897)
status: To Do
assignee: []
labels:
  - chore
  - dependencies
  - tooling
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - package.json
  - pipeline-cli/vitest.config.ts
  - orchestrator/vitest.config.ts
  - reference/vitest.config.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dependabot PR #897 (`vitest` 3.2.4 → 4.1.8) is **stuck** — it fails Build & Test + Coverage
because vitest 4 is a major with breaking config/API changes and the suite doesn't pass under
it as a drive-by bump. Operator chose fix-forward (2026-06-13). This task does the real
migration; **when it lands, close #897** (superseded).

Scope: **9 packages** pin `vitest: ^3.0.0` — `ai-sdlc-plugin/mcp-server`, `conformance/runner`,
`dashboard`, `dogfood`, `mcp-advisor`, `orchestrator`, `pipeline-cli`, `reference`,
`sdk-typescript` — each with its own `vitest.config.ts`. Plus `@vitest/coverage-v8` (coverage
provider) must move in lockstep with vitest 4.

**Migration work (implementer confirms against vitest 4 release notes / migration guide):**
- Bump `vitest` (and `@vitest/coverage-v8` / `@vitest/ui` if present) to `^4` in all 9 package
  manifests; regenerate the lockfile once, cleanly.
- Apply the vitest 4 config breaking-changes across the `vitest.config.ts` files — verify each
  against the official v4 migration guide (e.g. `deps.inline` → `server.deps.inline`,
  `environmentMatchGlobs` removal, `poolOptions`/`pool` defaults, coverage `provider`/`reporter`
  option renames, `workspace` → `projects` if used). Do NOT guess — read the guide and apply
  only what the configs actually use.
- Fix any test-API breakage surfaced by the run (mock/spy signature changes, `vi.*` deltas,
  fake-timers behavior). The de-flaked tests (AISDLC-533/518/503/504) must stay hermetic.
- The full suite must pass on vitest 4 with coverage gates intact (80% lines per package), and
  the existing CI workflows (`ai-sdlc-gate.yml` Build & Test + Coverage) green.

This is a dedicated migration, not a drive-by — expect iteration. Keep it to the vitest bump +
the config/API adaptations it forces; do NOT bundle unrelated changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 9 packages' `vitest` (and `@vitest/coverage-v8`/`@vitest/ui` where present) bumped to `^4`; lockfile regenerated cleanly; `pnpm install` clean
- [ ] #2 Each `vitest.config.ts` updated for the vitest 4 breaking changes it actually uses (verified against the v4 migration guide), no deprecated options remaining
- [ ] #3 `pnpm -r test` (or `pnpm test`) passes across the whole workspace on vitest 4; no test deleted/skipped to make it pass; hermeticity preserved
- [ ] #4 Coverage gates still pass (80% lines per package) under vitest 4's coverage provider; `pnpm lint && pnpm format:check` clean
- [ ] #5 PR body notes it supersedes Dependabot #897 so the operator closes that PR
<!-- AC:END -->
