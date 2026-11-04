---
id: AISDLC-1184
title: 'Budget pacer repairs a stale weekly window start instead of pacing from it'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - hierarchy
  - budget
  - fix
dependencies: []
references:
  - pipeline-cli/src/hierarchy/budget.ts
  - pipeline-cli/src/hierarchy/executor-cap.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Source.** Operator in the planner session, 2026-11-04: "The budget pacer is wrong we just reset the budget and we have lots of head room to develop tasks."

**Symptom.** At 2026-11-04T21:53Z the seven-day window had 7% used, with its reset at 2026-11-10T19:00Z. A straight line from the true window start (reset minus 7 days, 2026-11-03T19:00Z) puts the allowed use at about 16%. The pacer reported the line at 6.5% and "ahead 0.5 points", so it held the executor cap at 1.

**Cause (verified in the planner session).** `<board>/usage.json` `windows.sevenDay` read `{ at: 2026-11-04T21:05:37Z, utilization: 6 }`, although samples in the same window go back to 2026-11-03T21:58Z at 2%. Before AISDLC-1166 (#2319, merged 2026-11-04T20:57Z), `recordUsage` compared reset times by exact string, so any jitter in a sample's reset time rewrote the window start. The last write under the old code anchored the window at 21:05Z. AISDLC-1166 stops new re-anchoring, but `paceOf` still trusts the stored start, so a stale anchor persists until the next reset. The plugin cache copy at `ai-sdlc-local/ai-sdlc/0.40.0` still lacks `sameWindow`, so any process loading it keeps re-anchoring.

**Workaround in place.** The planner ran `cli-hierarchy resume --budget` at 2026-11-04T21:54Z, which exempts this week until its reset.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the pacer needs the utilization at the window start only to draw its line. The window start time is already known exactly, as the reset time minus the window length. 2. Deleted: trusting a stored `at` later than the earliest sample in the same window. 3. Simplified: anchor `t0` to the earliest sample in the same window (with its utilization), else the computed window start with utilization 0. 4. Accelerated: no new state. 5. Automated: a test covers the re-anchored file shape.

## Acceptance Criteria

- [ ] AC-1: `paceOf` never uses a window start later than the earliest retained sample in the same window (same-window comparison within the AISDLC-1166 tolerance); a test reproduces the 2026-11-04 shape (stored start 21:05Z at 6%, samples from 2026-11-03T21:58Z at 2%) and asserts the line is drawn from the earlier sample.
- [ ] AC-2: `recordUsage` repairs a stored window start that is later than the earliest same-window sample, with a test.
- [ ] AC-3: `docs/operations/cli-hierarchy.md` states how the window start is chosen.
- [ ] AC-4: The PR body states whether any running process still loads a pre-AISDLC-1166 build of `budget.ts`, and how to tell from `cli-hierarchy status`.
