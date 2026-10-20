---
id: AISDLC-957
title: >-
  Delete the dor-rerun-on-filing-merge workflow: the reconciler already
  re-enters a red filing PR when its blocker lands
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - ci
  - dor
  - cost
dependencies: []
references:
  - docs/operations/dor-ingress-gate.md
priority: medium
dispatchable: true
drift_log:
  - date: '2026-10-17'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .github/workflows/dor-rerun-on-filing-merge.yml
    resolution: flagged
drift_checked: '2026-10-17'
---

## Description

`dor-rerun-on-filing-merge.yml` runs on every push to main that touches `backlog/tasks/**`, lists every open PR on a no-task branch prefix, and reruns the gate run of each one (two API calls per PR plus a full gate run and an attestation-post run each). Since the DoR gate stopped resolving task ids found in body prose, a filing PR almost never goes red because a sibling has not landed, and the hierarchy reconciler already re-enters a red PR when its state changes. The workflow now mostly reruns green gates.

**Five-step review (requirements first).**
1. Requirement questioned: does a task-file landing on main need to rerun other filing PRs? Not any more; the DoR prose-resolution rule that made it necessary is gone.
2. Delete: the workflow file and its documentation paragraph.
3. Simplify: nothing left to simplify.
4. Accelerate: each task-file landing stops starting N extra gate and attestation-post runs.
5. Automate: the reconciler reenter path, already in place, covers the rare real case; the runbook names it as the recovery.

## Acceptance Criteria

- [ ] `.github/workflows/dor-rerun-on-filing-merge.yml` is removed; no other workflow or doc references it.
- [ ] `docs/operations/dor-ingress-gate.md` names the reconciler reenter as the recovery for a filing PR red on a not-yet-landed sibling.
