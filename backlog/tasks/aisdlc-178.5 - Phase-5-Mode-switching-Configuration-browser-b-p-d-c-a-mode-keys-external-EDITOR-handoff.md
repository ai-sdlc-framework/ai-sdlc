---
id: AISDLC-178.5
title: >-
  Phase 5: Mode switching + Configuration browser — b/p/d/c/a mode keys +
  external $EDITOR handoff
status: To Do
assignee: []
created_date: '2026-05-04 02:03'
labels:
  - rfc-0023
  - phase-5
  - mode-switching
  - config
dependencies:
  - AISDLC-178.2
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - reference/
  - .ai-sdlc/
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0023 implementation (RFC §13 Phase 5, ~4-5 days).

Wires mode-switching keystrokes from RFC §7.6 + ships the Configuration browser per RFC §9.

Mode keys:
- `b` — Blockers full-screen (zooms Phase 3's pane)
- `p` — PRs full-screen (zooms Phase 4's PR pane)
- `d` — Dependency graph full-screen (ASCII tree of full dep graph from snapshot)
- `c` — Configuration browser (`.ai-sdlc/*.yaml`, syntax-highlighted, validation errors highlighted; `e` launches $EDITOR)
- `a` — Analytics full-screen (zooms Phase 6's pane; placeholder until Phase 6 ships)
- `/` — Search across all panes
- `r` — Refresh all data sources
- `?` — Help screen
- `q` — Quit

Per OQ-2 resolution: external $EDITOR handoff for config edits. TUI lists YAML files, selecting shows syntax-highlighted with validation errors annotated, `e` launches $EDITOR, on exit re-validates via @ai-sdlc/reference validator.

Per OQ-5 resolution: backlog.md kanban link-out via `gh browse` / `open` from any task row.

Parallelizable with Phases 3 + 4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/src/tui/modes/router.tsx handles all 9 mode keys (b/p/d/c/a/slash/r/?/q)
- [ ] #2 Mode keys swap the active pane to full-screen; Esc returns to Overview Mode
- [ ] #3 Help screen (?) lists every keystroke with description, sourced from a single keymap config (no drift between footer + help)
- [ ] #4 Configuration browser lists every YAML file under .ai-sdlc/ with status icon (valid/invalid)
- [ ] #5 Selecting a config file shows it syntax-highlighted (yaml-parser based); validation errors annotated inline with line numbers
- [ ] #6 `e` keystroke launches $EDITOR on the selected file; on editor exit, re-validates and surfaces errors before saving
- [ ] #7 Operator can override empty-state copy via .ai-sdlc/tui-config.yaml per OQ-9 resolution
- [ ] #8 `b` keystroke on a task row launches backlog.md kanban URL via gh browse / open / xdg-open / pbcopy fallback per OQ-5 resolution
- [ ] #9 Search (/) filters the current pane's items by substring match
- [ ] #10 Refresh (r) invalidates all source caches and re-polls
- [ ] #11 Unit tests cover: keymap routing, editor handoff lifecycle, validation re-run on save, fallback chain for browser launch
- [ ] #12 New code reaches 80%+ patch coverage
<!-- AC:END -->
