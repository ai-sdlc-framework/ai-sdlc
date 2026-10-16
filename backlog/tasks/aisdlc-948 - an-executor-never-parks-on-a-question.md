---
id: AISDLC-948
title: 'An executor never parks on a question: a blocked step becomes a verdict note and the stall path, since no roster channel reaches an executor'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - executor
  - autonomy
dependencies: []
references:
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - pipeline-cli/src/hierarchy/stall.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

On 2026-10-16 executor-delta, holding the AISDLC-855 claim with eleven unpushed commits in its worktree, stopped and asked the dispatch session whether to push or release. The dispatch session's hard rules forbid messaging an executor or typing into its pane, the planner addresses only the dispatch entry of the roster, and the operator was the only one who could type the answer. The executor sat idle for a tick cycle on a question that had a deterministic answer (push from the claimed worktree, hooks run). The hierarchy has no channel toward an executor by design (assignments come from the board, not from messages), so an executor that waits on a message waits forever.

**Five-step review (requirements first).**
1. Requirement questioned: does an executor ever need an answer mid-task? No: the away rule already says no session opens a question while the operator is away, and the board is the only input an executor reads. The requirement is that a blocked executor finishes deterministically.
2. Delete: the executor's option to ask. The executor command and its rendered prompt rules state that a question has no recipient.
3. Simplify: one rule, "when a step cannot proceed, write the exact refusal and the options into the verdict notes, mark the verdict `failed` or `iterate-needed`, release nothing by force, stop"; the dispatch tick already routes such verdicts to the planner.
4. Accelerate: the stall detector treats an executor whose last output is a question as stalled at once instead of after the idle timeout.
5. Automate: a prompt-rule entry in `prompt-rules.js` rendered into the executor command (one line, AISDLC-651.2 style) and a test that the rendered executor prompt contains it.

Velocity impact: positive; a blocked executor returns the slot within one tick instead of holding it until a human notices.

## Acceptance Criteria

- [ ] AC-1: `prompt-rules.js` has a rule stating that an executor never waits on a question; a blocked step is written to the verdict notes with the refusal text and the options, and the executor stops with a `failed` or `iterate-needed` verdict.
- [ ] AC-2: The executor command renders that rule; the plugin prompt-rule test covers it.
- [ ] AC-3: The dispatch tick's stall path marks an executor whose last message is a question as stalled on the next tick, without waiting for the idle timeout.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` states that no channel reaches an executor and how a blocked executor hands back.

## Notes

Origin: dispatch report 2026-10-16 ~19:50Z on AISDLC-855 (#1652). The push itself was legitimate: the lease-push hook names "an executor holding the claim pushes from its worktree" as the fix.
