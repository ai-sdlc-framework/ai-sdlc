---
id: AISDLC-17
title: State Store Migration V10 — Design System Tables
status: Done
assignee: []
created_date: '2026-04-13 22:54'
updated_date: '2026-04-13 23:26'
labels:
  - state-store
  - database
  - M4
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - orchestrator/src/state/schema.ts
  - orchestrator/src/state/types.ts
  - orchestrator/src/state/store.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add MIGRATION_V10 to the state store schema, bump CURRENT_SCHEMA_VERSION to 10.

New tables:
- design_token_events (id, binding_name, event_type [changed/deleted/breaking], tokens_affected, diff_json, actor, pipeline_run_id, design_review_decision, created_at)
- design_review_events (id, binding_name, pr_number, component_name, reviewer, decision [approved/rejected/approved-with-comments], categories_json, actionable_notes, created_at)
- token_compliance_history (id, binding_name, coverage_percent, violations_count, scanned_at)
- visual_regression_results (id, binding_name, story_name, viewport, diff_percentage, approved, approver, baseline_url, current_url, created_at)
- usability_simulation_results (id, binding_name, story_name, persona_id, task_id, completed, actions_taken, expected_actions, efficiency, findings_json, created_at)

Add corresponding TypeScript record types in state/types.ts. Add store methods for insert and query operations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Migration V10 SQL creates all five tables with appropriate indices
- [x] #2 CURRENT_SCHEMA_VERSION = 10
- [x] #3 TypeScript record types for all five tables
- [x] #4 Store methods: insert and query for each table
- [x] #5 Migration applies cleanly on top of existing V9 database
- [x] #6 Unit tests for insert and query operations
<!-- AC:END -->
