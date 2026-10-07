---
id: AISDLC-741
title: >-
  Context discipline in the hierarchy command bodies: dispatch self-clears
  after every tick, planner clears at 150k
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - hierarchy
  - plugin
  - cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/operator-dispatch.test.mjs
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/planner.test.mjs
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 48-hour token audit (to 2026-10-06 17:00 PDT) of all Claude Code sessions on the operator's machine found 7,163 model calls, 1.38 billion cache-read tokens and 3.1 million output tokens. Cache reads were 86% of the cost weight. Orchestration sessions (dispatch, planners) were 80% of spend; all developer and reviewer subagents together were 20%. The ai-sdlc dispatch session ran 382 calls on one context that grew from 90k to 640k tokens (343k average) without a clear. The planner averaged 176k and peaked at 462k. A freshly cleared session starts at about 90k tokens. The operator's rule (2026-10-06): one task per executor context, dispatch clears after every tick, planner hands off and clears at 150k.

Today Step 5 of the dispatch command body schedules a 60 s ScheduleWakeup and keeps the same context forever. The planner body has no context ceiling. Neither body tells the session to read its handoff file after a clear. The plugin runs from the installed cache, so until this lands the rule lives only in the dispatch handoff memory file (`.claude/memory/operator-dispatch-handoff.md`, rule 2), which already carries a working recipe: as the last Bash call of a tick, `P="${TMUX_PANE:?}"; nohup bash -c "sleep 20; tmux send-keys -t '$P' -l -- '/clear'; tmux send-keys -t '$P' Enter; sleep 60; tmux send-keys -t '$P' -l -- '/ai-sdlc operator-dispatch'; tmux send-keys -t '$P' Enter" >/dev/null 2>&1 &` then end the turn with one line.

Velocity impact: zero prompts; every dispatch tick starts from the floor (about 110k) instead of a context that grows without bound; estimated two-day saving about $230 of weight on the dispatch session alone, and no more usage-limit stalls caused by the dispatch session.

Out of scope: changing the tick cadence, moving dispatch to another model, executor changes beyond the handoff read.

## Acceptance Criteria
- [x] Step 5 of `operator-dispatch.md` is replaced: refresh the handoff file if anything changed, then self-clear and re-issue `/ai-sdlc operator-dispatch` 60 s later, through a `cli-hierarchy clear --self [--resume-after <seconds>]` subcommand (preferred, with unit tests in `pipeline-cli/src/hierarchy/clear.test.ts` covering: own pane only, resolved from the roster entry of the calling session, refuses when the caller is not the dispatch session, sends `/clear` then the resume command after the delay) OR, if the subcommand cannot be made safe in this task, the inline recipe above with `TMUX_PANE` guarded. No ScheduleWakeup on the normal path; a fallback ScheduleWakeup of 60 s only when `TMUX_PANE` is unset, announced in the tick line.
- [x] A new Step 1.5 in `operator-dispatch.md`: read the dispatch handoff file (auto-memory directory, `operator-dispatch-handoff.md`) before the tick when it exists, and refresh it before a self-clear whenever the queue, standing rules or open-PR list changed.
- [x] `planner.md` gains a "Context ceiling" section: hand off (write the dated handoff memory file) and `/clear` when the status line's context indicator reaches 15% of the window (150k tokens), without exception; keep the handoff file current as rulings happen, not at the end; never run review rounds or orchestration loops in the planner context when they can be delegated.
- [x] `executor.md` says in one sentence that the executor runs exactly one task per context and waits to be cleared (already the behaviour; make it explicit).
- [x] The command tests (`operator-dispatch.test.mjs`, `planner.test.mjs`) assert the new sections (self-clear or `clear --self`, handoff read, "Context ceiling", 150k).
- [x] The hierarchy operations doc (`docs/operations/parallel-dispatch.md`) describes the per-tick clear and the planner ceiling in one short paragraph each.
- [x] Velocity impact paragraph in the PR body.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added `cli-hierarchy clear --self [--resume-after <s>]` and rewired the dispatch command body so the dispatch session clears its own context after every tick and re-issues `/ai-sdlc operator-dispatch`; the planner gets a 150k "Context ceiling" rule and the executor states one task per context.

## Changes
- `pipeline-cli/src/hierarchy/clear.ts` (modified): `clearSelf()` resolves the caller's own roster pane, validates it, and schedules a detached `sh -c` (argv-only) that types `/clear` then the resume command after the delay.
- `pipeline-cli/src/cli/hierarchy.ts`, `pipeline-cli/src/hierarchy/index.ts` (modified): `clear --self` wiring behind the dispatch caller guard.
- `pipeline-cli/src/hierarchy/clear.test.ts` (modified): own-pane, roster-resolved, non-dispatch refusal, delay and ordering tests.
- `ai-sdlc-plugin/commands/operator-dispatch.md` (modified): new Step 1.5 handoff read; Step 5 self-clear, ScheduleWakeup only when `TMUX_PANE` is unset.
- `ai-sdlc-plugin/commands/planner.md`, `executor.md` (modified): Context ceiling section; one-task-per-context sentence.
- `operator-dispatch.test.mjs`, `planner.test.mjs` (modified): assert the new sections.
- `docs/operations/parallel-dispatch.md` (modified): per-tick clear and planner ceiling paragraphs.

## Design decisions
- **Subcommand over inline recipe**: argv-only spawn with roster-derived, validated pane id avoids shell interpolation; the inline tmux recipe stays out of the command body.

## Verification
- `pnpm build` — clean
- `pnpm test` — pipeline-cli src/hierarchy 388 passed; plugin command tests pass except execute.test.mjs (model routing) and no-bare-paths.test.mjs, which fail identically on main; 4 bin-invocation.test.ts failures in src/cli not from this diff
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviews approved (code and security approved; test review re-run on the Claude-native reviewer after Codex hit its usage limit)

## Follow-up
- declined: reviewer suggestions (chain detached script with `&&`, `child.on('error')` listener, require `TMUX_PANE` when set-check, CLI-level test for `clear --self`) are non-blocking minor/suggestion items; left for the operator to schedule.
<!-- SECTION:FINAL_SUMMARY:END -->
