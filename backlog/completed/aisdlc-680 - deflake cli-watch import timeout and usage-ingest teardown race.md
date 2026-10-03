---
id: AISDLC-680
title: >-
  CI deflake: dogfood cli-watch import timeout and the usage-ingest hook ENOTEMPTY teardown race
status: Done
assignee:
  - dispatch-executor-gamma
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
- [x] `dogfood/src/cli-watch.test.ts` passes 20 consecutive local runs with the default timeout and no `importActual` inside a per-test path. (20/20 with the hoist alone at the default 5000 ms; the file-level 30000 ms backstop the scope clause allows was added afterwards and re-measured 20/20.)
- [x] `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` passes 20 consecutive local runs; no test resolves before its child process has closed. (20/20. The hook detaches and unrefs the ingester, so a test cannot await its close; instead teardown waits for every recorded ingester pid to exit before the sandbox is removed.)
- [x] No global `testTimeout` change and no skip tokens.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass. (Run per the operator's no-workspace-wide-test rule: both affected files, prettier and eslint on the changed files, and tsc for dogfood; the full workspace suite runs in CI and in the pre-push gate.)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Deflaked the two CI failures. `cli-watch.test.ts` now loads the real pipeline-cli barrel once at file scope and reuses it in the `vi.mock` factory (plus a file-local 30000 ms `testTimeout` as a backstop). `usage-ingest.test.mjs` now tracks every ingester it launches by pid and waits for them to exit before removing the sandbox, with a retrying `rmSync` as a backstop.

## Changes
- `dogfood/src/cli-watch.test.ts` (modified): `vi.importActual('@ai-sdlc/pipeline-cli')` hoisted out of the per-test mock factory via top-level await; `vi.setConfig({ testTimeout: 30_000 })` for this file only, with a comment naming AISDLC-680.
- `ai-sdlc-plugin/hooks/usage-ingest.test.mjs` (modified): `fakeBin` records each ingester's pid; the real ingester runs behind a pid-recording wrapper; `settleIngesters()` waits (SIGKILL after 30 s) before `rmSync(root, { recursive, force, maxRetries: 10, retryDelay: 100 })`.
- `backlog/completed/aisdlc-680 ...md` and the AISDLC-657.3 task file, which sat under `backlog/tasks/` at the time (new): task files carried over from #1154 so they land with this PR.

## Design decisions
- **Wait on pids, not on `close`**: the hook spawns the ingester detached with ignored stdio and unrefs it, so a test cannot observe its `close` event through the hook; recording the pid from inside the ingester is the only handle. Tradeoff: teardown can in theory SIGKILL a reused pid after the 30 s wait; negligible and noted below.
- **Backstop timeout is file-local**: `vi.setConfig` in this one file, never the workspace config; the tests only await 50 ms timers, so it cannot hide a real hang for long.
- **Scope held**: the other ~76 unretried `rmSync` sites in `ai-sdlc-plugin/hooks/*.test.mjs` were not touched.

## Verification
- `cli-watch.test.ts`: 20/20 at the default timeout with the hoist alone (tests 170 ms versus 1.18 s for the original, warm), then 20/20 with the backstop. The original ran 3/3 locally; the timeout does not reproduce on a warm local machine.
- `usage-ingest.test.mjs`: 18/18 tests, 20/20 runs, zero leftover sandboxes and zero stray ingester processes. The original file also passed 10/10 locally, so the `ENOTEMPTY` race was NOT reproduced; the fix rests on reading the code.
- prettier and eslint clean on the changed files; `tsc --noEmit` clean for dogfood.
- Reviewers on the final head 306a9f9d: code, test and security (Opus) all approved, no critical or major findings. `harnessTranscriptHash` is null in this environment.

## Follow-up
- declined: teardown SIGKILL has no process-identity check before killing a recorded pid; it only fires after a 30 s wait that every ingester finishes in seconds, so a reused pid is negligible, and a guard would change the reviewed head.
- declined: the plugin-local node_modules ingester test writes its own bin and is not pid-tracked; it writes one marker and exits, and the retrying `rmSync` covers it.
- declined: the same unretried `rmSync(root, { recursive })` teardown pattern exists in about 76 other sites in ai-sdlc-plugin/hooks/*.test.mjs; out of scope here by the operator's instruction, to be filed by rfc-planner if wanted.
<!-- SECTION:FINAL_SUMMARY:END -->
