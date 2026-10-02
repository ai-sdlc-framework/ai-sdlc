---
id: AISDLC-680
title: >-
  CI deflake: dogfood cli-watch import timeout and the usage-ingest hook ENOTEMPTY teardown race
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - ci
  - tests
  - dogfood
  - plugin
dependencies: []
references:
  - dogfood/src/cli-watch.test.ts
  - ai-sdlc-plugin/hooks/usage-ingest.test.mjs
  - .github/workflows/ci.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved 2026-10-02. Two unrelated tests fail most pull requests on the
`Build & Test (Node 22)` job, re-runs do not clear them reliably, and every armed PR
in the RFC-0049/0050/0051 drain has been stalled on them for hours.

1. `dogfood/src/cli-watch.test.ts`: the first test in the file ("exits with error
   when no --issue is provided") times out at the 5000 ms default. The file calls
   `vi.resetModules()` in `beforeEach` and then re-imports the module under test,
   whose `vi.mock` factory does `vi.importActual('@ai-sdlc/pipeline-cli')`: the whole
   pipeline-cli barrel is re-evaluated on a cold CI runner inside the first test's
   budget. Example: run 36931258228 on PR #1146.
2. `ai-sdlc-plugin/hooks/usage-ingest.test.mjs`: the `after` hook does
   `rmSync(root, { recursive: true, force: true })` on the `mkdtemp` root while a
   hook child process spawned by an earlier test may still be writing into it, so
   `rmSync` fails with `ENOTEMPTY`.

## Conventions
- Fix the tests, not the code under test, unless the race is in the hook itself.
- No `AI_SDLC_SKIP_*` tokens, no retries-until-green in CI, no raising the global
  `testTimeout` for the whole workspace.
- Do not touch dogfood tests from a feature branch; this task is the only vehicle.

## Scope
1. cli-watch: hoist the expensive `importActual` out of the per-test path (import once
   at module scope and reuse in the factory, or replace the barrel import with the two
   named symbols the test needs), and keep the per-test `resetModules` for the module
   under test only. If the first import still legitimately exceeds the budget on CI,
   give that file alone a `testTimeout` with a comment naming this task.
2. usage-ingest: await every spawned hook child (`close` event, not `exit`) before the
   test that spawned it resolves, and make the `after` teardown retry
   (`maxRetries`/`retryDelay` on `rmSync`) so a late write cannot fail the suite.
3. Evidence: run each file 20 times locally under `--repeat`/a shell loop and record
   zero failures in the PR body.

## Acceptance Criteria
- [ ] `dogfood/src/cli-watch.test.ts` passes 20 consecutive local runs with the default timeout and no `importActual` inside a per-test path.
- [ ] `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` passes 20 consecutive local runs; no test resolves before its child process has closed.
- [ ] No global `testTimeout` change and no skip tokens.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
