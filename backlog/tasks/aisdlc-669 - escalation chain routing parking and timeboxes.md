---
id: AISDLC-669
title: >-
  RFC-0051: cli-decisions escalate --route, task parking, tier-scoped answering, timeboxed auto-promotion
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - decisions
  - dispatch
  - cli
dependencies:
  - AISDLC-665
  - AISDLC-667
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/cli/decisions.ts
  - docs/operations/dispatched-session-decisions.md
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/orchestrator/events.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Questions go to the lowest tier able to answer them and never stop throughput: an
executor parks the task and takes the next one. The operator is asked last and only
through the decision rubric. RFC-0051 section 8, built on the existing
`cli-decisions escalate` flow from `docs/operations/dispatched-session-decisions.md`.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages; `node --test`
  for plugin hooks and scripts; 80% line coverage on new code.
- Tests never start a real Claude Code session, never call tmux against the user's
  real server (inject the command runner), and never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Routing field:** `cli-decisions escalate` gains `--route operational | design`
   stored on the decision; `--route` defaults to `design` when absent so existing
   callers keep their behaviour. The decision records the raising session's roster
   name and the task id.
2. **Parking:** `cli-decisions escalate --park` moves the task's inflight manifest to
   `blocked/` with `blockedBy` set to the decision id and returns a non-zero exit so
   the executor skill stops work on that task and claims the next eligible one.
3. **Tier-scoped answering:** `cli-decisions answer` checks the answering session's
   roster role: `operational` decisions may be answered by `operator-dispatch` or the
   planner; `design` decisions by the planner only; a decision raised to the operator
   is answered through the existing interactive path. An answer outside the tier's
   scope is refused with the reason. Answering a parked decision returns its manifest
   to `queue/`.
4. **Timeboxes** from config (`operational` 30 minutes, `design` 4 hours by default):
   `cli-decisions promote-expired`, run from the dispatch loop, moves an unanswered
   decision up one tier (`operational` to `design`; `design` to `operator`) and
   emits `DecisionEscalated`; the operator tier is terminal. Silence never resolves
   a decision.
5. **Notifications:** on escalate and on promotion, send the receiving tier's session
   (from the roster) one message with the decision id and summary; on answer, notify
   the raising session. Sending is best-effort and never fails the command.
6. **Events:** `DecisionEscalated` and `DecisionRouted` carry decision id, from-tier,
   to-tier and task id.
7. **Docs:** extend `docs/operations/dispatched-session-decisions.md` with the chain.

## Acceptance Criteria
- [ ] `escalate --route operational --park` creates the decision with route, raiser and task, moves the manifest to `blocked/` with `blockedBy`, and exits non-zero.
- [ ] A `design` decision cannot be answered by a session whose roster role is `operator-dispatch`; the same decision is answerable by the planner, and the answer returns the parked manifest to `queue/`.
- [ ] An `operational` decision is answerable by `operator-dispatch`.
- [ ] `promote-expired` moves an operational decision older than its timebox to `design`, a design decision older than its timebox to `operator`, leaves the operator tier in place, and emits `DecisionEscalated` for each move.
- [ ] Existing `escalate` callers without `--route` behave as before (existing tests pass unchanged).
- [ ] Notifications go to the roster name for the target tier and a failed send does not fail the command.
- [ ] The runbook documents the chain, the timeboxes and that silence never resolves downward.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
