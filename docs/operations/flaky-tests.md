# Flaky Tests — Convention and Operations Guide

> **AISDLC-371** — Established 2026-05-19

## Overview

A test is "flaky" when it fails intermittently in CI with no code change between
attempts. Flaky tests are not deleted — they capture real edge-case behavior that
the test runner cannot reliably exercise under load. Instead, they are moved to
`*.flaky.test.ts` sibling files and exercised nightly in a dedicated workflow.

## The `*.flaky.test.ts` convention

### How it works

Every workspace's `vitest.config.ts` excludes `**/*.flaky.test.ts` from the
default test run:

```ts
test: {
  exclude: ['node_modules/**', 'dist/**', '**/*.flaky.test.ts'],
}
```

This means `pnpm test` and CI's standard `vitest run` never collect or run flaky
test files. The tests are _not_ deleted — they live alongside their non-flaky
siblings as `<original-name>.flaky.test.ts`.

### Nightly workflow

`.github/workflows/flaky-tests.yml` runs at **04:00 UTC daily** (and on
`workflow_dispatch` for manual investigation). The job is `continue-on-error: true`,
so a failure produces a signal in the workflow summary without blocking any PR
or triggering a CI failure alert. Results are written to the GitHub Actions step
summary for each run.

## When to rename a test

Move a test to `*.flaky.test.ts` when it fails CI **2 or more times** with no
code change between the failing CI run and a passing local run. Specifically:

1. The same test fails on separate CI runs of the same HEAD commit.
2. The test passes consistently when run locally with `vitest run --reporter=verbose`.
3. There is no obvious fix (e.g. missing mock, leaked timer) that can be applied
   within the scope of the current PR.

One-off CI failures caused by infra blips (OOM runner, network timeout fetching
external resource) do not count. Check the runner logs before declaring a test
flaky.

## How to move a flaky test

1. **Create a sibling file** — e.g. for `foo.test.ts`, create `foo.flaky.test.ts`.
2. **Copy the test** into the new file, along with all required shared setup
   (`beforeEach`, `afterEach`, helpers, imports).
3. **Remove `it.skip`** from the copy — the test should run without skipping in
   the flaky file (the exclude pattern suppresses it from the default run).
4. **Remove the `it.skip`** (or the entire test body) from the original file.
   Add a comment explaining where the test moved and why.
5. **Add a header comment** to the flaky file documenting:
   - Why it's flaky (one-line root cause or hypothesis)
   - First-flaked date
   - Reference to this guide
6. **Open a PR** with both files changed; no additional CI steps required.

## How to investigate a flaky test

1. Open the nightly workflow at
   `https://github.com/ai-sdlc-framework/ai-sdlc/actions/workflows/flaky-tests.yml`
2. Find the most recent run and expand the "Run flaky tests" step.
3. Look for FAIL or timeout lines for the test in question.
4. Run the test locally with additional timeout or isolation to reproduce:
   ```bash
   cd orchestrator  # or the relevant workspace
   pnpm exec vitest run --reporter=verbose src/path/to/foo.flaky.test.ts
   ```
5. Common causes to check: leaked `setInterval`/`setImmediate`, spawned child
   processes not cleaned up, file-system races (e.g. `git worktree add` then
   immediate read), CPU-sensitive timing assertions.

## How to un-flaky a test

1. Identify the root cause (see investigation guide above).
2. Fix the test to be deterministic — common approaches:
   - Replace subprocess spawns with mocked equivalents.
   - Use `vi.useFakeTimers()` for time-sensitive tests.
   - Add explicit retry or wait for file-system visibility.
   - Break the test into smaller, independent assertions.
3. Rename the file back from `*.flaky.test.ts` to `*.test.ts`.
4. Add a regression comment explaining what was fixed so future contributors
   don't accidentally reintroduce the flake.
5. Open a PR — the default test run will pick it up on the next CI trigger.

## Registry

| Test file | Suite description | Root cause | First flaked |
|-----------|------------------|------------|-------------|
| `orchestrator/src/cli/commands/init-workspace.flaky.test.ts` | `init — single-repo AISDLC-78 git-remote fallback` — falls back to your-org placeholder | `runInit(['--skip-mcp', '--yes'])` spawns child processes that time out 5s under CI load | 2026-05-09 |
| `pipeline-cli/src/orchestrator/loop.filters.flaky.test.ts` | `runOrchestratorTick — Phase 3 4-task fixture acceptance` | `runOrchestratorTick` with a real DoR calibration log times out 6s under CI load | 2026-05-09 |
| `orchestrator/src/runtime/worktree-pool.integration.flaky.test.ts` | `WorktreePoolManager integration` — 3-worktree parallel-allocate | git worktree write-then-read race under CI load | 2026-05-09 |

## PR #550 (AISDLC-302) Coverage hang bisect notes

PR #550 (`feat(orchestrator): RFC-0025 refit phase 1`) added 5 new test files
under `pipeline-cli/src/tui/analytics/` and `pipeline-cli/src/cli/`. Its
Coverage CI job hangs 60+ minutes on every retrigger while the tests pass in
<1s locally.

Suspect order (most likely first):

1. `pipeline-cli/src/tui/analytics/quality-router.test.ts` — writes JSONL and
   backlog task files; most FS operations.
2. `pipeline-cli/src/tui/analytics/quality-metrics.test.ts` — uses `utimesSync`
   for deterministic mtimes; possible V8 coverage instrumentation stall.
3. `pipeline-cli/src/tui/analytics/quality-classifier.test.ts` — pure functions;
   least likely.
4. `pipeline-cli/src/tui/analytics/determinism-detector.test.ts` (if present)
5. `pipeline-cli/src/cli/quality-corpus.test.ts`

To bisect: in the PR #550 branch, rename one test file at a time to
`*.flaky.test.ts` (in the vitest config exclude pattern, already set by this PR
once #555 merges into main and PR #550 rebases), push, and monitor CI. When
the Coverage job completes in normal time, the last renamed file is the culprit.
Move it to `*.flaky.test.ts` permanently and add it to the registry above.
