---
id: AISDLC-305
title: 'feat: RFC-0025 Refit Phase 4 — Suggest-only attribution + quality-monitoring.yaml schema (OQ-2 + OQ-4)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-4
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 4. Implements the OQ-2-affirmed YAML+CLI config surface and the OQ-4-affirmed per-org-configurable suggest-only attribution.

## Scope (OQ-2 config surface)

- Ship `.ai-sdlc/quality-monitoring.yaml` schema per §13.1.
- Severity-weights override per-axis (`operator-time-cost`, `framework-recurrence`, `blast-radius`).
- One-shot CLI override via `--severity-weight axis=value` flag on relevant CLIs.
- `ai-sdlc init` template seeds the YAML with documented defaults.

## Scope (OQ-4 suggest-only attribution)

- Default behavior: framework-bug captures surface top-3 CODEOWNERS candidates in TUI + Slack DM; operator confirms.
- Per-org opt-in to auto-attribute via `quality.framework-bug.autoAttribute: true`.
- `attributionSources` extensible (`codeowners` shipping; `git-blame`, `recent-pr` are v2 extensions).
- `suggestionCount` configurable (default 3).
- LinkedIn-postmortem owner-blame anti-pattern explicitly avoided.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.ai-sdlc/quality-monitoring.yaml` schema ships per §13.1
- [ ] #2 `ai-sdlc init` template seeds documented defaults
- [ ] #3 Severity-weights per-axis overridable via YAML + CLI flag
- [ ] #4 Default attribution = suggest top-3 CODEOWNERS candidates (no force-assign)
- [ ] #5 `autoAttribute: true` per-org override force-assigns
- [ ] #6 TUI + Slack DM surfaces show suggested candidates with operator-confirm affordance
- [ ] #7 Test coverage for default + overridden attribution paths
<!-- AC:END -->
