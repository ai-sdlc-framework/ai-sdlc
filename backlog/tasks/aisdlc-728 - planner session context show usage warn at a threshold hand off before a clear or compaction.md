---
id: AISDLC-728
title: >-
  Planner session context: show usage, warn at a threshold, hand off before a clear or compaction
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - hierarchy
  - cost
dependencies: []
references: []
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The long-lived planner session accumulates context from cross-session messages and rulings. Main sessions are the largest token consumer in the usage ledger: the first call of a main session carries about 71 thousand tokens, and 77.7 percent of all tokens in the first days of October 2026 were main-session calls. The operator clears the planner by hand when he notices the meter, around 40 to 46 percent, and the planner cannot see its own usage. Operator request 2026-10-05: a process for indicating and triggering compaction or clearing on the planner thread.

This is not a governance control: nothing here refuses or blocks.

Claude Code facts gathered 2026-10-04 (verify against current docs before relying on them):
- A `statusLine` command receives JSON with `context_window.used_percentage`.
- A mod (a plugin of function hooks: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`) can read `$.session.usage()`, show a toast or an above-prompt band, and call `$.session.compact({ instructions })` between turns.
- Whether a mod can run `/clear` is unverified.
- PreCompact and SessionStart hooks (sources `compact`, `clear`) can write and re-inject a handoff.

## Conventions
- Hermetic tests; temporary directories come from `mkdtemp`.

## Acceptance Criteria
- [ ] A status line entry shows the session's context percentage, coloured at two thresholds (default 30 and 40 percent, configurable); shipped as a documented snippet or as part of the plugin, working in the terminal.
- [ ] At the upper threshold the session shows a visible prompt (toast or band) that says to hand off and clear, once per crossing, not on every turn.
- [ ] A documented handoff routine for the planner role in the planner skill: on the word "handoff" (or when the warning fires at a turn boundary) the planner writes its handoff note (open rulings, owed items, scheduled jobs and their prompts, next free task and decision ids, what each peer session is waiting on) to its memory directory, and confirms in one line that it is safe to clear.
- [ ] After a clear or compaction the handoff is loaded automatically: a SessionStart hook for sources `clear` and `compact` re-injects the latest handoff note, or the planner skill's first step reads it; scheduled jobs are listed and recreated if the session lost them.
- [ ] If a mod can trigger compaction, the warning offers "compact now with handoff instructions" as one action; clearing stays a human action unless the docs confirm a supported way to trigger it.
- [ ] Inflow reduction is part of the task: the operator-dispatch skill batches non-blocking questions to the planner into one message (default hourly), and peer messages to the planner are self-contained so they can be answered after a clear.
- [ ] The same status line and warning work for the operator-dispatch and executor sessions, with the executor's existing clear-between-tasks flow unchanged.
- [ ] Docs: one page section in the session-hierarchy operator docs. PR body states what could not be done with the documented mod and hook APIs.

## Out of scope
- Changing model context limits.
- Automatic clearing without the operator.
<!-- SECTION:DESCRIPTION:END -->
