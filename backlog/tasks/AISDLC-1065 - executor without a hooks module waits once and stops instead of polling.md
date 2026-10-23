---
id: AISDLC-1065
title: 'executor session with no hooks module runs executor-start once and stops, never polls in model turns'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - plugin
  - hierarchy
  - token-cost
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/hierarchy/executor-start.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Weekly token audit (2026-10-16 to 2026-10-23): three idle executor sessions on 2026-10-23, each with no task, re-ran `cli-hierarchy executor-start --board-dir .ai-sdlc/dispatch --wait 1500` in a background loop and read its output file between 2,100 and 3,000 times each, at an average context of 450k to 483k tokens and a peak of 966k. Those three sessions consumed 3,702M cache-read tokens, 47 percent of the whole week, while writing under 0.4M output tokens. The hooks module was not loaded (validator refusal, then the version guard), so nothing woke them by message and nothing rotated them at the 120k threshold, and the model filled the gap by polling. Even with a working module, four idle executors today still climb about 1k context per minute by polling.

The executor command already says "Nothing eligible: do not clear, poll or wait. End your reply with `[executor] idle` and stop the turn", but the session kept polling because the command also exposes a `--wait` option and nothing refuses a second `executor-start` in the same idle turn. Fix: (1) `cli-hierarchy executor-start` refuses `--wait` greater than 0 when the calling session has no module heartbeat (the module-health file of the sibling task, or, until that lands, when the board shows the dispatch session's last tick older than two intervals), printing one line that names the rule; (2) the same command records its last call per roster name under `<board-dir>/starts/` and, when called again within 60 s by the same idle session with no new enqueue, returns `{"taskId":null,"repeat":true}` and exit 0 with the line "already idle; stop the turn"; (3) the executor command body loses the `--wait` example and gains one sentence: a second `executor-start` in an idle turn is a defect, stop the turn; (4) the `turn.complete` hook of the executor module, when present, already ends the turn, so no change there. Runbook: add "idle executor polling" to the cost section of `docs/operations/cli-hierarchy.md` with the audit numbers.

**Five-step review (requirements first).** Requirement questioned: does an idle executor need any wait at all? No: the module wakes it by message, and without a module the dispatch session types the command; waiting in a model turn is pure cost. Deletion: the `--wait` path from the executor command body. Simplified: one repeat guard in the CLI. Accelerated: an idle executor costs zero model calls between tasks. Automated last: a test pins the repeat guard and the `--wait` refusal.

## Acceptance Criteria

- [ ] With no module heartbeat, `executor-start --wait 1500` exits non-zero with a one-line refusal naming the rule; with a heartbeat it behaves as before.
- [ ] Two `executor-start` calls within 60 s from the same roster name with no new enqueue: the second returns `repeat: true` and the "already idle; stop the turn" line; a unit test covers both and the reset after an enqueue.
- [ ] `ai-sdlc-plugin/commands/executor.md` no longer shows `--wait`; the runbook cost section carries the audit figures; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
