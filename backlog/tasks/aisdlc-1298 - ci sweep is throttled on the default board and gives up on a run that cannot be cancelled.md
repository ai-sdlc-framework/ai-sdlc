---
id: AISDLC-1298
title: 'CI sweep is throttled on the default board and gives up on a run that cannot be cancelled'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - dispatch
  - bug
  - rate-limit
dependencies: []
references:
  - pipeline-cli/src/cli/ci.ts
  - pipeline-cli/src/cli/ci.test.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Bug measured on this board on 2026-11-17: `.ai-sdlc/dispatch/gh-calls.jsonl` holds 14,852 `gh run cancel` calls in 24 hours (about 650 an hour, 21% of all gh calls of the dispatch session), 14,850 of them with exit 1, against the same six workflow runs. This is the largest single avoidable share of the gh call rate that DEC-0409 names as rate-limit pressure. No design choice is open.'
---

## Description

**Gap.** Two defects compound.

1. **The sweep is never throttled on the default board.** `runThrottledSweep` in `pipeline-cli/src/cli/ci.ts` skips a sweep younger than 15 minutes only when it is given a board directory (AISDLC-960). The dispatch hooks module calls `cli-ci sweep` with `boardArgs(state)` (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`), which is empty when the session uses the default board. So the sweep runs on every tick (about every 35 seconds) and `.ai-sdlc/dispatch/.ci-sweep.json` does not exist on this board.
2. **A run that cannot be cancelled is retried for ever.** GitHub lists twelve runs of 2026-11-11 as `queued` (for example 43095866984, `Auto-enable auto-merge on PR open`, branch of AISDLC-1263, long merged). `gh run cancel 43095866984` answers `Cannot cancel a workflow run that is completed` with exit 1. `planSweep` marks six of them `cancel` on every sweep because GitHub's list still says `queued`, and nothing remembers the refusal.

Each sweep also lists queued runs and open pull requests, so the unthrottled sweep costs two more gh calls per tick.

**Shape.** The sweep runs at most once per 15 minutes per board whether or not the caller names the board, and a run whose cancel was refused as already completed is not asked again.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is the sweep needed on every tick? No: AISDLC-960 already decided once per 15 minutes; the defect is that the rule is skipped. 2. Deleted: the unthrottled path for a real (not dry-run) sweep. 3. Simplified or optimised: `cli-ci sweep` resolves the default board directory itself (the same default the other dispatch CLIs use: `AI_SDLC_DISPATCH_BOARD_DIR`, else `.ai-sdlc/dispatch` under the working directory) when `--board-dir` is absent, so no caller can forget it. 4. Accelerated: not applicable. 5. Automated: tests below.

- **Throttle.** A real sweep with no `--board-dir` uses the default board directory for the 15-minute stamp. `--dry-run` stays unthrottled and writes no stamp.
- **Refused cancels.** When `gh run cancel` exits non-zero and stderr says the run is completed, record the run id in the sweep stamp file (a list `uncancellable`, capped at the 200 newest ids). `runSweep` skips a recorded run and prints one line `skipped <n> run(s) GitHub refuses to cancel` instead of one line per run. Any other cancel failure is not recorded and is retried at the next sweep.
- **Summary line.** The closing line reports cancelled, refused and skipped counts.
- **Docs.** The CI sweep paragraph of `docs/operations/cli-hierarchy.md` states the interval and the refused-run rule.

Out of scope: force-cancelling or deleting the ghost runs on GitHub; any other reduction of gh calls; the dispatch hooks module beyond what the throttle needs (prefer no change there).

## Acceptance Criteria

- [ ] #1 A test runs a real sweep twice within 15 minutes with no `--board-dir` and a default board in a temporary working directory; the second run makes no gh call and prints the skipped line.
- [ ] #2 A test where `gh run cancel` fails with stderr `Cannot cancel a workflow run that is completed` records the run id; a following sweep (stamp aged past 15 minutes) with the same run still listed as queued issues no cancel call for it and prints the one skipped line.
- [ ] #3 A test where `gh run cancel` fails with a different error (for example an HTTP 502 text) does not record the run, and the following sweep tries it again.
- [ ] #4 `--dry-run` writes no stamp and is never skipped by the throttle; a test asserts both.
- [ ] #5 The recorded list never holds more than 200 ids; a test asserts the oldest are dropped.
- [ ] #6 `docs/operations/cli-hierarchy.md` states the 15-minute interval and the refused-run rule.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
