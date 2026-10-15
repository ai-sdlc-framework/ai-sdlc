---
id: AISDLC-922
title: 'fix: cli-file decision warns on duplicate pairs already on main instead of refusing the log'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, decisions, cli-file, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/cli/file.ts, pipeline-cli/src/cli/file.test.ts, pipeline-cli/src/decisions/event-log.ts]
priority: high
dispatchable: true
---

## Description

`cli-file decision` parses the whole log strictly and refuses it when any `(decisionId, type)` pair appears twice (`assertNoDuplicatePairs`, `file.ts` around line 120: "duplicate (decisionId, type) pair ..."). In an ai-sdlc-io consumer catalog, `DEC-0001 decision-opened` was opened twice on main (2026-10-13 19:44Z and 20:02Z). That pre-existing duplicate now makes every later `cli-file decision` call refuse, so every later decision record had to be a hand-made PR.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that filing must reject a defect it did not cause. The check protects against the filing introducing a duplicate; history already on main cannot be undone by refusing new work. 2. Deleted: the refusal for duplicates that exist on `origin/main`. 3. Simplified: the same pair scan, with each duplicate classified by whether it is already on `origin/main`. 4. Accelerated: decision records file through the sanctioned path again. 5. Automated: tests cover both classes.

The strict parse reports a duplicate already present on `origin/main` as a warning (printed, not refused) and refuses only a duplicate that the filing itself would introduce.

## Acceptance Criteria

- [ ] A pair duplicated entirely on `origin/main` produces a warning and the filing proceeds.
- [ ] A filing that adds a pair already present (on main or in the same filing) is refused with the current message.
- [ ] Tests in `file.test.ts` cover both cases.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Source: friction report from ai-sdlc-io on plugin 0.29.0. Repairing the existing duplicate in that catalog is out of scope.
