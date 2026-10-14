---
id: AISDLC-892
title: 'docs(operations): the living operations pages stop describing cli-orchestrator tick, the AUTONOMOUS_ORCHESTRATOR flag, the TUI and deleted workflows as current'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [docs, docs-platform, velocity]
dependencies:
  - AISDLC-891
references:
  - docs/operations/README.md
  - docs/operations/usage-ledger.md
  - docs/operations/billing-and-cost-optimization.md
  - docs/operations/backlog-and-execution-reference.md
  - docs/operations/copilot-spawner.md
  - docs/operations/copilot-execution-path.md
  - docs/operations/recovery-flows.md
  - docs/operations/release-and-plugin-reference.md
  - docs/operations/model-routing.md
  - docs/operations/signal-ingestion.md
  - docs/operations/dispatched-session-decisions.md
  - docs/operations/pre-push-and-ci-reference.md
  - docs/operations/merge-without-queue.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Context

Operator request 2026-10-14: "ensure that our documentation is up to date in the docs folder". Second of three tasks (AISDLC-891 deletes whole-subject stale files; AISDLC-893 fixes reviewer-count claims and adds the gate). This one corrects stale sentences in pages that are otherwise current. Survey findings (planner, 2026-10-14):

- `docs/operations/README.md:19` `**Feature flag:** AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`; line 16 links the orchestrator promotion runbook and lists the TUI.
- `usage-ledger.md:439` documents a TUI usage pane (`AI_SDLC_TUI=experimental`); line 130 hooks on the "orchestrator tick".
- `billing-and-cost-optimization.md:22,70` recommend `cli-orchestrator tick`; line 88 describes `/ai-sdlc orchestrator-tick` as the Conductor.
- `backlog-and-execution-reference.md:89,91` list `cli-orchestrator tick` modes (Pattern Y) next to the line that says they are superseded.
- `copilot-spawner.md:65` and `copilot-execution-path.md` treat `cli-orchestrator tick` as the "autonomous umbrella".
- `recovery-flows.md:204` says tick is the default.
- `release-and-plugin-reference.md:52` says `check-orchestrator-state.sh` is "called by `cli-orchestrator tick`" (it is called by `cli-hierarchy tick`).
- `model-routing.md:337` and `signal-ingestion.md:498` hook behaviour into the "orchestrator tick".
- `dispatched-session-decisions.md:240` lists "tmux execute-parallel" as a current write path.
- `pre-push-and-ci-reference.md:54` documents the AUTONOMOUS_ORCHESTRATOR flag as current ("On by default since AISDLC-411").
- `merge-without-queue.md:152` gives restore instructions for `auto-rearm-on-dequeue.yml`, deleted under DEC-0099 (the deletion is noted at line 74 of the same file).

The code for `cli-orchestrator tick` still exists in `pipeline-cli/src/cli/orchestrator.ts`; the policy (CLAUDE.md, AISDLC-763) is that `cli-hierarchy` is the drain. The docs follow the policy.

**Five-step review (requirements first).** Requirement questioned: "every page must explain the history of how we got here". A reader of an operations page needs the current command, not the retired one with a note. Delete: the retired-command sentences, the TUI pane section in `usage-ledger.md`, the restore instructions for a deleted workflow in `merge-without-queue.md`, the Pattern Y rows in `backlog-and-execution-reference.md`. Simplify: where a sentence named `cli-orchestrator tick` as the caller or default, name `cli-hierarchy tick` (or the executor loop) and nothing else. Accelerate: nothing. Automate: the retired-term gate lands in AISDLC-893 after this task so that it starts green.

## Fix

1. For each file and line above, rewrite the sentence to the current behaviour: `cli-hierarchy` (RFC-0051) is the drain, `cli-hierarchy tick` the tick, the executor loop (`/ai-sdlc:executor`) the per-task runner; the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` and `AI_SDLC_TUI` flags are not documented anywhere as current; `execute-parallel` is not a write path. Where the text is a history note that is still useful (for example "superseded by AISDLC-763"), keep one sentence and drop the procedural detail.
2. `docs/operations/README.md`: delete line 19's feature-flag row and the TUI entry; make sure the orchestration row points at `cli-hierarchy.md` (AISDLC-891 removed the orchestrator-promotion link).
3. `merge-without-queue.md`: remove the restore instructions at line 152; the line-74 note that the workflow was deleted under DEC-0099 stays.
4. `backlog-and-execution-reference.md`: remove the Pattern Y rows and leave the "superseded" sentence pointing at `cli-hierarchy.md`.
5. At most 14 files; the list above is the whole scope. Anything else found while editing goes in the PR body as a note, not a change.

## Acceptance Criteria

- [ ] `grep -rn -E 'cli-orchestrator tick|orchestrator-tick|AI_SDLC_AUTONOMOUS_ORCHESTRATOR|AI_SDLC_TUI|execute-parallel|dispatch-worker' docs/operations` returns only lines that say the term is retired or superseded (each such line names AISDLC-763 or the operator TUI retirement), and no line that documents the term as a current command, flag or path.
- [ ] `docs/operations/README.md` has no feature-flag row for the orchestrator and no TUI entry.
- [ ] `merge-without-queue.md` has no restore procedure for `auto-rearm-on-dequeue.yml`.
- [ ] `release-and-plugin-reference.md` names `cli-hierarchy tick` as the caller of `check-orchestrator-state.sh`.
- [ ] The PR body lists any further stale claim noticed but left out of scope.

**Velocity impact.** Positive: agents reading these pages (they are the CLAUDE.md pointers) stop being told to run a retired command.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, docs only); operator-requested 2026-10-14.
