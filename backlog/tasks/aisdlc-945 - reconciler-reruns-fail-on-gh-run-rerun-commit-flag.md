---
id: AISDLC-945
title: 'Reconciler reruns fail: gh run rerun has no --commit flag, so retrigger-once, rerun-rate-limited and rerun-dor never run'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - reconciler
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reconcile.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

`actionCommands` in `pipeline-cli/src/hierarchy/reconcile.ts` renders every rerun action (`retrigger-once`, `rerun-rate-limited`, `rerun-dor`) as `gh run rerun --failed --commit <headSha>`. `gh run rerun` takes a run id, not a commit: gh 2.72.0 answers `unknown flag: --commit` and the action is recorded as `actionFailed`. Every reconciler rerun on this repository has therefore been a no-op; the dispatch session saw it first on PR 1519 (state cancelled-or-infra, head a80344f) and rate-limited PRs are left red until a human reruns them.

**Five-step review (requirements first).**
1. Requirement questioned: do we need a rerun at all, or should the classifier wait for the next push? Rate-limited and cancelled runs do not recover by themselves on an unchanged head, so a rerun is needed.
2. Delete: nothing to delete; the three actions already share one command builder.
3. Simplify: resolve the gate run id for the head with `gh run list --commit <sha> --workflow ai-sdlc-gate.yml --json databaseId --jq '.[0].databaseId'` and run `gh run rerun <id> --failed`; one builder, two commands.
4. Accelerate: skip the lookup when the landing record already stores the run id from the classifier.
5. Automate: a unit test that renders the commands for each of the three actions and asserts no `--commit` argument on `gh run rerun`, plus a shell-level smoke in the existing reconcile test that stubs `gh` and checks the two-step sequence.

Velocity impact: positive; red PRs recover without dispatch or the planner touching them.

## Acceptance Criteria

- [ ] AC-1: `actionCommands` for `retrigger-once`, `rerun-rate-limited` and `rerun-dor` emits a run-id lookup followed by `gh run rerun <id> --failed`; no `--commit` is passed to `gh run rerun`.
- [ ] AC-2: When no gate run exists for the head, the action returns `null` with a note ("no gate run for head") instead of failing.
- [ ] AC-3: `reconcile.test.ts` covers the rendered commands for all three actions and the no-run case.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` describes the rerun as run-id based.

## Notes

Origin: dispatch report 2026-10-16 18:20Z on PR 1519 (AISDLC-534.1), confirmed against `gh run rerun --help` (gh 2.72.0).
