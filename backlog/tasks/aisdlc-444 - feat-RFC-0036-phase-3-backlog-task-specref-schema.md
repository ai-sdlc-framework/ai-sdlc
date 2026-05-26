---
id: AISDLC-444
title: 'feat: RFC-0036 Phase 3 — backlog task schema: `specRef` field + JSON Schema update'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-3
  - schema
dependencies: []
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0036 §13. Optional `specRef` field on backlog tasks so imported tasks can trace back to their spec-kit `tasks.md` origin.

## Scope

- Add optional `specRef:` field to backlog task frontmatter schema (e.g., `specRef: .specify/specs/<feature>/tasks.md#<task-id>`).
- Update `spec/schemas/backlog-task.v1.schema.json` to validate the new field.
- Backward-compatible: omitted `specRef` is fine for native backlog tasks.
- Drift gate respects `specRef` (file existence check; not strict semantic validation).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `specRef:` field added to backlog task frontmatter schema (optional)
- [ ] #2 JSON Schema updated; validator accepts both present + absent
- [ ] #3 Drift gate file-existence check for `specRef` (info-level on missing)
- [ ] #4 Backward-compat: existing tasks without `specRef` validate cleanly
- [ ] #5 Tests cover schema validation (present, absent, malformed)
<!-- AC:END -->
