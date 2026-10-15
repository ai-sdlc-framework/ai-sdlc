---
id: AISDLC-915
title: 'fix: make the cli-usage ingest tests hermetic against the operator''s real codex home'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [bug, pipeline-cli, tests]
dependencies: []
references: [pipeline-cli/src/cli/usage-views.test.ts, pipeline-cli/src/cli/bin-invocation.test.ts, pipeline-cli/src/usage/codex-ingester.ts]
priority: high
dispatchable: true
---

## Description

Two pipeline-cli tests time out at 5000 ms on the operator's machine while passing in CI, and the timeout was wrongly attributed to an unrelated branch's change: `usage-views.test.ts` > "is live after a successful ingest and degraded after a failed one" and `bin-invocation.test.ts` > "`ingest --json` reports scanned, written, skipped and error counts". Both run the `ingest` command without setting `CODEX_HOME`, so the Codex ingester (`codex-ingester.ts`, which defaults to `~/.codex/sessions`) walks the operator's real Codex home (26 GB on the reporting machine). With `CODEX_HOME` pointed at an empty temporary directory both files pass (67 of 67). The sibling test "two concurrent ingests never duplicate limit events" in `bin-invocation.test.ts` already does this ("Hermetic: point the Codex ingester at an empty dir"); the two failing tests predate that fix.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that an ingest test may touch the operator's home at all. It may not; a unit test that reads outside its temp dir is a bug. 2. Deleted: nothing to delete. 3. Simplified: make the hermetic `CODEX_HOME` the default for every `ingest` invocation in these two files, in one place (a shared `env` in the describe setup), instead of per-test overrides. 4. Accelerated: the local `pnpm test` stops costing minutes of disk walk on machines with a Codex history. 5. Automated: add one guard test that asserts the ingester resolves to the temp dir when `CODEX_HOME` is set, so a future test that forgets it fails fast rather than by timeout.

## Acceptance Criteria

- [ ] Every `ingest` invocation in `pipeline-cli/src/cli/usage-views.test.ts` and `pipeline-cli/src/cli/bin-invocation.test.ts` runs with `CODEX_HOME` (and the projects dir, where applicable) pointed inside the test's temporary directory.
- [ ] Both files pass with the operator's real `~/.codex` present and large; verified by running them with `HOME` unchanged and no `CODEX_HOME` exported in the shell.
- [ ] A guard test asserts the Codex ingester never resolves a sessions directory outside `CODEX_HOME` when that variable is set.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Dispatch record: the executor working PR #1480 hit this timeout twice; the failures are not caused by that branch. Reproduce locally with `cd pipeline-cli && npx vitest run src/cli/usage-views.test.ts src/cli/bin-invocation.test.ts`; confirm the fix with the same command and no `CODEX_HOME` set.
