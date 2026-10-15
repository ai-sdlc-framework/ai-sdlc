---
id: AISDLC-908
title: 'fix: cli-usage ingest tests isolate CODEX_HOME so local verification does not scan the machine''s real Codex sessions'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [bug, pipeline-cli, tests]
dependencies: []
references: [pipeline-cli/src/cli/usage-views.test.ts, pipeline-cli/src/cli/bin-invocation.test.ts, pipeline-cli/src/cli/usage.ts, pipeline-cli/src/usage/codex-ingester.ts]
priority: critical
dispatchable: true
---

## Description

Three executors on 2026-10-15 failed verification on untouched files: `usage-views.test.ts` ("cli-usage ingest reports the usage.ingest capability > is live after a successful ingest and degraded after a failed one") and `bin-invocation.test.ts` ("cli-usage: bin shim guard and end-to-end ingest > ingest --json reports scanned, written, skipped and error counts") time out at 5000ms. Reproduced on `origin/main` 792de45f. Cause: PR #1378 (2026-10-10) made `cli-usage ingest` also run `ingestCodexSessions` (`pipeline-cli/src/cli/usage.ts` ~372-383), whose sessions directory defaults to `$CODEX_HOME/sessions` then `~/.codex/sessions` (`codex-ingester.ts` ~85-86). The usage-views test stubs `ingest` but not `ingestCodex`, and the bin-invocation test spawns the real bin with the inherited `process.env` and no `CODEX_HOME` or `--sessions-dir`. Each `ingest` call therefore scans the operator machine's real Codex history (796 jsonl files, 395 MB here) and exceeds the timeout. With `CODEX_HOME` pointing at an empty directory both files pass 67/67 in 5 s. CI and fresh machines have no Codex history, which is why the gate stays green while every executor on this machine fails verification; the failure is attributed to whatever PR is being verified, and three tasks were requeued or parked for it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that a unit test may inherit the developer's home directory. It may not: tests of an ingester must be hermetic, which the same file already does for a later test that sets `CODEX_HOME` to a temp dir. 2. Deleted: nothing to delete; two tests miss an isolation the file already has. 3. Simplified: in `usage-views.test.ts` stub `ingestCodex` (zero counts) alongside `ingest` in that describe block, or `vi.stubEnv('CODEX_HOME', <tmp>)` in its `beforeEach`; in `bin-invocation.test.ts` add `CODEX_HOME: join(tmp, 'codex-home')` to the env of the `ingest --json` test, exactly as the later test does. 4. Accelerated: executor verification on a machine with Codex history goes from two 5 s timeouts and a failed verdict to a 5 s pass; the three parked tasks resume. 5. Automated: one `beforeAll` in each file (or a shared helper) that sets `CODEX_HOME` to a temp directory for every test in the file, so a future `ingest` test cannot regress; optionally the ingester logs the directory it scans at debug level so the next such failure names itself.

## Acceptance Criteria

- [ ] `npx vitest run src/cli/usage-views.test.ts src/cli/bin-invocation.test.ts` in `pipeline-cli` passes with `~/.codex/sessions` populated (hundreds of files) and with it absent; no test in either file reads outside the repo or a temp dir.
- [ ] Every test in both files runs under a temp `CODEX_HOME` (file-level setup), not only the two that failed.
- [ ] No change to `cli-usage ingest` behaviour for real users.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

This is why "usage-views red on base" was reported by three executors while CI was green: it is machine-local, not a main regression visible in the gate. Until this lands, an executor that hits it can confirm by rerunning the two files with `CODEX_HOME=$(mktemp -d)`; a pass there means the PR under verification is not at fault.
