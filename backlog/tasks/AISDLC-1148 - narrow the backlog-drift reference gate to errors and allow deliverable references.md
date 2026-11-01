---
id: AISDLC-1148
title: 'Narrow the backlog-drift reference gate: errors only on every path, deliverable references allowed, dead duplicates removed'
status: To Do
assignee: []
created_date: '2026-11-01'
labels:
  - governance
  - ci
  - developer-experience
dependencies: []
references:
  - .backlog-drift.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ci.yml
  - scripts/check-governance-on-push.sh
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/dor/gates/gate-3-references.ts
  - pipeline-cli/src/review-plan/baseline.ts
  - ai-sdlc-plugin/mcp-server/src/tools/task-create.ts
  - docs/operations/backlog-and-execution-reference.md
  - docs/operations/gate-audit-2026-10.md
priority: medium
dispatchable: true
---

## Description

Operator ruling DEC-0289 (2026-11-01, planner rubric, option `narrow`). The backlog-drift gate checks that every `references:` path in a task resolves on the working tree. Evidence gathered on 2026-11-01: it has caught about four real problems (a wrong path in AISDLC-183, a file deleted in AISDLC-1122, a removed fixture) against about twelve commits of gate maintenance and four false-positive repairs; in the 24 hours before the ruling it fired twice (#2202, #2213), both on a task naming a file the task itself creates. Nothing that consumes `references:` needs the path to exist: brief sequence groups, RFC task selection and estimation compare strings. Two other controls pull the opposite way: the review-plan baseline flags a changed file that is not in `references:` as out of scope, and the bug-task hook requires the test file to be named. The result is that authors strip the most useful reference to pass the gate.

Three pieces of wiring make it worse: `cli-file` refuses a filing on any non-zero exit, and the tool exits 1 on warnings; the `ci.yml` `merge_group` copy of the job is dead since the merge queue was removed (AISDLC-400); DoR gate 3 repeats the existence check so a fix to drift alone does not unblock filing.

## Acceptance Criteria

- [ ] A task may list a path it will create. Choose one mechanism and apply it everywhere: either a `creates:` frontmatter list that the drift check, DoR gate 3 and `task_create` skip for existence but every consumer that reads `references:` (brief sequence groups in `pipeline-cli/src/hierarchy/brief.ts`, review-plan baseline scope, dev prompt, estimation) treats as a reference; or an `ignore_refs` convention. The chosen mechanism is documented in `docs/operations/backlog-and-execution-reference.md`.
- [ ] Every blocking path blocks on error severity only: `cli-file` (`pipeline-cli/src/cli/file.ts` filing and sync-parent) parses the JSON report and refuses only on `severity == "error"`, matching `ai-sdlc-gate.yml` and `scripts/check-governance-on-push.sh`.
- [ ] The `merge_group` Backlog Drift job in `.github/workflows/ci.yml` is deleted.
- [ ] DoR gate 3 (`gate-3-references.ts`) no longer fails on a path declared as a deliverable; its existence check for other paths stays.
- [ ] The review-plan baseline (`review-plan/baseline.ts`) does not flag a declared deliverable as out of scope.
- [ ] `docs/operations/backlog-and-execution-reference.md` no longer says drift is "Required on commit" (the pre-commit step was removed in AISDLC-712).
- [ ] Tests: a drift fixture task with a deliverable path passes the gate, cli-file and DoR gate 3; a task with a deleted referenced file still fails with `error`.

## Implementation Notes

**Five-step review (requirements first).** Requirement questioned: must a reference exist on main? No; consumers compare strings, and the deliverable is the reference that matters most. Delete: the dead `ci.yml` merge_group job and the warning-blocks-filing behaviour in cli-file. Simplify: one declared-deliverable mechanism shared by drift, DoR gate 3, task_create and the review baseline instead of three gates with three opinions. Accelerate: filings and task PRs stop needing a reference-stripping round. Automate: the fixture tests keep the three checks agreeing.

Out of scope: the push-step velocity work from the 2026-11-01 landing review (Step 11 lease push, single pusher, reconciler shapes), which is filed separately if the operator authorizes it.
