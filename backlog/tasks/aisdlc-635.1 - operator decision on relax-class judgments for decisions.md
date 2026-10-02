---
id: AISDLC-635.1
title: >-
  Operator decision: whether to add relax-class judgments for reversible promotion, pillar replacement and Stage B scores above 0.5
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - operator-decision
dependencies:
  - AISDLC-635
  - AISDLC-641
references:
  - reference/src/judgment/catalog/decision-stage-b-signals.ts
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
priority: low
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This is an operator decision, not dispatchable work. The decision judgments shipped with the conservative form because three behaviours would reduce review and a seam definition may not do that: promoting a judged `reversible` to the gating reversibility, replacing the keyword pillar set with the judged set, and letting Stage B signals rise above 0.5 (see `reference/src/judgment/catalog/decision-stage-b-signals.ts` and the decision wiring in `pipeline-cli/src/decisions/judged.ts`). Decide whether to add relax-class definitions for any of them, each under the 0.95 precision corpus bar with no override path, and only after the shadow data from the live validation task exists. RFC-0049 section 4 allows relaxing only on a bidirectional definition, and the first version names a single relax-class judgment, so a yes needs an RFC amendment first. Route through rfc-planner to the operator.

## Acceptance Criteria
- [ ] The operator records a decision for each of the three behaviours (add as a relax-class definition, or keep the conservative form) with the shadow evidence that supports it.
- [ ] If any is added, an RFC-0049 amendment and a new task per definition exist before implementation.
<!-- SECTION:DESCRIPTION:END -->
