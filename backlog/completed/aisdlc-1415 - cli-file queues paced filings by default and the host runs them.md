---
id: AISDLC-1415
title: cli-file queues paced filings by default and the host runs them when due
status: Done
assignee: []
created_date: '2026-11-25'
labels:
  - pipeline-cli
  - filing
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - docs/operations/tooling-limitations.md
priority: high
drift_log:
  - date: '2026-11-26'
    type: ref-deleted
    detail: 'Referenced file no longer exists: pipeline-cli/src/cli/file-pacing.ts'
    resolution: flagged
drift_checked: '2026-11-26'
---

## Description

**Five-step review (requirements first).** The requirement comes from DEC-0426, answered by the operator on 2026-11-25: option c, queue by default. When the filing spacing has not elapsed, a `cli-file ... --pr` call (task, update, rebase, and `cli-decisions ... --file --pr`) returns at once instead of sleeping up to 15 minutes. The spacing stays, and is applied by a queue instead of by blocking the caller.

- **Question the requirement:** the spacing protects the installation `GITHUB_TOKEN` REST bucket (AISDLC-986). It stays. Only the blocking goes.
- **Delete:** the in-process sleep in `paceFiling` (`pipeline-cli/src/cli/file-pacing.ts:124-128`) is no longer the default path.
- **Simplify:** reuse the existing `queueFiling` brief and `last-filing.json` stamp. Add no new store.
- **Accelerate:** the caller gets its answer (queued, with the not-before time and the brief path) in seconds.
- **Automate last:** something must run the queued filings. Today nothing does: `.ai-sdlc/dispatch/queued-filings/` is written in `file-pacing.ts:84` and read nowhere. A brief from 2026-11-08 (AISDLC-1235) still sits there.

On 2026-11-25 three filings each blocked for about 15 minutes (898 s, 899 s and one 10-minute hang first blamed on verify slots, AISDLC-1413).

## Fix

1. **Queue by default.** When the spacing has not elapsed, `paceFiling` queues the brief and returns `'queued'`, and `cli-file` exits 0. It prints, on stdout as JSON and on stderr as a line: `queued`, the brief path, the not-before time and why (the spacing rule and the previous filing time). Callers already handle `--queue`, so check them: the planner command, `cli-decisions --file --pr` and the dispatch reconciler.
2. **Keep a blocking opt-in.** Add `--wait` for a caller that must have the PR URL in the same call. It sleeps as today, with the progress lines AISDLC-1414 item 8 adds. `--queue` stays accepted as a no-op alias.
3. **Run due briefs.** The dispatch host tick (the scheduler that already runs every tick) runs due queued filings. It takes one per tick, oldest not-before first, and only when the spacing since `last-filing.json` has elapsed. It runs the recorded command with the queue flag unset, so the brief cannot re-queue itself in a loop. On success it removes the brief and records the PR URL in the event log the reconciler reads. On failure it keeps the brief, records the error and retries on a later tick with backoff, at most 3 times. After that it routes to the planner as a held item.
4. **Make queued filings visible.** `cli-hierarchy status` prints `queued filings: N (next <id> not before <time>)`, and the planner orientation shows it. A brief whose task or decision is already on `origin/main` with the same content is removed with a log line. That is the stale AISDLC-1235 case.
5. **Document it.** Update the `tooling-limitations.md` row and the planner command's Filing section: filings return at once, and their PRs open later on the dispatch tick.

## Acceptance Criteria

- [ ] #1 With the spacing not elapsed, `cli-file task <path> --pr` returns within 5 s, exits 0, writes one brief and prints the brief path, the not-before time and the reason. Unit-tested with a fake clock in `file-pacing.test.ts`.
- [ ] #2 `--wait` keeps today's blocking behaviour, and `--queue` is accepted without changing behaviour. Tested.
- [ ] #3 The host tick runs one due brief per tick and never runs a brief before its not-before time or the spacing. A run that succeeds removes the brief. One that fails keeps it and retries at most 3 times, then routes to the planner. Tested with a fake runner.
- [ ] #4 A drained brief never re-queues itself (the queue flag is unset in the drain path). Tested.
- [ ] #5 `cli-hierarchy status` prints the queued-filing count and the next due id. A brief already satisfied on `origin/main` is removed with a log line.
- [ ] #6 `cli-decisions add|answer --file --pr` follows the same queue-by-default path. Tested.
- [ ] #7 `docs/operations/tooling-limitations.md` and the planner command text describe the new default, citing DEC-0426.

## Closed

- Reason: superseded by DEC-0426 d, recorded as DEC-0432 b (operator, 2026-11-26), which overrules DEC-0426 c; the filing spacing is deleted outright, so there is nothing to queue. Not built.
- Superseded by: AISDLC-1437
- Date: 2026-11-26
