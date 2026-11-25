---
id: AISDLC-1404
title: 'Decision rubric checks the causes of reversed decisions'
status: Done
assignee: []
created_date: '2026-11-24'
labels:
  - plugin
  - skills
  - decision-catalog
dependencies: []
references:
  - ai-sdlc-plugin/skills/decision-rubric/SKILL.md
  - ai-sdlc-plugin/skills/rfc-oq-walkthrough/SKILL.md
priority: high
---

## Description

**Five-step review (requirements first).** The rubric exists to keep the operator from rubber-stamping an author's lean; that requirement still holds (operator, 2026-05). A review of about 37 reversed or amended decisions (planner, 2026-11-23) found rubber-stamping caused 2 of them; 9 of 18 amended RFC resolutions had used the full rubric. The rest came from causes the rubric never checked: undefined records or untested guards (~11), unchecked facts (~10), the right answer missing from the options (~7), a requirement that shouldn't have existed (~6), no domain review (2). Nothing in the skill is deleted; "industry research" is replaced by tagged evidence, and three steps are added.

Operator approved the rewrite 2026-11-24 ("do the recommended actions, the rubric").

## Fix

- `decision-rubric/SKILL.md`: six steps (question the requirement; problem statement; evidence tagged checked or unchecked, standard status always checked; options plus "what would reject all of these?"; recommendation, counter-argument, dependency trace, silent-failure line, guard run against a real event; domain review). Presentation is decision first (pick, cost, the one thing to check, your call), options stay clickable. The recorded rationale carries `Check:` and `Provisional:`. Autonomous mode checks for an open duplicate before `add`.
- `rfc-oq-walkthrough/SKILL.md`: Phase 2 names the domain owners; Phase 3 uses the six steps and stresses the trace; the Resolution shape gains Requirement, Evidence tags, Depends on, Check and Provisional.

## Acceptance Criteria

- [x] #1 The rubric has the six steps, each tied to a cause in the review table.
- [x] #2 The presentation opens with the pick, cost, one thing to check and the call, and all 3-4 options stay clickable.
- [x] #3 `rfc-oq-walkthrough` matches the six steps and the new Resolution shape.
- [x] #4 `node --test ai-sdlc-plugin/skills/skills.test.mjs` and prettier pass.
