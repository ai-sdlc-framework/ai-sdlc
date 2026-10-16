---
id: AISDLC-936
title: 'test: hierarchy.test.ts isolates AI_SDLC_WEBHOOK_SECRET from the shell environment'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, pipeline-cli, tests, velocity]
dependencies: []
references: [pipeline-cli/src/cli/hierarchy.test.ts, pipeline-cli/src/hierarchy/webhook.ts]
priority: high
dispatchable: true
---

## Description

Two tests in `pipeline-cli/src/cli/hierarchy.test.ts` ("status prints an empty roster as text and json", "webhook status and usage errors") assert `webhook: off (no secret)`. The `overrides()` helper does not set `env`, so the CLI falls through to `process.env`; in any shell that exports `AI_SDLC_WEBHOOK_SECRET` (the operator's shell since the RFC-0054 webhook switch on 2026-10-15) `webhookStatus` in `webhook.ts` returns `off (not running)` and both tests fail. Verified on `main` 9cb8ff009: the file fails with the variable set and passes under `env -u AI_SDLC_WEBHOOK_SECRET`. Every executor relaunched from such a shell fails `pnpm test` on every task (AISDLC-926 lost a round to it).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: whether the test may read the real process environment at all; it may not, the CLI already takes `env` through `HierarchyDeps` for this reason. 2. Deleted: nothing; the assertions are right. 3. Simplified: `overrides()` passes an explicit `env` (a copy of `process.env` without `AI_SDLC_WEBHOOK_SECRET`, or an empty object where the test needs nothing from the shell) so the result never depends on the caller's shell. 4. Accelerated: executors stop losing a verify round to an environment they do not control. 5. Automated: one test that runs `webhook status` with `env: { AI_SDLC_WEBHOOK_SECRET: 'x' }` and expects `off (not running)`, so both branches are pinned regardless of the shell.

## Acceptance Criteria

- [ ] `overrides()` in `hierarchy.test.ts` sets `env` explicitly; no test in the file reads `AI_SDLC_WEBHOOK_SECRET` from the real environment.
- [ ] `AI_SDLC_WEBHOOK_SECRET=x npx vitest run src/cli/hierarchy.test.ts` and the same with the variable unset both pass.
- [ ] A test covers the `off (not running)` branch with the secret present and no receiver.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Test-only change; no runtime code. Observed 2026-10-15 ~23:20Z on executor delta (AISDLC-926, PR #1642).
