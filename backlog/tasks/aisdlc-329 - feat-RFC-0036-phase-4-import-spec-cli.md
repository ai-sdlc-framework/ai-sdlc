---
id: AISDLC-329
title: 'feat: RFC-0036 Phase 4 — `ai-sdlc import-spec --from <path>` CLI (no reconcile yet)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-4
dependencies:
  - AISDLC-328
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0036 §13. Initial import CLI that translates spec-kit `tasks.md` into backlog tasks with `specRef:` back-references.

## Scope

- `ai-sdlc import-spec --from <path>` CLI + `/ai-sdlc import-spec --from <path>` slash command (OQ-12 dual-surface).
- Read spec-kit `tasks.md` only (per OQ-1: no fallback to spec.md).
- For each task entry: create backlog task with `specRef:` pointing back to the spec-kit `tasks.md` row.
- Schema versioning: auto-detect spec-kit version; refuse unknown (per OQ-11).
- Read `.ai-sdlc/adopter-authoring.yaml` for config; default `artifactGranularity: tasks-md-only`.
- **No reconcile yet** — drift handling is Phase 6.
- **No DoR yet** — DoR-at-import is Phase 5.
- Missing `tasks.md` → emit `Decision: incomplete-spec-detected` via Decision Catalog stub (full catalog wires in RFC-0035 Phase 1; for v1 of this task, log to events.jsonl and emit upstream clarification task).
- Unknown schema → emit `Decision: upstream-schema-unknown` (same routing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc import-spec --from <path>` CLI + slash command ship
- [ ] #2 Reads `tasks.md` only; missing file emits `Decision: incomplete-spec-detected` + upstream clarification task
- [ ] #3 Schema auto-detect; unknown emits `Decision: upstream-schema-unknown` + upgrade-framework task
- [ ] #4 Each imported task carries `specRef:` back-reference
- [ ] #5 Reads `adopter-authoring.yaml import.*` config
- [ ] #6 No reconcile / drift handling (Phase 6 scope)
- [ ] #7 Integration test: full spec-kit project → import → backlog tasks created with correct specRefs
<!-- AC:END -->
