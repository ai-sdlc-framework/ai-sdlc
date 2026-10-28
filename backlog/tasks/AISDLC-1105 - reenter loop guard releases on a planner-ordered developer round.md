---
id: AISDLC-1105
title: >-
  cli-dispatch reenter: the same-head loop guard releases on a planner-ordered developer round (escalate records but never unblocks)
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The same-head loop guard in `pipeline-cli/src/hierarchy/reenter.ts` refuses a second `reenter` with the same `(route, headSha)` and tells the caller to "push a new head, or route it to the planner with `cli-decisions escalate`". The escalate command only records a decision; nothing reads it back, so after the planner rules the guard still refuses. On 2026-10-28 three failed PRs (#1910, #2051, #2055, all semantic rebase conflicts in `dispatch-loop.ts` or `cli-hierarchy.md`) could not be re-entered for the developer round the planner ordered: the developer round is the only path that produces the new head the guard waits for, so the guard deadlocks exactly the case it names as its escape.

**Five-step review (requirements first).** Requirement questioned: "the same action on the same head is never taken twice". The guard exists to stop an automated loop (reconcile re-routing the same PR every tick), not to block an explicit planner order. Deletion: nothing to delete; the guard keeps protecting the automated path. Simplified: a `--developer-round` reenter that carries a `--note` is a distinct action key (`executor:dev-round:<note-hash>`), so an order with new instructions is never "the same action". Accelerated: no planner round-trip through the catalog for a ruling the planner already made. Automated: `reenter --decision DEC-NNNN` additionally accepts an answered catalog record as the release token and writes the decision id into the guard entry, for the cases where the note is unchanged.

Fix: key the guard on `(route, headSha, noteHash)` for developer-round reenters; add `--decision <id>` that releases the guard when the catalog holds an answered record scoped to the task; keep the plain-route refusal unchanged; update the refusal message to name both releases; document in `docs/operations/cli-hierarchy.md` under the loop guard paragraph.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A second `reenter <pr> --developer-round --note <different text>` on the same head is accepted and records the note hash in the guard entry (test in `reenter.test.ts`).
- [ ] A second reenter with the identical note on the same head is still refused (test).
- [ ] `reenter <pr> --decision DEC-NNNN` releases the guard when the catalog holds an answered record for the task, and refuses when the record is open or unrelated (test).
- [ ] The automated reconcile route-to-planner behaviour in `reconcile.ts` is unchanged (existing tests green).
- [ ] `docs/operations/cli-hierarchy.md` documents the two release paths.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: dispatch report 2026-10-28 22:40Z (loop guard refusal on #1910 after the planner's developer-round ruling); earlier refusals on #2051 and #2055 at 20:45Z. Interim workaround ruled by the planner: run the conflict resolver on the PR to push a new head, then reenter.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`: pipeline-cli `Tests 14 failed | 12211 passed | 13 skipped (12238)`; all 14 failures are in `executor-start.test.ts`, caused by the executor session env (`AI_SDLC_EXECUTOR_TASK`) leaking into the test; with that env unset the file shows `Tests 24 passed (24)`. reenter.test.ts and dispatch.test.ts pass. Lint and format:check clean.
