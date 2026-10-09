---
id: AISDLC-781
title: >-
  context profiles schema, role defaults and change path
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-779
  - AISDLC-780
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/lib/role-tool-policy.js
  - pipeline-cli/src/cli/index.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define `.ai-sdlc/context-profiles.yaml`, as resolved by OQ-8. A profile sets enabled moments, per-moment token budget, relevance floor, trunks in scope and a cap of maximum injections per N turns. Role is the primary key and model alias a secondary override. Ship the role defaults: planner all moments at the largest budgets; operator-dispatch session start, task claim and compaction; executors session start and task claim at small budgets plus per-tool on governance-bearing paths; reviewers task claim only; haiku relays session start only. Validate the file. Defaults change only through a decision record backed by the cache-versus-JIT report, asymmetric as in RFC-0050 Part B: adding a moment or raising a budget needs evidence, removing or lowering is automatic.

Sequencing: depends on AISDLC-779, AISDLC-780 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A schema validates `.ai-sdlc/context-profiles.yaml` and rejects an unknown moment, a negative budget or a floor outside 0 to 1 (test per case).
- [ ] The shipped defaults match the OQ-8 role table (test per role).
- [ ] Role is the primary key; a model alias entry overrides only the fields it names (test).
- [ ] A profile cannot disable or alter any governance control: a test asserts the fixed prefix is rendered identically under every profile.
- [ ] A change that adds a moment or raises a budget is refused without a decision-record id and a change that removes a moment or lowers a budget is accepted (test).
- [ ] The hooks from the surfacing task read the active profile for moment, budget and floor (test).
