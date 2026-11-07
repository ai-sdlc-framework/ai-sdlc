# Session hierarchy results, November 2026

Results note for [RFC-0051](../../spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md) (session hierarchy and parallel dispatch), written from production logs rather than from a rehearsed supervised run. Operator reference: [`cli-hierarchy.md`](cli-hierarchy.md), [`session-hierarchy.md`](session-hierarchy.md).

## Window and sources

- **Window:** 7 days, 2026-10-31 to 2026-11-07 (the hierarchy was the default executor path throughout).
- **Source 1, usage ledger:** `node pipeline-cli/bin/cli-usage.mjs by-role --since 7d` (Claude Code transcripts ingested into the usage ledger).
- **Source 2, repository history and decision log:** `git log` over `backlog/completed/` for the done count, and `.ai-sdlc/_decisions/events/` for the decisions below.

## Throughput

`done/` count for the window: **124** task files added to `backlog/completed/` (`git log --since=2026-10-31 --diff-filter=A -- backlog/completed`, unique paths).

## Per-role usage (`cli-usage by-role --since 7d`)

| role | calls | work calls | work USD | polling calls | polling USD |
| --- | --- | --- | --- | --- | --- |
| main-session | 5948 | 5942 | $301.22 | 6 | $0.28 |
| planner | 1777 | 1774 | $200.44 | 3 | $0.14 |
| ai-sdlc:developer | 7096 | 7062 | $97.78 | 34 | $0.29 |
| executor | 2466 | 2466 | $70.84 | 0 | $0.00 |
| ai-sdlc:security-reviewer | 1153 | 1153 | $60.87 | 0 | $0.00 |
| Explore | 1067 | 1067 | $37.96 | 0 | $0.00 |
| general-purpose | 255 | 255 | $21.44 | 0 | $0.00 |
| ai-sdlc:code-reviewer | 583 | 583 | $16.54 | 0 | $0.00 |
| ai-sdlc:test-reviewer | 536 | 536 | $14.28 | 0 | $0.00 |
| ai-sdlc:correctness-reviewer | 442 | 442 | $12.25 | 0 | $0.00 |
| operator-dispatch | 382 | 379 | $9.35 | 3 | $0.06 |
| ai-sdlc:rebase-resolver | 312 | 310 | $3.17 | 2 | $0.01 |

Polling spend is negligible against work spend in every role.

## Observed failure modes

- **DEC-0377:** webhook health down (no event for about 2994 minutes while a PR changed); dispatch kept working by polling `gh` at about 2,700 calls an hour.
- **DEC-0382:** the same webhook feed outage recurred (no event for about 3959 minutes), again covered by poll-only dispatch.
- **DEC-0383:** verdict-ref deadlock on PR 2427 and PR 2429; the ship step dropped `refs/ai-sdlc/verdicts/<head>`, so the merge gate refused the fix; resolved by a one-off pinned-build re-entry.
- **DEC-0384:** task-scoped restatement of DEC-0383 for AISDLC-1196, because the dispatch loop guard accepts only a task-scoped record for `reenter --decision`.
- **DEC-0391:** webhook health degraded because the forwarder process died while the receiver stayed up; polling covered the gap.
- **DEC-0392:** the 30-minute heartbeat-age reap was a poor liveness signal; replaced by event-driven liveness (pane death, idle-with-claim, step-owned developer budget, no restart from zero).

## Closing evidence

This note is the closing evidence for AISDLC-668.3 (supervised check of brief notify delivery) and AISDLC-823.1 (soak AC-6 evidence for the scheduled dispatch tick): the hierarchy ran as the default path for the window above, with the throughput and usage figures recorded here, and the failure modes were caught by the decision log rather than going unnoticed.
