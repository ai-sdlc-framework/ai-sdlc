---
id: AISDLC-1097
title: 'merge-without-queue: docs, sync-branch-protection and the reconciler agree on the up-to-date rule, and a PR GitHub disarms is re-armed by the reconciler'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - ci
  - hierarchy
priority: medium
dispatchable: true
dependencies: []
references:
  - docs/operations/merge-without-queue.md
  - scripts/sync-branch-protection.sh
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - .github/workflows/auto-enable-auto-merge.yml
---

## Description

Workflow audit 2026-10-28. `docs/operations/merge-without-queue.md` says the required-status rule is `strict=false` so a BEHIND PR merges as-is, while `scripts/sync-branch-protection.sh` sets `STRICT=true` and the same doc contradicts itself further down. With strict on, every merge on main disarms the other green PRs as BEHIND; the workflow that re-armed on dequeue was deleted and `auto-enable-auto-merge.yml` arms only on opened, reopened and ready_for_review, so a PR that GitHub disarms stays unarmed until a person runs `cli-merge-if-eligible --arm`. Nine of the fifteen open PRs today are BLOCKED or BEHIND with auto-merge on, and the arm is lost on the next rebase.

## Fix

**Five-step review (requirements first).** The requirement questioned is "strict up-to-date so a merge never lands on a stale base": the gate already reruns on every head and `main-health-monitor` catches a bad main, so strictness buys a second run of the same suite per merge on main; the real requirement is "a green PR merges without a person touching it". Deleted: the contradicting paragraph and, if the operator keeps strict on, the claim that BEHIND merges as-is. Simplified: one source of truth, the script, with the doc generated from its variables. Accelerated: a disarmed green PR is re-armed on the next tick. Automated: a reconciler row `green + CLEAN|BEHIND + not armed → arm`, and a test that the doc and script agree.

1. Decision input for the operator, class (b), filed as a catalog record by the planner before dispatch: keep `STRICT=true` (each merge disarms siblings, reconciler re-arms and update-branches) or set `STRICT=false` (BEHIND merges, main-health-monitor is the backstop). The task implements whichever option the record on `main` names; the default if none lands in the timebox is `STRICT=false` (DEC-0048 velocity).
2. `sync-branch-protection.sh` and `merge-without-queue.md`: same value, a test in `scripts/` greps both.
3. `reconcile.ts` / `land-eligible.ts`: `green + not armed` → `arm` for task, docs and deps lanes (depends on the lanes from AISDLC-1091; implement against the current table if 1091 has not landed, the row is additive).
4. `auto-enable-auto-merge.yml`: add `synchronize` to the trigger so a push re-arms, guarded by the existing trusted-author check.
5. Docs: one "Up-to-date rule" paragraph with the chosen value and why.

## Acceptance Criteria

- [ ] `scripts/sync-branch-protection.sh` and `docs/operations/merge-without-queue.md` state the same strict value and a test fails when they differ.
- [ ] A green task PR whose auto-merge was dropped is re-armed by the next reconcile run.
- [ ] A push to an open trusted PR re-arms it through the workflow.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
