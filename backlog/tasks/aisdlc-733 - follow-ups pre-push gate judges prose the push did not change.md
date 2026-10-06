---
id: AISDLC-733
title: >-
  Follow-ups pre-push gate judges prose the push did not change
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - gates
  - friction
dependencies: []
references:
  - scripts/check-followups-on-push.sh
  - scripts/check-followups.test.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tier 1 friction. On PR #1214 (AISDLC-712) the gate (`scripts/check-followups-on-push.sh`, from AISDLC-645) refused a push because seven completed task files were touched only to fix dead script references (AISDLC-125, 148, 378, 383.5, 645, 706, 712). It then evaluated their pre-existing "Follow-up" sections. The push went through with the documented `AI_SDLC_SKIP_FOLLOWUP_GATE=1`, disclosed.

Same defect class as the old readiness range gate (DEC-0048): a gate must not fire on content the branch did not change. This task removes friction.

## Acceptance Criteria
- [ ] The gate evaluates only follow-up items that the pushed commits add or change.
- [ ] A completed task file touched outside its Follow-up section passes.
- [ ] Test fixtures for both cases (item added or changed is judged; unrelated edit passes) in `scripts/check-followups.test.mjs`.
- [ ] The refusal message names the item and the two accepted fixes.

## Velocity impact
Prevents the gate from refusing pushes for prose the branch did not touch. The happy path gets zero new prompts and fewer refusals than today. When the gate does refuse, it names the specific item and the two accepted fixes, so the agent fixes it in one step with no skip variable.
<!-- SECTION:DESCRIPTION:END -->
