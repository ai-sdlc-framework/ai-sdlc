---
id: AISDLC-816
title: >-
  Definition of done: delivered (ready and armed) frees the executor, landed (merged) writes done/; fresh claims pause while this executor has an undelivered PR (amended 2026-10-14 under RFC-0054)
status: To Do
assignee: []
created_date: '2026-10-11'
labels:
  - hierarchy
  - rfc-0054
  - phase-2
  - governance
  - rfc-0051
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - pipeline-cli/src/dispatch/
priority: critical
dispatchable: true
---

## Description

**Amended in place 2026-10-14 under RFC-0054 OQ-2, OQ-5 and OQ-9 (id kept).** The two-word definition replaces the single "done = merged": `delivered` = PR ready and auto-merge armed, the executor's verdict outcome, frees its slot; `landed` = merged, the only event that writes `done/`, performed by the state machine (AISDLC-829), not by the executor. "Unlanded" below is to be read as "undelivered" and "dispatch tick flips" as "the executor flips through the guarded runner (AISDLC-881); the machine flips only when it takes over a dead executor's PR".

Operator instruction 2026-10-11 (Dominique), recorded as DEC-0127: the open PR list reached 32 and kept growing while 80 PRs merged in 24 hours, because the pipeline hands back at "PR open" (Step 11) and nothing owns the landing. Definition of done becomes "PR on main".

**Five-step review (requirements first).**
1. Requirement questioned: "done at PR open" from the Step 11 hand-back design (RFC-0012) and the executor loop (RFC-0051). Set when CI was fast and merges were human; today a PR that is opened and abandoned costs a resume round later.
2. Delete: the hand-back at open. An executor does not report success for an open PR.
3. Simplify: one definition for the executor verdict, the dispatch board and `cli-hierarchy status`: `success` = PR armed and green (auto-enable lands it); `done/` = PR merged. A task whose PR goes red after hand-back is re-entered by the same executor (resume) before any fresh claim.
4. Accelerate: dispatch flips ready drafts and arms eligible PRs on every tick (REST), so a green PR never waits for a human.
5. Automate: the board refuses a fresh claim while any PR-bearing task is not landed, unless the claim's task is marked as fixing an existing PR (`fixesPr: <n>` in the manifest).

Velocity impact: positive. The PR list stops growing; resume rounds for stale PRs disappear.

## Acceptance Criteria

- [ ] AC-1: An executor verdict `delivered` requires the PR to be non-draft and auto-merge armed at hand-back; otherwise the verdict is `iterate-needed` naming the unmet condition. `success` at PR-open no longer exists as an outcome.
- [ ] AC-2: The board writes `done/` only when the PR has merged (`landed`), performed by the state machine reconciler (AISDLC-829) from `landing/<pr>.json`; until then the task is `landing` and re-entry goes through `reenter` (AISDLC-882).
- [ ] AC-3: `cli-dispatch claim` refuses a fresh task for an executor that has an undelivered PR (its own `landing/` record with owner `executor:<name>` and no `delivered` timestamp), unless the fresh task's manifest carries `fixesPr`. Error names the blocking PR. A delivered-but-unlanded PR does not block.
- [ ] AC-4: Arming happens through `auto-enable-auto-merge.yml` on `ready_for_review`; the state machine arms through `cli-merge-if-eligible --arm` (REST) only when that was missed. The executor flips its own PR (AISDLC-881); the machine flips only on takeover.
- [ ] AC-5: `cli-hierarchy status` shows per executor the PR it is landing and its state.
- [ ] AC-6: `docs/operations/cli-hierarchy.md` and CLAUDE.md "Done semantics" state the new definition in one paragraph each.

## Notes

Origin: 2026-10-11 PR-pressure instruction; brief `tasks-aisdlc-814-plus-27.md` is the manual drain this task automates. Related: AISDLC-800 (board invariants), AISDLC-807 (resume accepts iterate-needed), AISDLC-815 (clear on threshold).
