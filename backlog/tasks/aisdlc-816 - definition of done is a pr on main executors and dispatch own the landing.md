---
id: AISDLC-816
title: >-
  Definition of done is a PR on main: executors and dispatch own the landing, fresh claims pause while open PRs are unlanded
status: To Do
assignee: []
created_date: '2026-10-11'
labels:
  - hierarchy
  - governance
  - rfc-0051
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - pipeline-cli/src/dispatch/
priority: critical
dispatchable: true
---

## Description

Operator instruction 2026-10-11 (Dominique), recorded as DEC-0127: the open PR list reached 32 and kept growing while 80 PRs merged in 24 hours, because the pipeline hands back at "PR open" (Step 11) and nothing owns the landing. Definition of done becomes "PR on main".

**Five-step review (requirements first).**
1. Requirement questioned: "done at PR open" from the Step 11 hand-back design (RFC-0012) and the executor loop (RFC-0051). Set when CI was fast and merges were human; today a PR that is opened and abandoned costs a resume round later.
2. Delete: the hand-back at open. An executor does not report success for an open PR.
3. Simplify: one definition for the executor verdict, the dispatch board and `cli-hierarchy status`: `success` = PR armed and green (auto-enable lands it); `done/` = PR merged. A task whose PR goes red after hand-back is re-entered by the same executor (resume) before any fresh claim.
4. Accelerate: dispatch flips ready drafts and arms eligible PRs on every tick (REST), so a green PR never waits for a human.
5. Automate: the board refuses a fresh claim while any PR-bearing task is not landed, unless the claim's task is marked as fixing an existing PR (`fixesPr: <n>` in the manifest).

Velocity impact: positive. The PR list stops growing; resume rounds for stale PRs disappear.

## Acceptance Criteria

- [ ] AC-1: An executor verdict `success` requires the PR to be non-draft, armed and with `ai-sdlc/pr-ready` green at hand-back; otherwise the verdict is `iterate-needed` naming the failing check. Enforced in the verdict writer, with tests.
- [ ] AC-2: The board moves a task to `done/` only when its PR has merged (dispatch tick checks via REST); until then it is `landing/` (new state) and is the executor's to resume if it goes red.
- [ ] AC-3: `cli-dispatch claim` refuses a fresh task while any `landing/` task is red or unarmed, unless the fresh task's manifest carries `fixesPr`. Error names the blocking PR(s).
- [ ] AC-4: Dispatch tick flips clean drafts to ready and arms eligible PRs through `cli-merge-if-eligible --arm` (REST, no GraphQL).
- [ ] AC-5: `cli-hierarchy status` shows per executor the PR it is landing and its state.
- [ ] AC-6: `docs/operations/cli-hierarchy.md` and CLAUDE.md "Done semantics" state the new definition in one paragraph each.

## Notes

Origin: 2026-10-11 PR-pressure instruction; brief `tasks-aisdlc-814-plus-27.md` is the manual drain this task automates. Related: AISDLC-800 (board invariants), AISDLC-807 (resume accepts iterate-needed), AISDLC-815 (clear on threshold).
