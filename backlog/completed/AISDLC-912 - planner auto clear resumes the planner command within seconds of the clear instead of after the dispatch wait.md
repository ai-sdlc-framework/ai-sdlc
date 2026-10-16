---
id: AISDLC-912
title: 'fix: the planner auto clear re-issues /ai-sdlc:planner within seconds of the clear instead of after the 60 second dispatch wait'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [bug, pipeline-cli, hierarchy]
dependencies: []
references: [pipeline-cli/src/hierarchy/clear.ts, pipeline-cli/src/hierarchy/clear.test.ts, pipeline-cli/src/cli/hierarchy.ts, docs/operations/cli-hierarchy.md]
priority: medium
dispatchable: true
---

## Description

Operator report 2026-10-14: after an automatic clear, `/ai-sdlc:planner` runs too late; it should run immediately after the clear. Cause: `clearSelf` in `pipeline-cli/src/hierarchy/clear.ts` uses one default resume delay, `SELF_CLEAR_RESUME_SECONDS = 60`, for every role. The `auto-clear` branch in `pipeline-cli/src/cli/hierarchy.ts` calls it for the planner with no override, so the detached shell types `/clear`, sleeps 60 seconds, then types `/ai-sdlc:planner`. The 60 second wait is the dispatch session's settle time before it re-polls the board. The planner has no board to wait for, and the lead delay of 20 seconds is the only wait it needs.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the planner shares the dispatch session's 60 second resume wait. Only the dispatch loop waits on board events; the planner restarts with a command that prints the roster and stops. 2. Deleted: the planner's share of the 60 second default, nothing else. 3. Simplified: a per-role default resume delay (planner 3 seconds, dispatch and executor unchanged), chosen in `clearSelf` when `resumeAfterSeconds` is not passed. No new flag. 4. Accelerated: the planner is back and oriented about 57 seconds sooner after every auto clear. 5. Automated: nothing new; the Stop hook already schedules the clear.

## Acceptance Criteria

- [ ] `clearSelf` with `role: 'planner'` and no `resumeAfterSeconds` schedules the resume command 3 seconds after `/clear`; dispatch and executor defaults stay 60.
- [ ] An explicit `--resume-after` still wins for every role.
- [ ] `pipeline-cli/src/hierarchy/clear.test.ts` asserts the planner default and that the other roles are unchanged.
- [ ] `docs/operations/cli-hierarchy.md` states the per-role resume delays.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

The lead delay of 20 seconds before `/clear` is typed stays: it lets the calling turn end first. Shortening it is a separate decision.
