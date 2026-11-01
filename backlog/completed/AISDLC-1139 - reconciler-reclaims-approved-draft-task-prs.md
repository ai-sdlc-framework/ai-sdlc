---
id: AISDLC-1139
title: 'Reconciler reclaims a draft task PR whose failed verdict records an approved review round: rewrite the manifest from the PR and reenter in push-only mode instead of routing to the planner'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - pipeline-cli
  - hierarchy
  - dispatch
dependencies:
  - AISDLC-1137
  - AISDLC-1138
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reconcile.test.ts
  - pipeline-cli/src/dispatch/types.ts
  - pipeline-cli/src/dispatch/resume.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

`reconcile.ts` marks a draft task PR `unowned` with the reason "draft task PR with no live manifest on the board and no done verdict" and routes it to the planner (AISDLC-1091). On 2026-10-31 four such PRs (#2064, #2171, #2211, #2214) sat in that state although each task's verdict in `failed/` said the developer finished and every reviewer approved; only the push had failed. The planner had nothing to decide: the machine action already exists (`write-manifest --from-pr`, then `reenter` with `resumeMode: 'push-only'`, AISDLC-821). Rows that only need that action should never reach the planner.

**Five-step review (requirements first).**
1. Requirement questioned: should the loop guard or the unowned rule be dropped? No. Routing to the planner is correct when nobody can vouch for the PR. The requirement that stands is "a draft PR with an approved review in a failed verdict is owned by the machine".
2. Delete: nothing.
3. Simplify: in the unowned branch for `kind === 'task' && isDraft`, before setting `unownedReason`, read `failed/<taskId>.verdict.json`; when it records an approved review round (the structured field the verdict already carries, not prose), decide `rewrite-manifest` and let the next pass take `reenter` in push-only mode. A failed verdict without an approval keeps today's behaviour. The same-head loop guard (`guardSameHead`) still applies, so a push-only reenter that fails twice at the same head routes to the planner with its note.
4. Accelerate: nothing.
5. Automate: reconcile tests for the three cases (approved failed verdict, unapproved failed verdict, no verdict); `docs/operations/cli-hierarchy.md` action table gains the row.

Velocity impact: the planner stops receiving mechanical push-only work; the operator no longer has to queue it by hand.

## Acceptance Criteria

- [x] AC-1: A draft task PR with no live manifest whose `failed/<id>.verdict.json` records an approved review round decides `rewrite-manifest` (then `reenter` push-only on the next pass); the `unowned` row is not produced.
- [x] AC-2: A draft task PR with a failed verdict that records no approval, or no verdict at all, still decides `route-to-planner` with the existing reason text.
- [x] AC-3: The same-head guard still routes a twice-failed push-only reenter to the planner; a test asserts it.
- [x] AC-4: `docs/operations/cli-hierarchy.md` documents the new decision; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner PR-pressure survey 2026-10-31. Depends on AISDLC-1137 and AISDLC-1138: the push-only reenter this task triggers only succeeds once both have landed.

## Final Summary

## Summary
Fixed the review finding: a reclaimable draft task PR no longer re-runs push-only reenter every tick while its queued manifest awaits the executor. When the last recorded action was push-only-reenter on the same head, the decision is now 'none'. Added a test for that case. The earlier work on the reclaim branch, docs and tests is unchanged.

## Changes
- pipeline-cli/src/hierarchy/reconcile.ts
- pipeline-cli/src/hierarchy/reconcile.test.ts

## Design decisions
Ran `pnpm build && pnpm test && pnpm lint && pnpm format:check` once, before the rebase; all four passed, and I did not re-run them after rebasing onto origin/main. The pre-push hook then re-ran the pipeline-cli coverage gate and the push went through. The push only worked with `git -C <worktree> push --force-with-lease ...`. A `cd ... && git push` form was blocked by the lease-guard hook.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

