---
id: AISDLC-1166
title: 'Budget override and window tracking survive reset-time jitter; the machine-local usage log is ignored so Step 0.5 stops refusing dispatch'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - pipeline-cli
  - hierarchy
  - budget
dependencies: []
references:
  - pipeline-cli/src/hierarchy/budget.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/steps/00-parent-upkeep.ts
  - .gitignore
priority: high
dispatchable: true
---

## Description

Two defects stopped dispatch on 2026-11-03 after the operator raised the executor cap to 3.

**1. `cli-hierarchy resume --budget` lapses on the next usage sample.** `overrideBudget` in `pipeline-cli/src/hierarchy/budget.ts` stores the window's `resetsAt` string, and the override is honoured only while `ov.sevenDay === sevenDay.resetsAt`. The usage endpoint returns a slightly different reset timestamp on each sample (observed `2026-11-03T19:00:00.045334+00:00`, then `2026-11-03T18:59:59.998738+00:00`). Within about five minutes the override silently stops applying and the pacer allowance drops back to 1. The same exact-string comparison decides whether a sample belongs to the current window (around lines 177 and 234), so jitter also restarts the window's start utilization and skews the pacing line. The planner worked around it by re-running `resume --budget` every four minutes until the reset.

**2. `.ai-sdlc/usage/developer-honesty.jsonl` is not ignored.** `verify-commands.ts` appends it in the parent checkout. Step 0.5 of parent upkeep treats any non-backlog untracked file as a hard stop, so the first honesty event blocks every dispatch. The planner added it to the local `.git/info/exclude` as a workaround. A stale hand-written `.claude/memory/operator-dispatch-handoff.md` caused the same refusal and was excluded the same way; that one is a local file, not a code defect.

**Five-step review (requirements first).**
1. Requirement questioned: the override must last until the window it names resets, as `resume --help` promises; a usage ledger written by the pipeline must never block the pipeline.
2. Delete: the exact-string reset comparisons.
3. Simplify: compare reset times as instants within a tolerance (for example one minute), in one helper used by all three comparisons; add `.ai-sdlc/usage/` to `.gitignore`.
4. Accelerate: an override then needs one command, not a polling loop.
5. Automate: tests pin the jitter case.

## Acceptance Criteria

- [ ] AC-1: An override recorded for a window still applies when a later sample reports that window's reset time shifted by under a minute; it stops applying once a sample reports a reset more than the tolerance later (a new window). Unit test with the two observed timestamps.
- [ ] AC-2: Window-start tracking treats the same jittered reset as the same window; the start utilization is kept. Unit test.
- [ ] AC-3: `.ai-sdlc/usage/` is in `.gitignore`, and a test or check shows a `developer-honesty.jsonl` written by verify-commands does not make Step 0.5 refuse.

## Notes

Found by the planner on 2026-11-03 when dispatch reported the cap still at 1 after `resume --budget`. Workarounds in place until this lands: a planner loop re-applying the override until 19:00Z, and two lines in the parent's `.git/info/exclude`, which can be removed after landing.
