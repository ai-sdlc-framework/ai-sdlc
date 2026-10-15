---
id: AISDLC-929
title: 'fix: red main is surfaced by the dispatch tick, not a GitHub issue'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [ci, hierarchy, governance, pipeline-cli, velocity]
dependencies: []
references: [.github/workflows/main-health-monitor.yml, .github/workflows/__tests__/main-health-monitor.test.mjs, pipeline-cli/src/hierarchy/reconcile.ts, pipeline-cli/src/hierarchy/reconcile.test.ts, docs/operations/main-health-monitor.md]
priority: medium
dispatchable: true
---

## Description

`main-health-monitor.yml` pages a red main by creating a GitHub issue (`[main-health] main is RED at <sha>`, labels `ci`/`main-red`, assigned to the operator). The workflow only creates: nothing resolves the issue when main turns green, and agents never resolve issues. Issue #1508 (red at d03eda7c on 2026-10-13) is still open two days after main went green. Worse, the duplicate guard matches on the title prefix of any OPEN issue, so while a stale issue exists a NEW red main files nothing: the pager is disarmed exactly when it is needed. The signal also goes to the wrong reader: a red main is acted on by the dispatch session (it blocks every PR's Build and Test), and dispatch does not read issues. GitHub issues are for external contributors; internal state lives on the board and in the backlog.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "notify the operator by issue". The requirement is that a red main is noticed on the next tick and routed to the planner, by the session that drains the board. 2. Deleted: the `gh issue create` step, its label creation and the open-issue duplicate guard in `main-health-monitor.yml`; the `main-red` label; the "assigned to the operator" paging contract in the docs. 3. Simplified: no new state. The dispatch reconciler already queries GitHub each tick; it adds one read of the latest completed `main-health-monitor` run for the current `origin/main` head and reports `main: RED at <sha> (<run url>)` with a `route-to-planner` entry, keyed on the sha so it is sent once (the dedupe of AISDLC-924), and `main: green` clears it. 4. Accelerated: the planner hears about a red main on the first tick after the run completes, instead of the operator reading email and relaying it. 5. Automated: workflow test that the issue step and its labels are gone; reconciler tests for red, green, no completed run, and once-per-sha.

The health-check and gate-scripts jobs, the daily schedule and the step summary are unchanged; only the alert transport moves.

## Acceptance Criteria

- [ ] `main-health-monitor.yml` no longer creates issues or labels; a failed run still fails the workflow and writes the step summary.
- [ ] `.github/workflows/__tests__/main-health-monitor.test.mjs` asserts the absence of `gh issue create` and of the `main-red` label; `label-manifest.json` drops `main-red` if nothing else uses it.
- [ ] The dispatch tick reports `main: RED at <sha>` with the run URL as a `route-to-planner` item once per sha, and `main: green` otherwise; a sha with no completed run reports `main: unknown` and routes nothing.
- [ ] `reconcile.test.ts` covers red, green, unknown and the once-per-sha behaviour.
- [ ] `docs/operations/main-health-monitor.md` describes the tick as the notification path and drops the issue triage steps that assume an issue exists.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Issue #1508 is resolved by the operator by hand; agents do not resolve issues. Observed 2026-10-15: last three completed main-health runs green while #1508 stayed open, so a new red would have been swallowed by the duplicate guard.
