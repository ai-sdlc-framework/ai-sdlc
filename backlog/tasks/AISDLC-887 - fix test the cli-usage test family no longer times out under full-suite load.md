---
id: AISDLC-887
title: 'fix(test): the cli-usage test family no longer times out under full-suite load'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [test, flaky, velocity]
dependencies: []
references:
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - pipeline-cli/src/cli/usage-views.test.ts
  - pipeline-cli/src/cli/usage.test.ts
  - pipeline-cli/src/usage/ingest-claude.test.ts
  - pipeline-cli/src/usage/codex-ingester.test.ts
  - ai-sdlc-plugin/hooks/usage-ingest.test.mjs
  - pipeline-cli/vitest.config.ts
  - vitest.shared.mjs
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Context

Four times on 2026-10-14 (tasks 729, 833, 838 and 872) `pnpm test` in pipeline-cli failed only on vitest 5000 ms timeouts: `bin-invocation.test.ts` ('ingest --json'), `usage-views.test.ts` ('live after ingest'), the cli-usage ingest tests, and the plugin usage-ingest test. Each test passes when run alone. Each failure cost a DEC-0210 waiver (`verifications.test=skipped` with evidence) and a resume round.

Likely causes for the developer to confirm by measurement (do not assume):

1. Each test spawns the built CLI with `node bin/...` (`spawn` / `spawnSync` in `bin-invocation.test.ts` and `usage-views.test.ts`); a cold Node start under parallel vitest forks (`pool: 'forks'`, `vitest.shared.mjs`) is slow when the machine is loaded.
2. Shared temp directories or a shared usage database path between tests of the family.
3. No per-test timeout override, so the default 5000 ms applies to a test that does a spawn plus an ingest.

## Fix

**Five-step review (requirements first).** Requirement questioned: "these tests must spawn the built CLI as a child process". Most only need the command function's behaviour; only the bin-invocation smoke checks need a real process. Deleted: the redundant spawns in the ingest and live-view tests (call the exported command function in-process). Simplified: one spawn-based smoke test per binary instead of one per scenario; one temp dir per test. Accelerated: the family finishes well under the default timeout, so no test needs a longer one. Automated last: a config entry that scopes a pool/timeout to the remaining spawn-based tests, so the next such test cannot reintroduce the flake silently.

1. Measure first: run the full `pnpm test` under load and record, per failing test, whether time goes to process cold start, temp-dir or database contention, or the ingest itself. State the measured cause in the PR body.
2. Choose the smallest fix the measurement supports, in this order: (a) run the CLI in-process via the exported command function instead of spawning; (b) keep spawn-based tests but scope a dedicated vitest project/pool and `testTimeout` to that family in `pipeline-cli/vitest.config.ts`; (c) a sequential `describe` for the ingest family. Never raise the global `testTimeout` in `vitest.shared.mjs`.
3. Give each test its own temp directory (and usage database path), created in `beforeEach` and removed in `afterEach`.
4. Apply the same treatment to `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` (a `node --test` file): one spawn per describe or an in-process call, or a per-test timeout scoped to that file.

## Acceptance Criteria

- [ ] `pnpm test` from the repo root passes 5 consecutive runs locally with no timeout in `bin-invocation.test.ts`, `usage-views.test.ts`, `usage.test.ts`, `ingest-claude.test.ts`, `codex-ingester.test.ts` or `usage-ingest.test.mjs`.
- [ ] No test in the family spawns the CLI more than once per describe, or the spawn-based ones run in a pool/project configured in `pipeline-cli/vitest.config.ts` with a timeout scoped to that family only. The global timeout in `vitest.shared.mjs` is unchanged.
- [ ] The DEC-0210 waiver is not needed for this family afterwards; the task PR body states which cause was measured (cold start, shared state, or ingest cost) and the before/after duration of the slowest test.
- [ ] Every test in the family uses its own temp directory; no two tests share a path.

## Tests

The existing tests themselves, after the change, plus a config test (or a timing assertion on the slowest in-process test) that fails if the family's pool/timeout scoping is removed. `pnpm build && pnpm test && pnpm lint && pnpm format:check`.

## Out of scope

Other flaky tests (the `*.flaky.test.ts` set stays excluded); changing the global vitest timeout or worker count.
