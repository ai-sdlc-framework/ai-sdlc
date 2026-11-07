---
id: AISDLC-1215
title: 'Bounded policy consistency check at config validation'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - config validation
  - compliance
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - pipeline-cli/src/tui/config-browser/validator.ts
  - pipeline-cli/src/hierarchy/operational.ts
  - .ai-sdlc/review-policy.md
priority: medium
dispatchable: true
---

## Description

**Source.** RFC-0062 OQ-6 (DEC-0390, 2026-11-06). Affected surface: config validation for autonomy policies and quality-gate enforcement levels in `pipeline-cli/src/tui/config-browser/validator.ts` and the operational policy loader `pipeline-cli/src/hierarchy/operational.ts`, and the compliance artefact directory.

Contradictory rules (a path both always-allowed and always-blocked; an enforcement level no rule can reach) are a silent misconfiguration class today. The operator chose a bounded native check over an SMT dependency.

## Scope

- Pairwise contradiction and shadowing checks over the rule sets, polynomial, no size limit.
- Full reachability of each enforcement level by truth table, bounded by `maxPolicyVariables` (default 20) declared in the config schema; exceeding the limit fails validation with a message naming the limit, never a silent skip.
- Artefact: on a finding, write the pair of rule ids and a witness assignment under `compliance/policy-consistency/`; validation exits non-zero.
- No new dependency; the Z3 alternative is closed by DEC-0390.

## Acceptance Criteria
- [ ] #1 A fixture with two contradicting autonomy rules fails validation and the artefact names both rule ids and a witness assignment.
- [ ] #2 A fixture whose `enforce` level is unreachable fails validation with the level named.
- [ ] #3 A fixture with 21 variables fails validation with a message naming `maxPolicyVariables`; 20 passes in under one second.
- [ ] #4 `package.json` gains no dependency; the check is documented in `docs/operations/`.
