---
id: AISDLC-178.2
title: >-
  Phase 2: Data sources — events.jsonl tail, gh PR cache, dep-snapshot reader,
  cli-status poller, backlog file walker
status: Done
assignee: []
created_date: '2026-05-04 02:02'
labels:
  - rfc-0023
  - phase-2
  - data-sources
dependencies:
  - AISDLC-178.1
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - pipeline-cli/src/orchestrator/events.ts
  - pipeline-cli/src/cli/orchestrator.ts
  - pipeline-cli/src/deps/
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0023 implementation (RFC §13 Phase 2, ~1 week).

Wires the TUI's data sources per RFC §6.2 table. All polling-based per OQ-6 resolution (filesystem watch deferred to v2). Each source has its own client module under `pipeline-cli/src/tui/sources/` so phases 3-6 can consume them as React hooks.

Polling cadences (RFC §6.2):
- cli-orchestrator status: 10s
- events.jsonl tail: 5s
- gh pr list: 60s
- gh issue view: 60s
- backlog/tasks/ walk: 30s
- _deps/snapshot.*.jsonl: on-demand only
- .ai-sdlc/*.yaml: on-edit only

Manual refresh via `r` keystroke is the escape hatch for "I want to see X now."
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipeline-cli/src/tui/sources/events-tail.ts implements rolling tail of events-YYYY-MM-DD.jsonl (5s cadence)
- [x] #2 pipeline-cli/src/tui/sources/gh-pr-cache.ts wraps `gh pr list --json` with 60s TTL cache + invalidation on `r` keystroke
- [x] #3 pipeline-cli/src/tui/sources/dep-snapshot-reader.ts reads $ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl on-demand
- [x] #4 pipeline-cli/src/tui/sources/orchestrator-status.ts polls `cli-orchestrator status` every 10s
- [x] #5 pipeline-cli/src/tui/sources/backlog-walker.ts walks backlog/tasks/ + backlog/completed/ every 30s
- [x] #6 Each source exposes a React hook (useEvents, useGhPrs, useDepSnapshot, useOrchestratorStatus, useBacklogTasks) for downstream pane consumption
- [x] #7 Graceful degradation per RFC §12: missing data source surfaces banner instead of crashing pane
- [x] #8 Unit tests cover: cache TTL behavior, polling lifecycle, error-handling for missing/corrupt files
- [x] #9 New code reaches 80%+ patch coverage
<!-- AC:END -->
