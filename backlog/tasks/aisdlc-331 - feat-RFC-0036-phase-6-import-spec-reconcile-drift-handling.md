---
id: AISDLC-331
title: 'feat: RFC-0036 Phase 6 — `ai-sdlc import-spec --reconcile` for drift handling (catalog-routed)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-6
dependencies:
  - AISDLC-329
  - AISDLC-289
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0036 §13. Drift handling for in-progress imported tasks when upstream `tasks.md` changes. Catalog-routed per OQ-2 + RFC-0035 G0 non-blocking contract.

## Scope (OQ-2)

- `ai-sdlc import-spec --reconcile [--task <id>]` detects drift between in-progress task and current upstream `tasks.md`.
- Drift detected → `Decision: spec-drift-detected` → Stage A classifies severity (typo / cosmetic / semantic / scope).
- **Low-severity** (typo/cosmetic): catalog auto-syncs the change to the task body; logs decision; no operator interrupt.
- **High-severity** (semantic/scope): catalog auto-defers with 24h override window; operator-surfaced in next batch review.
- Default-on-silence at 24h expiry: no-fork (task continues against dispatched version).
- **In-progress task NEVER halts** — it continues against the version it was dispatched with until the operator decides.
- Composes with RFC-0035 Phase 5 (AISDLC-289) shared classifier substrate for severity classification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc import-spec --reconcile` detects drift between in-progress task + upstream
- [ ] #2 Drift severity classified via RFC-0035 Stage A (typo / cosmetic / semantic / scope)
- [ ] #3 Low-severity drift auto-syncs without operator interrupt
- [ ] #4 High-severity drift auto-defers with 24h override window per RFC-0024 §15.1
- [ ] #5 In-progress task NEVER halts; continues against dispatched-version contract
- [ ] #6 Default-on-silence at 24h expiry = no-fork
- [ ] #7 Reads `adopter-authoring.yaml drift-handling.severityThresholds` config
- [ ] #8 Integration test: each severity tier produces correct routing behavior
<!-- AC:END -->
