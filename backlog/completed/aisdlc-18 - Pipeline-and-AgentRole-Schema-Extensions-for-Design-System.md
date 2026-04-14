---
id: AISDLC-18
title: Pipeline and AgentRole Schema Extensions for Design System
status: Done
assignee: []
created_date: '2026-04-13 22:54'
updated_date: '2026-04-13 23:29'
labels:
  - pipeline
  - agent-role
  - schema
  - M4
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - spec/schemas/pipeline.schema.json
  - spec/schemas/agent-role.schema.json
  - reference/src/core/types.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend Pipeline and AgentRole JSON schemas and TypeScript types for design system features.

Pipeline extensions:
- Add design-system and design-review to allowed stage type values
- Add design-token.changed and design-token.deleted as trigger events
- Add designSystem to providers
- Add context, condition, and constraints fields to Stage schema
- Add routing.complexityBased with designReview field

AgentRole extensions:
- Add designSystem block: binding (string ref), contextStrategy (manifest-first|tokens-only|full), contextStrategyOverride (auto|fixed), componentCreationPolicy (compose-or-justify|compose-only|unrestricted)
- Add requireStory and requireTokenUsage to constraints
- Add design-specific handoff output schemas (component, story, token-usage-report)

Update TypeScript Stage and AgentRoleSpec interfaces accordingly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pipeline schema validates the full worked example from RFC §6.1
- [x] #2 AgentRole schema validates the example from RFC §7.1
- [x] #3 TypeScript Stage interface extended with type, context, condition, constraints
- [x] #4 TypeScript AgentRoleSpec interface extended with designSystem block
- [x] #5 Context strategy selection types defined
- [x] #6 All existing validation tests pass
<!-- AC:END -->
