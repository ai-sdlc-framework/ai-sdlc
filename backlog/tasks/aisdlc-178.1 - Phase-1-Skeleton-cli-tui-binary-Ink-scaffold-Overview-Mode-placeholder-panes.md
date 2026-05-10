---
id: AISDLC-178.1
title: >-
  Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder
  panes
status: To Do
assignee: []
created_date: '2026-05-04 02:02'
labels:
  - rfc-0023
  - phase-1
  - skeleton
dependencies: []
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - pipeline-cli/
  - pipeline-cli/package.json
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0023 implementation (RFC §13 Phase 1, ~3-5 days).

Foundational scaffold that all subsequent phases build on. Ships the binary, the Ink-based render loop, and the Overview Mode pane skeleton with placeholder content. No real data sources yet — Phase 2 wires those in.

Per RFC OQ-1 resolution: Ink (React-for-CLI, ESM). Component model matches the §7 pane layout.

Per RFC §6.3: TUI lives in `pipeline-cli/src/tui/` with binary at `pipeline-cli/bin/cli-tui.mjs`. Same package as the orchestrator (shares types, builds + ships in same npm publish cycle).

Per RFC §14: gated behind `AI_SDLC_TUI=experimental` feature flag — when unset, `cli-tui` exits with "not enabled" message + pointer to promotion runbook.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/bin/cli-tui.mjs binary exists, registered in pipeline-cli/package.json bin field
- [ ] #2 Ink dependency added to pipeline-cli/package.json (latest stable)
- [ ] #3 Feature flag AI_SDLC_TUI=experimental gates startup; unset → exits with 'not enabled' message
- [ ] #4 Overview Mode renders with 5 placeholder panes (Blockers top-left, PRs top-right, Critical Path bottom-left, Analytics bottom-right, Events full-width bottom) per RFC §7 layout
- [ ] #5 Footer renders mode keys [b] [p] [d] [c] [a] [/] [q] [r] [?]
- [ ] #6 Ctrl+C exits cleanly
- [ ] #7 q keystroke exits cleanly
- [ ] #8 Empty-state copy uses '✓ No decisions pending — pipeline self-driving' per OQ-9 resolution
- [ ] #9 Unit tests cover: feature-flag gate, exit handlers, pane rendering smoke test (Ink testing utilities)
- [ ] #10 New code reaches 80%+ patch coverage
<!-- AC:END -->
