---
id: AISDLC-1184
title: 'Budget pacer draws its line from the known window start, not a stored anchor'
status: In Progress
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

**Five-step review (requirements first).** 1. Requirement questioned: the pacer stores a window start so it knows where the line begins. Claude Code's weekly window is fixed: it starts Tuesday at noon Pacific daylight time (19:00 UTC), operator 2026-11-04, and the usage endpoint already reports its reset. The start is therefore always the reset minus the window length, and use at that moment is 0 by definition. 2. Deleted: the stored `windows` anchor in `usage.json` as an input to the line; `paceOf` draws the line from reset minus `TOTAL_MS[name]` at 0%. Keep the stored entry only if another reader needs it; otherwise remove it and its writer. 3. Simplified: no repair logic, no same-window matching for the line (the AISDLC-1166 tolerance stays where samples are grouped for the burn-rate projection). 4. Accelerated: none needed. 5. Automated: tests below.

Do not hard-code the weekday, hour or time zone. Derive the start from the reported reset, so daylight saving changes and any schedule change follow the endpoint.

## Acceptance Criteria

- [ ] AC-1: `paceOf` draws the line from reset minus the window length at 0%, ignoring any stored anchor. A test reproduces the 2026-11-04 shape (stored start 2026-11-04T21:05Z at 6%, reset 2026-11-10T19:00Z, 7% used at 21:53Z) and asserts a line of about 16% and the pacer allowance unlimited.
- [ ] AC-2: The stored `windows` anchor is removed with its writer, or the PR body names the reader that still needs it.
- [ ] AC-3: `docs/operations/cli-hierarchy.md` states that the line starts at the reset minus the window length, at 0%.
- [ ] AC-4: The PR body states whether any running process still loads a pre-AISDLC-1166 build of `budget.ts` (the plugin cache copy at `ai-sdlc-local/ai-sdlc/0.40.0` lacks `sameWindow`), and how to tell from `cli-hierarchy status`.
